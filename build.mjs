import Parser from 'rss-parser';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MODEL = 'claude-haiku-4-5';
const PICK = 6;
const MAX_CANDIDATES = 45;
const FRESH_HOURS = 36;
const INDEX_DAYS = 21;

const FEEDS = [
  'https://news.google.com/rss/headlines/section/topic/WORLD?hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ru&gl=RU&ceid=RU:ru',
  'https://news.google.com/rss/search?q=%D0%BF%D0%BE%D0%BB%D0%B8%D1%82%D0%B8%D0%BA%D0%B0&hl=ru&gl=RU&ceid=RU:ru',
  'https://feeds.bbci.co.uk/russian/rss.xml',
];

const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'svodka-bot/1.0' } });

function sourceFromItem(item){
  if (item.source && typeof item.source === 'object' && item.source._) return item.source._;
  if (item.source && typeof item.source === 'string') return item.source;
  const m = (item.title || '').match(/\s-\s([^-]{2,40})$/);
  return m ? m[1].trim() : '';
}
function cleanTitle(t){ return (t||'').replace(/\s-\s[^-]{2,40}$/,'').trim(); }
function normKey(t){
  return cleanTitle(t).toLowerCase().replace(/[«»"'`.,:;!?()\[\]—–-]/g,' ')
    .replace(/\s+/g,' ').trim().split(' ').slice(0,6).join(' ');
}
function makeId(title, dateStr){
  const h = createHash('sha1').update(normKey(title)).digest('hex').slice(0,6);
  return 'e' + dateStr.replace(/-/g,'') + '-' + h;
}
function ageRu(iso){
  if(!iso) return 'сегодня';
  const diff = Date.now() - Date.parse(iso);
  if(Number.isNaN(diff)) return 'сегодня';
  const h = Math.floor(diff/3600000);
  if(h<1) return 'только что';
  if(h<24) return `${h} ч назад`;
  return 'сегодня';
}
async function readJson(path, fallback){
  try { return JSON.parse(await readFile(path,'utf8')); } catch { return fallback; }
}
function extractJson(text){
  let t=(text||'').trim().replace(/```json/gi,'').replace(/```/g,'').trim();
  const a=t.indexOf('['), b=t.lastIndexOf(']');
  if(a!==-1&&b!==-1&&b>a) t=t.slice(a,b+1);
  return JSON.parse(t);
}

async function collect(){
  const cutoff = Date.now() - FRESH_HOURS*3600*1000;
  const seen = new Set();
  const items = [];
  for(const url of FEEDS){
    try{
      const feed = await parser.parseURL(url);
      for(const it of feed.items||[]){
        const when = it.isoDate ? Date.parse(it.isoDate) : NaN;
        if(!Number.isNaN(when) && when < cutoff) continue;
        const key = normKey(it.title);
        if(!key || seen.has(key)) continue;
        seen.add(key);
        items.push({
          title: cleanTitle(it.title),
          source: sourceFromItem(it) || 'источник',
          snippet: (it.contentSnippet||'').replace(/\s+/g,' ').slice(0,220),
          iso: it.isoDate || '',
        });
      }
    }catch(e){ console.error('Лента недоступна:', url, '—', e.message); }
  }
  items.sort((a,b)=>(Date.parse(b.iso)||0)-(Date.parse(a.iso)||0));
  return items.slice(0, MAX_CANDIDATES);
}

async function summarize(candidates, index){
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) throw new Error('Нет ANTHROPIC_API_KEY. Добавьте его в секреты репозитория.');

  const list = candidates
    .map((c,i)=>`${i+1}. [${c.source}] ${c.title}${c.snippet?' — '+c.snippet:''}`).join('\n');

  const past = index.slice(-60)
    .map(e=>`${e.id} | ${e.date} | ${e.title}`).join('\n') || '(пусто)';

  const prompt =
    'Ты — редактор утренней новостной сводки. Ниже СПИСОК свежих заголовков из RSS за сутки и ИНДЕКС прошлых событий.\n\n' +
    'Задача 1 — отбор. Выбери ' + PICK + ' действительно самых важных мировых и политических событий: ' +
    'большая политика, международные отношения, конфликты, крупная экономика. В приоритете то, что широко освещается. ' +
    'Игнорируй развлечения, спорт, светскую хронику и мелочи.\n\n' +
    'Задача 2 — связи. Для каждого выбранного события реши, является ли оно ПРЯМЫМ продолжением, реакцией или ' +
    'следствием одного из событий ИНДЕКСА. Связывай ТОЛЬКО при реальном продолжении сюжета (те же действующие лица и линия), ' +
    'а не просто при совпадении темы. Если связи нет — ставь null. Никогда не выдумывай id, которого нет в индексе.\n\n' +
    'Для каждого события верни объект:\n' +
    '"title" — краткий заголовок (до 9 слов, без точки в конце),\n' +
    '"summary" — РОВНО одно предложение: что случилось и почему важно,\n' +
    '"category" — одно из: Мир, Политика, Экономика, Конфликты,\n' +
    '"source" — издание из списка,\n' +
    '"prev_id" — точный id из индекса или null,\n' +
    '"relation" — если есть связь: одно слово (продолжение / реакция / следствие), иначе null.\n\n' +
    'Все тексты на русском. Ответь ТОЛЬКО валидным JSON-массивом из ' + PICK + ' объектов, без markdown и пояснений.\n\n' +
    'ИНДЕКС ПРОШЛЫХ СОБЫТИЙ:\n' + past + '\n\nСПИСОК:\n' + list;

  const res = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{ 'x-api-key':key, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify({ model:MODEL, max_tokens:1800, messages:[{role:'user',content:prompt}] }),
  });
  if(!res.ok){
    const body = await res.text().catch(()=>'');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0,300)}`);
  }
  const data = await res.json();
  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const picked = extractJson(text);
  if(!Array.isArray(picked)||!picked.length) throw new Error('Модель вернула пустой результат.');
  return picked.filter(p=>p&&p.title&&p.summary);
}

async function main(){
  const dateStr = new Date().toISOString().slice(0,10);

  const candidates = await collect();
  console.log(`Кандидатов после дедупликации: ${candidates.length}`);
  if(!candidates.length) throw new Error('RSS не дал свежих новостей. Прерываюсь, чтобы не затирать сводку.');

  const index = await readJson('index.json', []);
  const indexById = new Map(index.map(e=>[e.id,e]));

  const picked = await summarize(candidates, index);

  const items = picked.map(p=>{
    const id = makeId(p.title, dateStr);
    let prev = null;
    if(p.prev_id && indexById.has(p.prev_id)){
      const pe = indexById.get(p.prev_id);
      prev = { id: pe.id, title: pe.title, date: pe.date, relation: (p.relation||'продолжение') };
    }
    const match = candidates.find(c=>normKey(c.title)===normKey(p.title));
    return {
      id,
      title: String(p.title),
      summary: String(p.summary),
      category: String(p.category||'Мир'),
      source: String(p.source || (match?match.source:'источники')),
      time_ago: match ? ageRu(match.iso) : 'сегодня',
      prev,
    };
  });

  const snapshot = { updated: new Date().toISOString(), date: dateStr, items };

  await writeFile('svodka.json', JSON.stringify(snapshot, null, 2), 'utf8');

  await mkdir('archive', { recursive: true });
  await writeFile(`archive/${dateStr}.json`, JSON.stringify(snapshot, null, 2), 'utf8');

  const dates = await readJson('archive/list.json', []);
  if(!dates.includes(dateStr)) dates.push(dateStr);
  dates.sort().reverse();
  await writeFile('archive/list.json', JSON.stringify(dates, null, 2), 'utf8');

  const cutoffDay = new Date(Date.now() - INDEX_DAYS*86400000).toISOString().slice(0,10);
  const merged = new Map(index.map(e=>[e.id,e]));
  for(const it of items) merged.set(it.id, { id:it.id, title:it.title, date:dateStr, category:it.category });
  const nextIndex = [...merged.values()].filter(e=>e.date >= cutoffDay)
    .sort((a,b)=> a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  await writeFile('index.json', JSON.stringify(nextIndex, null, 2), 'utf8');

  const linked = items.filter(i=>i.prev).length;
  console.log(`Готово: ${items.length} новостей (${linked} со связями) за ${dateStr}.`);
}

main().catch(err=>{
  console.error('Сборка не удалась:', err.message);
  process.exit(1);
});
