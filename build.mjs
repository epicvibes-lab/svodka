// Сборщик сводки: RSS -> дедупликация -> отбор главного через Claude Haiku -> архив svodka.json
//
// Отличие от прежней версии: svodka.json больше НЕ перезаписывается целиком.
// Это накопительный АРХИВ. При каждом запуске:
//   1. читаем RSS и убираем дубли внутри прогона;
//   2. выбрасываем новости, которые уже лежат в архиве (по ключу);
//   3. отдаём модели ТОЛЬКО свежие, ещё не виденные заголовки;
//   4. модель отбирает ВСЕ важные события по теме (без жёсткого лимита в 6 штук);
//   5. отобранное добавляется в начало архива, старое сохраняется.
//
// Запускается в GitHub Actions по расписанию. Требует переменную окружения ANTHROPIC_API_KEY.

import Parser from 'rss-parser';
import { writeFile, readFile } from 'node:fs/promises';

// ── Настройки ──────────────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5';   // самая дешёвая текущая модель ($1/$5 за млн токенов)
const ARCHIVE = 'svodka.json';      // файл-архив (его же читает дашборд)
const MAX_CANDIDATES = 60;          // верхний предел НОВЫХ кандидатов, отдаваемых модели за прогон
const FRESH_HOURS = 36;             // насколько свежими считать новости из RSS
const KEEP_DAYS = 30;               // сколько дней хранить новость в архиве (старое подчищается)
const MAX_ITEMS = 800;              // жёсткий потолок размера архива (защита от разрастания)

// Источники. Google News RSS на русском агрегирует множество изданий и сам
// частично группирует события. BBC — надёжная прямая лента. Можно добавлять свои.
const FEEDS = [
  'https://news.google.com/rss/headlines/section/topic/WORLD?hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=%D0%BF%D0%BE%D0%BB%D0%B8%D1%82%D0%B8%D0%BA%D0%B0&hl=ru&gl=RU&ceid=RU:ru',
  'https://feeds.bbci.co.uk/russian/rss.xml',
];

// ── Сбор RSS ────────────────────────────────────────────────────────────────
const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'svodka-bot/1.0' } });

function sourceFromItem(item) {
  // У Google News источник часто зашит в конце заголовка: "Заголовок - Издание"
  if (item.source && typeof item.source === 'object' && item.source._) return item.source._;
  if (item.source && typeof item.source === 'string') return item.source;
  const m = (item.title || '').match(/\s-\s([^-]{2,40})$/);
  return m ? m[1].trim() : '';
}

function cleanTitle(title) {
  return (title || '').replace(/\s-\s[^-]{2,40}$/, '').trim();
}

// Нормализованный ключ для дедупликации. Это же значение хранится в архиве,
// чтобы при следующих запусках можно было отсеять уже виденные новости.
function normKey(title) {
  return cleanTitle(title)
    .toLowerCase()
    .replace(/[«»"'`.,:;!?()\[\]—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

async function collect() {
  const cutoff = Date.now() - FRESH_HOURS * 3600 * 1000;
  const seen = new Set();
  const items = [];

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items || []) {
        const when = it.isoDate ? Date.parse(it.isoDate) : NaN;
        if (!Number.isNaN(when) && when < cutoff) continue;        // отсекаем несвежее
        const key = normKey(it.title);
        if (!key || seen.has(key)) continue;                       // дедупликация внутри прогона
        seen.add(key);
        items.push({
          key,
          title: cleanTitle(it.title),
          source: sourceFromItem(it) || 'источник',
          snippet: (it.contentSnippet || '').replace(/\s+/g, ' ').slice(0, 220),
          iso: it.isoDate || '',
        });
      }
    } catch (e) {
      console.error('Не удалось прочитать ленту:', url, '—', e.message);
    }
  }
  return items;
}

// ── Архив ────────────────────────────────────────────────────────────────────
async function loadArchive() {
  try {
    const raw = await readFile(ARCHIVE, 'utf8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data.items) ? data.items : [];
    // Бэкфилл для записей из старого формата (без key / added).
    const fallbackAdded = data.updated || new Date().toISOString();
    for (const it of items) {
      if (!it.key) it.key = normKey(it.title || '');
      if (!it.added) it.added = it.iso || fallbackAdded;
    }
    return items;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать архив, начинаю с пустого:', e.message);
    return []; // первого запуска ещё не было — это нормально
  }
}

// дата для сортировки/группировки: дата публикации, иначе момент добавления
function dateOf(it) {
  return it.iso || it.added || '';
}

function prune(items) {
  const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
  const fresh = items.filter(it => {
    const t = Date.parse(dateOf(it));
    return Number.isNaN(t) ? true : t >= cutoff; // без даты — оставляем
  });
  fresh.sort((a, b) => (Date.parse(dateOf(b)) || 0) - (Date.parse(dateOf(a)) || 0));
  return fresh.slice(0, MAX_ITEMS);
}

// ── Отбор и саммаризация через Claude ────────────────────────────────────────
function extractJson(text) {
  let t = (text || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

async function summarize(candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Нет ANTHROPIC_API_KEY. Добавьте его в секреты репозитория.');

  const list = candidates
    .map((c, i) => `${i + 1}. [${c.source}] ${c.title}${c.snippet ? ' — ' + c.snippet : ''}`)
    .join('\n');

  // Критерии важности оставлены прежними. Изменено только одно: не «ровно 6»,
  // а «все действительно важные» события из переданного (уже свежего) списка.
  const prompt =
    'Ты — редактор новостной ленты важных событий. Ниже список свежих заголовков из RSS, ' +
    'которых ещё не было в ленте раньше.\n' +
    'Отбери ВСЕ ДЕЙСТВИТЕЛЬНО важные мировые и политические события: большая политика, ' +
    'международные отношения, конфликты, крупная экономика. В приоритете события, которые встречаются ' +
    'в списке несколько раз или явно широко освещаются. Игнорируй развлечения, спорт, светскую хронику ' +
    'и мелочи. Не придумывай и не добавляй ничего, чего нет в списке. Если важных событий мало — верни мало; ' +
    'если их нет совсем — верни пустой массив [].\n' +
    'Для каждого выбранного события верни объект с полями:\n' +
    '"title" — краткий заголовок (до 9 слов, без точки в конце),\n' +
    '"summary" — РОВНО одно предложение: что именно случилось и почему это важно,\n' +
    '"category" — одно слово из набора: Мир, Политика, Экономика, Конфликты,\n' +
    '"source" — название издания из списка.\n' +
    'Все тексты на русском. Ответь ТОЛЬКО валидным JSON-массивом объектов, без markdown и пояснений.\n\n' +
    'СПИСОК:\n' + list;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const picked = extractJson(text);
  if (!Array.isArray(picked)) throw new Error('Модель вернула не массив.');

  const now = new Date().toISOString();
  // Сопоставляем выбранное с исходными кандидатами — берём оттуда дату и источник.
  return picked.filter(p => p && p.title && p.summary).map(p => {
    const match = candidates.find(c => c.key === normKey(p.title))
      || candidates.find(c => normKey(c.title) === normKey(p.title));
    return {
      key: normKey(p.title),
      title: String(p.title),
      summary: String(p.summary),
      category: String(p.category || 'Мир'),
      source: String(p.source || (match ? match.source : 'источники')),
      iso: match ? match.iso : '',   // дата публикации (для группировки/времени на дашборде)
      added: now,                    // когда новость попала в архив
    };
  });
}

// ── Главное ──────────────────────────────────────────────────────────────────
async function main() {
  const archive = await loadArchive();
  const archivedKeys = new Set(archive.map(it => it.key));
  console.log(`В архиве уже ${archive.length} новостей.`);

  const collected = await collect();
  console.log(`Свежих заголовков из RSS (после дедупликации внутри прогона): ${collected.length}`);

  // Оставляем только то, чего ещё нет в архиве.
  let candidates = collected.filter(c => !archivedKeys.has(c.key));
  candidates.sort((a, b) => (Date.parse(b.iso) || 0) - (Date.parse(a.iso) || 0));
  candidates = candidates.slice(0, MAX_CANDIDATES);
  console.log(`Новых (ещё не виденных) кандидатов для модели: ${candidates.length}`);

  if (!candidates.length) {
    console.log('Новых новостей нет — архив оставляю без изменений.');
    return; // ничего не пишем -> в Actions не будет лишнего коммита
  }

  const picked = await summarize(candidates);
  // Финальная защита от дублей: вдруг модель вернула что-то уже лежащее в архиве.
  const fresh = picked.filter(p => p.key && !archivedKeys.has(p.key));
  console.log(`Модель отобрала важных событий: ${picked.length}, из них новых: ${fresh.length}`);

  if (!fresh.length) {
    console.log('Среди свежих заголовков важного не нашлось — архив без изменений.');
    return;
  }

  const merged = prune([...fresh, ...archive]); // новое — в начало, затем чистка по возрасту/потолку
  const out = {
    updated: new Date().toISOString(),
    count: merged.length,
    items: merged,
  };
  await writeFile(ARCHIVE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Готово: добавлено ${fresh.length}, всего в архиве ${merged.length}.`);
}

main()
  .then(() => process.exit(0)) // явный выход: не ждём «висящие» сетевые сокеты rss-parser
  .catch(err => {
    console.error('Сборка не удалась:', err.message);
    process.exit(1); // ненулевой код -> Action подсветит ошибку, прошлый архив останется нетронутым
  });
