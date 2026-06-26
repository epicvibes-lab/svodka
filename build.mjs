// Сборщик сводки: RSS -> дедупликация -> отбор главного через Claude Haiku -> svodka.json
// Запускается в GitHub Actions по расписанию. Требует переменную окружения ANTHROPIC_API_KEY.

import Parser from 'rss-parser';
import { writeFile } from 'node:fs/promises';

// ── Настройки ──────────────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5';   // самая дешёвая текущая модель ($1/$5 за млн токенов)
const PICK = 6;                     // сколько новостей оставить в сводке
const MAX_CANDIDATES = 45;          // сколько кандидатов отдать модели на отбор
const FRESH_HOURS = 36;             // насколько свежими считать новости

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
        if (!key || seen.has(key)) continue;                       // дедупликация
        seen.add(key);
        items.push({
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

  // свежее — выше; берём верхушку как кандидатов для модели
  items.sort((a, b) => (Date.parse(b.iso) || 0) - (Date.parse(a.iso) || 0));
  return items.slice(0, MAX_CANDIDATES);
}

// ── Отбор и саммаризация через Claude ────────────────────────────────────────
function ageRu(iso) {
  if (!iso) return 'сегодня';
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return 'сегодня';
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'только что';
  if (h < 24) return `${h} ч назад`;
  return 'сегодня';
}

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

  const prompt =
    'Ты — редактор утренней новостной сводки. Ниже список заголовков из RSS за последние сутки.\n' +
    'Отбери ' + PICK + ' ДЕЙСТВИТЕЛЬНО самых важных мировых и политических событий: большая политика, ' +
    'международные отношения, конфликты, крупная экономика. В приоритете события, которые встречаются ' +
    'в списке несколько раз или явно широко освещаются. Игнорируй развлечения, спорт, светскую хронику и мелочи.\n' +
    'Для каждого выбранного события верни объект с полями:\n' +
    '"title" — краткий заголовок (до 9 слов, без точки в конце),\n' +
    '"summary" — РОВНО одно предложение: что именно случилось и почему это важно,\n' +
    '"category" — одно слово из набора: Мир, Политика, Экономика, Конфликты,\n' +
    '"source" — название издания из списка.\n' +
    'Все тексты на русском. Ответь ТОЛЬКО валидным JSON-массивом из ' + PICK + ' объектов, без markdown и пояснений.\n\n' +
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
      max_tokens: 1500,
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
  if (!Array.isArray(picked) || !picked.length) throw new Error('Модель вернула пустой результат.');

  // проставляем «N ч назад» по исходным датам, если найдём совпадение по заголовку
  return picked.filter(p => p && p.title && p.summary).map(p => {
    const match = candidates.find(c => normKey(c.title) === normKey(p.title));
    return {
      title: String(p.title),
      summary: String(p.summary),
      category: String(p.category || 'Мир'),
      source: String(p.source || (match ? match.source : 'источники')),
      time_ago: match ? ageRu(match.iso) : 'сегодня',
    };
  });
}

// ── Главное ──────────────────────────────────────────────────────────────────
async function main() {
  const candidates = await collect();
  console.log(`Кандидатов после дедупликации: ${candidates.length}`);
  if (!candidates.length) throw new Error('RSS не дал свежих новостей. Прерываюсь, чтобы не затирать прошлую сводку.');

  const items = await summarize(candidates);
  const out = { updated: new Date().toISOString(), items };
  await writeFile('svodka.json', JSON.stringify(out, null, 2), 'utf8');
  console.log(`Готово: записано ${items.length} новостей в svodka.json`);
}

main().catch(err => {
  console.error('Сборка не удалась:', err.message);
  process.exit(1); // ненулевой код -> Action подсветит ошибку, прошлый svodka.json останется
});
