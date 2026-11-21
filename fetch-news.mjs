// CHELSTREET 뉴스 수집기
// GitHub Actions가 10분마다 실행해요. 새 뉴스를 news.json에 저장하고 휴대폰(ntfy)으로 알림을 보내요.
import { readFile, writeFile } from "node:fs/promises";

// group: 사이트 필터 묶음 / chelseaOnly: true면 첼시 전용 피드라 전부 가져오고, false면 제목에 첼시가 있는 기사만 가져와요.
const UK = "영국 언론", KR = "한국 언론", FAN = "팬 블로그", OFF = "공식·FotMob";
const GN_EN = "https://news.google.com/rss/search?q=%22Chelsea%22+football+when:2d&hl=en-GB&gl=GB&ceid=GB:en";
const GN_OFF = "https://news.google.com/rss/search?q=site:chelseafc.com+when:7d&hl=en-GB&gl=GB&ceid=GB:en";
const GN_KO = "https://news.google.com/rss/search?q=%EC%B2%BC%EC%8B%9C+when:2d&hl=ko&gl=KR&ceid=KR:ko";
const FEEDS = [
  // 영국·해외 언론
  { source: "BBC Sport",        group: UK, chelseaOnly: true,  url: "https://feeds.bbci.co.uk/sport/football/teams/chelsea/rss.xml" },
  { source: "Sky Sports",       group: UK, chelseaOnly: false, url: "https://www.skysports.com/rss/11095" },
  { source: "talkSPORT",        group: UK, chelseaOnly: false, url: "https://talksport.com/football/feed/" },
  { source: "The Guardian",     group: UK, chelseaOnly: true,  url: "https://www.theguardian.com/football/chelsea/rss" },
  { source: "football.london",  group: UK, chelseaOnly: true,  url: "https://www.football.london/chelsea-fc/?service=rss" },
  { source: "Evening Standard", group: UK, chelseaOnly: false, url: "https://www.standard.co.uk/sport/football/rss" },
  { source: "The Sun",          group: UK, chelseaOnly: false, url: "https://www.thesun.co.uk/sport/football/feed/" },
  { source: "Mirror",           group: UK, chelseaOnly: false, url: "https://www.mirror.co.uk/sport/football/?service=rss" },
  { source: "Daily Mail",       group: UK, chelseaOnly: false, url: "https://www.dailymail.co.uk/sport/football/index.rss" },
  { source: "Telegraph",        group: UK, chelseaOnly: false, url: "https://www.telegraph.co.uk/football/rss.xml" },
  { source: "Independent",      group: UK, chelseaOnly: false, url: "https://www.independent.co.uk/sport/football/rss" },
  { source: "Express",          group: UK, chelseaOnly: false, url: "https://www.express.co.uk/posts/rss/78/football" },
  { source: "Sports Mole",      group: UK, chelseaOnly: true,  url: "https://www.sportsmole.co.uk/football/chelsea.xml" },
  { source: "CaughtOffside",    group: UK, chelseaOnly: false, url: "https://www.caughtoffside.com/feed/" },
  { source: "90min",            group: UK, chelseaOnly: false, url: "https://www.90min.com/posts.rss" },
  { source: "The Athletic",     group: UK, chelseaOnly: false, url: "https://www.nytimes.com/athletic/rss/football/" },
  { source: "구글뉴스(영어)",    group: UK, chelseaOnly: false, url: GN_EN, google: true },
  // 한국 언론
  { source: "인터풋볼",          group: KR, chelseaOnly: false, url: "https://www.interfootball.co.kr/rss/allArticle.xml" },
  { source: "풋볼리스트",        group: KR, chelseaOnly: false, url: "https://www.footballist.co.kr/rss/allArticle.xml" },
  { source: "베스트일레븐",      group: KR, chelseaOnly: false, url: "https://www.besteleven.com/rss/allArticle.xml" },
  { source: "구글뉴스(한국어)",  group: KR, chelseaOnly: false, url: GN_KO, google: true },
  // 팬 블로그 (루머가 섞여 있어요)
  { source: "Talk Chelsea",     group: FAN, chelseaOnly: true, url: "https://talkchelsea.net/feed" },
  { source: "Chelsea News",     group: FAN, chelseaOnly: true, url: "https://chelsea.news/feed" },
  { source: "The Chelsea Blog", group: FAN, chelseaOnly: true, url: "https://thechelseablog.com/feed" },
  { source: "Chelsea Supporters Trust", group: FAN, chelseaOnly: true, url: "https://chelseasupporterstrust.com/feed" },
  // 공식·FotMob (첼시 공식 홈페이지는 RSS가 없어서 구글 뉴스로 공식 사이트 기사만 골라 가져와요)
  { source: "첼시 공식",         group: OFF, chelseaOnly: true, url: GN_OFF, google: true, keepSource: true },
  { source: "FotMob",           group: OFF, chelseaOnly: true, url: "https://latest.fotmob.com/category/chelsea/feed/" },
];

const KEYWORDS = {
  "오피셜": ["official","confirmed","confirm","signs","signed","completes","completed","announce","unveil","extension","new contract","오피셜","공식 발표","공식발표","재계약","입단"],
  "부상": ["injury","injured","ruled out","sidelined","fitness","hamstring","knee","ankle","return date","surgery","부상","결장","수술","재활"],
  "이적": ["transfer","deal for","deal to","agree deal","agreed deal","bid","loan","talks","target","fee","move to","interest in","swap","이적","영입","임대","방출","here we go"],
  "인터뷰": ["interview","says","said","press conference","insists","admits","reveals","reacts","speaks","exclusive","인터뷰","기자회견","밝혔다","말했다","소감"],
  "프리뷰": ["preview","analysis","rating","stats","tactical","xg","predicted","lineup","key battle","what we learned","프리뷰","평점","분석","선발 예상","라인업"],
};
const ORDER = ["오피셜","부상","이적","인터뷰","프리뷰"];
const LABEL = { "프리뷰": "프리뷰/분석" };
const MAX_ITEMS = 300;
const MAX_ALERTS = 5;
const UA = { "User-Agent": "Mozilla/5.0 (CHELSTREET news bot)" };
const JUNK = /bet boost|betting|odds|acca|free bet|tips:|베팅|토토/i;
const HANGUL = /[가-힣]/;

function classify(title, source) {
  const t = " " + title.toLowerCase() + " ";
  for (const cat of ORDER) if (KEYWORDS[cat].some(k => t.includes(k))) return cat;
  return source === "FotMob" ? "프리뷰" : null;
}

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, "").trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

async function readFeed({ source, group, url, chelseaOnly, google, keepSource }) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const xml = await res.text();
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  if (!blocks.length) throw new Error("기사 목록 없음");
  const out = [];
  for (const block of blocks.slice(0, 80)) {
    let title = tag(block, "title");
    let link = tag(block, "link") || (block.match(/<link[^>]+href="([^"]+)"/i) || [])[1] || tag(block, "guid");
    if (!title || !link) continue;
    let src = source, grp = group;
    if (google) { // 구글뉴스는 제목 끝에 " - 매체명"이 붙어 있어서 매체명으로 바꿔요.
      const outlet = tag(block, "source");
      if (outlet) { if (!keepSource) src = outlet; title = title.replace(new RegExp(`\\s+-\\s+${outlet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""); }
    }
    if (/^chelsea f\.?c\.?$|chelseafc\.com/i.test(src)) { src = "첼시 공식"; grp = OFF; } // 공식 홈페이지 기사
    if (src === "첼시 공식") title = title.replace(/\s*\|\s*(news|official site|chelsea football club|chelsea fc)\b.*$/i, "");
    if (!chelseaOnly && !/chelsea|첼시/i.test(title)) continue;
    if (JUNK.test(title)) continue;
    const date = Date.parse(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated")) || Date.now();
    out.push({ title, link: decode(link).split("#")[0], source: src, group: grp, date });
  }
  return out;
}

// 무료 번역(MyMemory). 하루 사용량이 정해져 있어서 한 번에 조금씩만 번역하고, 실패하면 다음 실행 때 다시 해요.
const TRANSLATE_PER_RUN = 25;
const TRANSLATE_EMAIL = "jeonjc0602-del@users.noreply.github.com";
async function translate(text) {
  const url = "https://api.mymemory.translated.net/get?langpair=en|ko&de=" + encodeURIComponent(TRANSLATE_EMAIL) + "&q=" + encodeURIComponent(text);
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
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
      message: item.titleKo && item.titleKo !== item.title ? `${item.titleKo}\n${item.title}` : item.title,
      click: item.link,
      priority: item.cat === "오피셜" ? 5 : 3,
    }),
  }).catch(e => console.log("알림 실패:", e.message));
}

// 같은 기사가 여러 곳에서 올라오면 하나만 남기려고 제목을 단순하게 바꿔 비교해요.
const norm = t => t.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
const groupOf = s => (FEEDS.find(f => f.source === s) || {}).group || (s === "첼시 공식" ? OFF : UK);

let old = { items: [] };
try { old = JSON.parse(await readFile("news.json", "utf8")); } catch {}
// 키워드를 고치면 예전 기사도 새 기준으로 다시 분류해요.
old.items = old.items.filter(x => !JUNK.test(x.title))
  .map(x => {
    if (/^chelsea f\.?c\.?$|chelseafc\.com/i.test(x.source)) { x = { ...x, source: "첼시 공식", group: OFF, title: x.title.replace(/\s*\|\s*(news|official site|chelsea football club|chelsea fc)\b.*$/i, ""), titleKo: x.titleKo && x.titleKo.replace(/\s*\|\s*(뉴스|공식).*$/, "") }; }
    return { ...x, group: x.group || groupOf(x.source), cat: classify(x.title, x.source) || x.cat };
  });
const known = new Set(old.items.map(x => x.id));
const knownTitles = new Set(old.items.map(x => norm(x.title)));
const firstRun = old.items.length === 0;

const jobs = FEEDS.map(f => readFeed(f));
const names = FEEDS.map(f => f.source);
const results = await Promise.allSettled(jobs);
const stats = {};
let found = [];
results.forEach((r, i) => {
  if (r.status === "fulfilled") { stats[names[i]] = r.value.length; found.push(...r.value); }
  else stats[names[i]] = "실패: " + (r.reason?.message || "알 수 없음");
  console.log(`${names[i]}: ${stats[names[i]]}`);
});

const fresh = [];
for (const x of found) {
  const id = x.link, key = norm(x.title);
  if (known.has(id) || knownTitles.has(key)) continue;
  known.add(id); knownTitles.add(key);
  const item = { id, ...x, added: Date.now(), cat: classify(x.title, x.source) };
  if (HANGUL.test(x.title)) item.titleKo = x.title; // 한국어 기사는 번역 안 해요.
  fresh.push(item);
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

await writeFile("news.json", JSON.stringify({ updated: Date.now(), stats, items }, null, 1));
console.log(`새 뉴스 ${fresh.length}건`);

// 처음 실행할 때는 기존 기사가 한꺼번에 알림으로 오지 않게 저장만 해요.
// 알림은 키워드에 걸린 기사만 보내요. (전체 뉴스는 사이트에서만 보여요)
if (!firstRun) for (const x of fresh.filter(x => x.cat).slice(0, MAX_ALERTS)) await notify(x);
