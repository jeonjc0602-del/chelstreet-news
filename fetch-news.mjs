// CHELSTREET 뉴스 수집기
// GitHub Actions가 10분마다 실행해요. 새 뉴스를 news.json에 저장하고 휴대폰(ntfy)으로 알림을 보내요.
import { readFile, writeFile } from "node:fs/promises";

const FEEDS = [
  { source: "BBC Sport",  url: "https://feeds.bbci.co.uk/sport/football/teams/chelsea/rss.xml", chelseaOnly: true },
  { source: "Sky Sports", url: "https://www.skysports.com/rss/11095", chelseaOnly: false },
  { source: "talkSPORT",  url: "https://talksport.com/football/feed/", chelseaOnly: false },
  { source: "FotMob",     url: "https://latest.fotmob.com/category/chelsea/feed/", chelseaOnly: true },
];
const CHELSEA_SITE = "https://www.chelseafc.com/en/news/latest-news";

const KEYWORDS = {
  "오피셜": ["official","confirmed","confirm","signs","signed","completes","completed","announce","unveil","extension","new contract"],
  "부상": ["injury","injured","ruled out","sidelined","fitness","hamstring","knee","ankle","return date","surgery"],
  "이적": ["transfer","deal for","deal to","agree deal","agreed deal","bid","loan","talks","target","fee","move to","interest in","swap"],
  "인터뷰": ["interview","says","said","press conference","insists","admits","reveals","reacts","speaks","exclusive"],
  "프리뷰": ["preview","analysis","rating","stats","tactical","xg","predicted","lineup","key battle","what we learned"],
};
const ORDER = ["오피셜","부상","이적","인터뷰","프리뷰"];
const LABEL = { "프리뷰": "프리뷰/분석" };
const MAX_ITEMS = 200;
const MAX_ALERTS = 5;
const UA = { "User-Agent": "Mozilla/5.0 (CHELSTREET news bot)" };

function classify(title, source) {
  const t = " " + title.toLowerCase() + " ";
  for (const cat of ORDER) if (KEYWORDS[cat].some(k => t.includes(k))) return cat;
  return source === "FotMob" ? "프리뷰" : null;
}

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, "").trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

async function readFeed({ source, url, chelseaOnly }) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    const title = tag(block, "title");
    const link = tag(block, "link") || tag(block, "guid");
    if (!title || !link) continue;
    if (!chelseaOnly && !/chelsea/i.test(title)) continue;
    if (/bet boost|betting|odds|acca|free bet|tips:/i.test(title)) continue; // 베팅 광고 기사 빼기
    const date = Date.parse(tag(block, "pubDate")) || Date.now();
    out.push({ title, link: link.split("#")[0], source, date });
  }
  return out;
}

// 첼시 공식 홈페이지는 RSS가 없어서 뉴스 목록 페이지에서 기사 링크를 찾아요. 사이트가 바뀌면 이 부분만 고장 나고 나머지는 계속 돌아가요.
async function readChelseaSite() {
  const res = await fetch(CHELSEA_SITE, { headers: UA });
  if (!res.ok) throw new Error(`${res.status}`);
  const html = await res.text();
  const out = [], seen = new Set();
  const re = /<a[^>]+href="(\/en\/news\/article\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const link = "https://www.chelseafc.com" + m[1];
    if (seen.has(link)) continue;
    const text = decode(m[2]).replace(/\s+/g, " ");
    const title = text.length > 15 ? text : decode(m[1].split("/").pop().replace(/-/g, " "));
    seen.add(link);
    out.push({ title, link, source: "첼시 공식", date: Date.now() });
  }
  return out.slice(0, 30);
}

// 무료 번역(MyMemory). 하루 사용량이 정해져 있어서 한 번에 조금씩만 번역하고, 실패하면 다음 실행 때 다시 해요.
const TRANSLATE_PER_RUN = 20;
const TRANSLATE_EMAIL = "jeonjc0602-del@users.noreply.github.com";
async function translate(text) {
  const url = "https://api.mymemory.translated.net/get?langpair=en|ko&de=" + encodeURIComponent(TRANSLATE_EMAIL) + "&q=" + encodeURIComponent(text);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();
  const ko = decode(String(data?.responseData?.translatedText || ""));
  if (data.responseStatus != 200 || !ko || /MYMEMORY WARNING|QUERY LENGTH/i.test(ko)) throw new Error(ko || "번역 실패");
  return ko;
}

async function notify(item) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      title: `[${LABEL[item.cat] || item.cat}] ${item.source}`,
      message: item.titleKo ? `${item.titleKo}\n${item.title}` : item.title,
      click: item.link,
      priority: item.cat === "오피셜" ? 5 : 3,
    }),
  }).catch(e => console.log("알림 실패:", e.message));
}

let old = { items: [] };
try { old = JSON.parse(await readFile("news.json", "utf8")); } catch {}
// 키워드를 고치면 예전 기사도 새 기준으로 다시 분류해요.
old.items = old.items.filter(x => !/bet boost|betting|odds|acca|free bet|tips:/i.test(x.title)).map(x => ({ ...x, cat: classify(x.title, x.source) || x.cat }));
const known = new Set(old.items.map(x => x.id));
const firstRun = old.items.length === 0;

const jobs = [...FEEDS.map(f => readFeed(f).then(r => [f.source, r])), readChelseaSite().then(r => ["첼시 공식", r])];
const results = await Promise.allSettled(jobs);
let found = [];
results.forEach((r, i) => {
  const name = i < FEEDS.length ? FEEDS[i].source : "첼시 공식";
  if (r.status === "fulfilled") { console.log(`${name}: ${r.value[1].length}건`); found.push(...r.value[1]); }
  else console.log(`${name}: 가져오기 실패 (${r.reason?.message})`);
});

const fresh = [];
for (const x of found) {
  const id = x.link;
  if (known.has(id)) continue;
  const cat = classify(x.title, x.source);
  known.add(id);
  fresh.push({ id, ...x, cat });
}
fresh.sort((a, b) => b.date - a.date);

const items = [...fresh, ...old.items].sort((a, b) => b.date - a.date).slice(0, MAX_ITEMS);

// 아직 한국어 제목이 없는 최신 기사부터 번역해요.
let translated = 0;
for (const x of items.filter(x => !x.titleKo).slice(0, TRANSLATE_PER_RUN)) {
  try { x.titleKo = await translate(x.title); translated++; }
  catch (e) { console.log("번역 멈춤:", e.message); break; }
}
console.log(`번역 ${translated}건`);

await writeFile("news.json", JSON.stringify({ updated: Date.now(), items }, null, 1));
console.log(`새 뉴스 ${fresh.length}건`);

// 처음 실행할 때는 기존 기사가 한꺼번에 알림으로 오지 않게 저장만 해요.
// 알림은 키워드에 걸린 기사만 보내요. (전체 뉴스는 사이트에서만 보여요)
if (!firstRun) for (const x of fresh.filter(x => x.cat).slice(0, MAX_ALERTS)) await notify(x);
