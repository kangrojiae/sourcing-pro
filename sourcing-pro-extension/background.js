/* Sourcing Pro 수집기 — 백그라운드 서비스 워커.
   웹 페이지에서 온 수집 요청을 받아 대상 상품 페이지를 보이지 않는 탭으로 열고,
   콘텐츠 스크립트가 읽은 값과 축소한 썸네일을 돌려준 뒤 탭을 닫는다. */

const LOAD_TIMEOUT_MS = 30000;
const SCRAPE_RETRIES = 12;

/* 이미지 검색 대기 — 자주 확인하고 일찍 포기한다.
   예전에는 1.5초마다 확인하며 60초까지 기다려 화면이 오래 멈춰 있었다. */
const IMG_POLL_MS = 600;        /* 결과를 다시 확인하는 간격 */
const IMG_CLICK_WAIT_MS = 1100; /* 검색 버튼을 누른 뒤 기다리는 시간 */
const IMG_BUDGET_MS = 22000;    /* 여기까지 결과가 없으면 탭을 남기고 넘긴다 */
const THUMB_MAX_PX = 320;

/* 서비스 워커가 30초 유휴 후 잠들어 수집이 끊기는 것을 막는다 */
let keepAliveTimer = null;
let activeJobs = 0;
function holdAwake() {
  activeJobs++;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}
function releaseAwake() {
  activeJobs = Math.max(0, activeJobs - 1);
  if (activeJobs === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* =====================================================================
   같은 곳에 몰아서 요청하지 않는다.
   쿠팡은 짧은 시간에 요청이 몰리면 그 아이피의 접속을 한동안 막는다.
   ===================================================================== */
const lastHit = {};
async function polite(host, gapMs) {
  const prev = lastHit[host] || 0;
  const wait = prev + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit[host] = Date.now();
}
/* 검색 페이지를 여는 간격. 사람이 보는 속도에 가깝게, 매번 조금씩 다르게 둔다. */
function pageGap() {
  return 7000 + Math.floor(Math.random() * 6000);
}
/* 몇 번에 한 번은 길게 쉰다 */
let coupangHits = 0;
const LONG_REST_EVERY = 5;
const LONG_REST_MS = 20000;
const IMG_GAP_MS = 250;     /* 썸네일 한 장을 받는 간격 */

/* 한 번 받은 그림은 다시 받지 않는다 */
const thumbCache = new Map();
const THUMB_CACHE_MAX = 400;

/* 쿠팡이 막았을 때 한동안 더 두드리지 않는다 */
let coupangBlockedUntil = 0;
function coupangCooling() {
  const left = coupangBlockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
function markCoupangBlocked(minutes) {
  coupangBlockedUntil = Date.now() + (minutes || 5) * 60000;
}
/* 사용자가 쿠팡이 멀쩡한 것을 눈으로 확인했을 때 쉬는 시간을 푼다 */
function clearCoupangCooldown() {
  coupangBlockedUntil = 0;
  return { ok: true, data: { cleared: true } };
}

/* 차단 안내 화면인지 페이지 안에서 확인한다 */
function looksBlocked() {
  var t = (document.title || "") + " " + ((document.body && document.body.innerText) || "").slice(0, 2000);
  var marks = [
    "사용권한이 없습니다", "사용권한이 제한", "권한이 제한된 페이지",
    "일시적으로 접속이 제한", "접속이 제한", "접속이 차단", "비정상적인 접근",
    "Access Denied", "Request unsuccessful", "잠시 후 다시 시도",
    "Bot detected", "Are you a robot"
  ];
  for (var i = 0; i < marks.length; i++) {
    if (t.indexOf(marks[i]) >= 0) {
      return t.replace(/\s+/g, " ").trim().slice(0, 110);
    }
  }
  return "";
}
async function blockedText(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: looksBlocked });
    return (r && r[0] && r[0].result) || "";
  } catch (e) { return ""; }
}

/* 우리가 연 탭을 기억해 두었다가, 중간에 끊겨 남은 탭은 다음 작업 시작 때 정리한다.
   서비스 워커가 잠들었다 깨어나도 잃지 않도록 세션 저장소에도 남긴다. */
const openedTabs = new Set();
let tabsLoaded = false;

async function loadTracked() {
  if (tabsLoaded) return;
  tabsLoaded = true;
  try {
    const o = await chrome.storage.session.get("sp.tabs");
    (o["sp.tabs"] || []).forEach((id) => openedTabs.add(id));
  } catch (e) { /* 세션 저장소가 없으면 이번 실행 동안만 기억한다 */ }
}
async function saveTracked() {
  try { await chrome.storage.session.set({ "sp.tabs": Array.from(openedTabs) }); } catch (e) {}
}
async function openWorkTab(url, active) {
  await loadTracked();
  const tab = await chrome.tabs.create({ url, active: !!active });
  openedTabs.add(tab.id);
  await saveTracked();
  return tab;
}

/* 일하는 화면을 사람이 보던 창에 끼워 넣지 않는다.
   창을 따로 하나 띄우고 초점을 주지 않는다. 그러면
   사람 화면은 소싱 프로에 그대로 있고, 그 창은 계속 그려져서 크롬이 일을 늦추지 않는다.
   배경 탭으로 열면 크롬이 일을 늦춰 화면이 끝내 안 그려진다. 그래서 탭이 아니라 창을 쓴다. */
let sideWindowId = null;
let sideIdleTimer = null;
const SIDE_IDLE_MS = 100000;   /* 일이 끝나고 이만큼 조용하면 창을 닫는다 */

/* 옆창을 사람 눈에 최대한 안 띄는 자리에 놓는다.
   화면 밖으로 완전히 밀어내면 운영체제가 도로 끌어오므로,
   보고 있는 창 뒤 오른쪽 아래 구석에 겹쳐 둔다. 초점은 주지 않는다. */
async function sideSpot() {
  const fallback = { left: 60, top: 60, width: 1180, height: 900 };
  try {
    const cur = await chrome.windows.getCurrent();
    if (!cur || cur.width == null) return fallback;
    const w = Math.max(1000, Math.min(1280, cur.width - 60));
    const h = Math.max(760, Math.min(960, cur.height - 60));
    return {
      left: Math.max(0, (cur.left || 0) + (cur.width || w) - w - 8),
      top: Math.max(0, (cur.top || 0) + (cur.height || h) - h + 8),
      width: w,
      height: h
    };
  } catch (e) {
    return fallback;
  }
}

function keepSideAlive() {
  if (sideIdleTimer) clearTimeout(sideIdleTimer);
  sideIdleTimer = setTimeout(function () {
    sideIdleTimer = null;
    closeSideWindow();
  }, SIDE_IDLE_MS);
}

async function openSideTab(url) {
  await loadTracked();
  keepSideAlive();

  /* 이미 옆창이 있으면 그 창을 다시 쓴다. 창을 열고 닫기를 되풀이하면 화면이 깜빡인다. */
  if (sideWindowId != null) {
    try {
      const win = await chrome.windows.get(sideWindowId, { populate: true });
      const first = (win.tabs || [])[0];
      if (first) {
        await chrome.tabs.update(first.id, { url, active: true });
        openedTabs.add(first.id);
        await saveTracked();
        return { id: first.id, windowId: sideWindowId };
      }
    } catch (e) { sideWindowId = null; }
  }

  try {
    const spot = await sideSpot();
    const win = await chrome.windows.create({
      url: url,
      type: "normal",
      focused: false,
      width: spot.width,
      height: spot.height,
      left: spot.left,
      top: spot.top
    });
    sideWindowId = win.id;
    const tab = (win.tabs || [])[0];
    if (tab) {
      openedTabs.add(tab.id);
      await saveTracked();
      return { id: tab.id, windowId: win.id };
    }
  } catch (e) { /* 창을 못 만들면 아래에서 평소처럼 탭으로 연다 */ }

  /* 창을 못 만드는 환경이면 어쩔 수 없이 앞 탭으로 연다 */
  return await openWorkTab(url, true);
}

/* 일이 끝날 때마다 창을 닫지 않는다. 닫고 다시 열면 그때마다 깜빡이기 때문이다.
   빈 화면으로 돌려두고 잠시 두었다가, 더 쓰지 않으면 그때 닫는다. */
async function parkSideWindow() {
  if (sideWindowId == null) return;
  keepSideAlive();
  try {
    const win = await chrome.windows.get(sideWindowId, { populate: true });
    const first = (win.tabs || [])[0];
    if (first) {
      await chrome.tabs.update(first.id, { url: "about:blank" });
      /* 세워둔 탭은 더 이상 작업 탭으로 세지 않는다.
         다음 일을 시작할 때 정리 대상에 걸려 닫히면, 창이 또 깜빡이기 때문이다. */
      openedTabs.delete(first.id);
      await saveTracked();
    }
  } catch (e) { sideWindowId = null; }
}

async function closeSideWindow() {
  if (sideIdleTimer) { clearTimeout(sideIdleTimer); sideIdleTimer = null; }
  if (sideWindowId == null) return;
  const id = sideWindowId;
  sideWindowId = null;
  try { await chrome.windows.remove(id); } catch (e) { /* 이미 닫힘 */ }
}
async function closeWorkTab(tabId) {
  if (tabId == null) return;
  openedTabs.delete(tabId);
  await saveTracked();
  try { await chrome.tabs.remove(tabId); } catch (e) { /* 이미 닫힘 */ }
}
async function sweepTabs(keepId) {
  await loadTracked();
  let closed = 0;
  for (const id of Array.from(openedTabs)) {
    if (id === keepId) continue;
    openedTabs.delete(id);
    try { await chrome.tabs.remove(id); closed++; } catch (e) { /* 이미 닫힘 */ }
  }
  await saveTracked();
  return closed;
}
chrome.tabs.onRemoved.addListener((id) => {
  if (openedTabs.delete(id)) saveTracked();
});

/* 새 작업을 시작할 때, 앞서 끊겨 남은 작업 탭이 있으면 먼저 정리한다 */
async function beginJob() {
  if (activeJobs === 0) await sweepTabs();
  holdAwake();
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve(false);
        if (tab.status === "complete") return resolve(true);
        if (Date.now() - started > LOAD_TIMEOUT_MS) return resolve(false);
        setTimeout(check, 400);
      });
    };
    check();
  });
}

function askTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "scrape" }, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res || null);
    });
  });
}

/* 콘텐츠 스크립트가 아직 붙지 않았을 수 있어, 필요하면 직접 주입한다 */
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["scrape.js"] });
  } catch (e) {
    /* 이미 주입되어 있으면 무시 */
  }
}

/* 후보 주소를 앞에서부터 시도해 처음으로 제대로 된 그림이 나오면 그걸 쓴다 */
async function makeThumbFrom(candidates) {
  const list = (candidates || []).filter(Boolean).slice(0, 6);
  for (let i = 0; i < list.length; i++) {
    const out = await makeThumb(list[i]);
    if (out) return out;
  }
  return "";
}

async function makeThumb(url, maxPx) {
  if (!url) return "";
  const key = url + "|" + (maxPx || THUMB_MAX_PX);
  if (thumbCache.has(key)) return thumbCache.get(key);
  if (/coupang/i.test(url)) await polite("coupang-img", IMG_GAP_MS);

  /* 결과를 기억해 둔다. 같은 그림을 두 번 받지 않기 위해서다. */
  const keep = (val) => {
    if (thumbCache.size > THUMB_CACHE_MAX) thumbCache.clear();
    thumbCache.set(key, val);
    return val;
  };
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return keep("");
    const blob = await res.blob();
    if (blob.size < 500) return keep("");
    const bmp = await createImageBitmap(blob);
    /* 1x1 투명 이미지 같은 자리표시자는 버린다 */
    if (bmp.width < 60 || bmp.height < 60) return keep("");
    const scale = Math.min(1, (maxPx || THUMB_MAX_PX) / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return keep("data:image/jpeg;base64," + btoa(bin));
  } catch (e) {
    return keep("");
  }
}

async function collect(url) {
  if (/coupang\.com/i.test(String(url || ""))) {
    const cool = coupangCooling();
    if (cool) {
      return { ok: false, blocked: true,
        error: "쿠팡이 접속을 잠시 막아두었습니다. " + cool + "초쯤 뒤에 다시 시도해주세요." };
    }
    await polite("coupang-page", pageGap());
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "http 또는 https 주소만 수집할 수 있습니다." };
  }
  if (!/(coupang\.com|1688\.com)/i.test(url)) {
    return { ok: false, error: "쿠팡 또는 1688 상품 주소만 수집할 수 있습니다." };
  }

  await beginJob();
  let tabId = null;
  try {
    const tab = await openWorkTab(url, false);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "상품 페이지를 여는 데 실패했습니다." };

    await ensureInjected(tabId);

    let res = null;
    for (let i = 0; i < SCRAPE_RETRIES; i++) {
      res = await askTab(tabId);
      if (res) break;
      await sleep(900);
      if (i === 3) await ensureInjected(tabId);
    }
    if (!res || !res.ok) {
      const why = await blockedText(tabId);
      if (why && /coupang\.com/i.test(url)) {
        markCoupangBlocked(5);
        return { ok: false, blocked: true,
          error: "쿠팡이 접속을 막았습니다. 5분쯤 쉬었다가 다시 시도해주세요. (" + why + ")" };
      }
      if (!res) {
        return { ok: false, error: "페이지를 읽지 못했습니다. 로그인이나 보안 확인이 필요한지 확인해주세요." };
      }
      return res;
    }

    res.data.image = await makeThumbFrom(res.data.imageCandidates || [res.data.image]);
    delete res.data.imageCandidates;
    res.data.url = url;
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: "수집 중 오류가 발생했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    releaseAwake();
  }
}

/* 네이버 위안화 환율 상세 페이지 */
const FX_URL = "https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_CNYKRW";
const FX_CACHE_MS = 10 * 60 * 1000;
let fxCache = null;

async function fetchRate(force) {
  if (!force && fxCache && Date.now() - fxCache.at < FX_CACHE_MS) {
    return { ok: true, data: fxCache.data, cached: true };
  }
  await beginJob();
  let tabId = null;
  try {
    const tab = await openWorkTab(FX_URL, false);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "네이버 환율 페이지를 여는 데 실패했습니다." };

    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["fxscrape.js"] });
    } catch (e) { /* 이미 붙어 있으면 무시 */ }

    let res = null;
    for (let i = 0; i < 8; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "readFx" }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(700);
    }
    if (!res) return { ok: false, error: "네이버 환율 페이지를 읽지 못했습니다." };
    if (!res.ok) return res;

    fxCache = { at: Date.now(), data: res.data };
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: "환율을 가져오지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    releaseAwake();
  }
}

/* =====================================================================
   네이버 검색광고 키워드도구
   ===================================================================== */
const SEARCHAD_HOST = "https://api.searchad.naver.com";
const KEYWORD_PATH = "/keywordstool";

function creds() {
  return new Promise((resolve) => {
    chrome.storage.local.get("sp.searchad", (o) => resolve(o["sp.searchad"] || null));
  });
}

/* 검색광고 API 서명: HMAC-SHA256("{timestamp}.{method}.{path}") 를 base64 로 */
async function signRequest(secret, timestamp, method, path) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(timestamp + "." + method + "." + path));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* "< 10" 처럼 숫자가 아닌 값이 오므로 함께 처리한다 */
function qc(v) {
  if (typeof v === "number") return { n: v, low: false };
  const s = String(v == null ? "" : v).trim();
  if (/^<\s*\d+$/.test(s)) return { n: parseInt(s.replace(/\D/g, ""), 10) || 10, low: true };
  const n = parseInt(s.replace(/[^\d]/g, ""), 10);
  return { n: isNaN(n) ? 0 : n, low: false };
}

async function keywordTool(seed, debug) {
  const c = await creds();
  if (!c || !c.apiKey || !c.secret || !c.customer) {
    return { ok: false, error: "네이버 검색광고 API 키가 없습니다. 확장프로그램 설정에서 먼저 등록해주세요.", needsKey: true };
  }
  const hint = String(seed || "").split(",")
    .map((s) => s.replace(/\s+/g, "").trim())
    .filter(Boolean).slice(0, 5).join(",");
  if (!hint) return { ok: false, error: "키워드를 입력해주세요." };

  const ts = String(Date.now());
  let signature;
  try {
    signature = await signRequest(c.secret, ts, "GET", KEYWORD_PATH);
  } catch (e) {
    return { ok: false, error: "서명을 만들지 못했습니다: " + (e && e.message ? e.message : e) };
  }

  const url = SEARCHAD_HOST + KEYWORD_PATH + "?hintKeywords=" + encodeURIComponent(hint) + "&showDetail=1";
  let res, text;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Timestamp": ts,
        "X-API-KEY": c.apiKey,
        "X-Customer": String(c.customer),
        "X-Signature": signature
      }
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: "네이버 검색광고에 연결하지 못했습니다: " + (e && e.message ? e.message : e) };
  }

  if (!res.ok) {
    let hintMsg = "";
    if (res.status === 401 || res.status === 403) hintMsg = " 액세스라이선스, 비밀키, CUSTOMER_ID 를 다시 확인해주세요.";
    else if (res.status === 429) hintMsg = " 잠시 후 다시 시도해주세요.";
    return { ok: false, error: "검색광고 API 오류 " + res.status + "." + hintMsg, raw: text.slice(0, 2000) };
  }

  let json;
  try { json = JSON.parse(text); } catch (e) {
    return { ok: false, error: "응답을 해석하지 못했습니다.", raw: text.slice(0, 2000) };
  }

  const rows = json.keywordList || json.keywordslist || [];
  if (!Array.isArray(rows)) {
    return { ok: false, error: "응답에 키워드 목록이 없습니다.", raw: text.slice(0, 2000) };
  }

  const list = rows.map((k) => {
    const pc = qc(k.monthlyPcQcCnt);
    const mo = qc(k.monthlyMobileQcCnt);
    const pcClk = qc(k.monthlyAvePcClkCnt);
    const moClk = qc(k.monthlyAveMobileClkCnt);
    return {
      keyword: k.relKeyword || "",
      pc: pc.n,
      mobile: mo.n,
      total: pc.n + mo.n,
      low: pc.low || mo.low,
      clicks: pcClk.n + moClk.n,
      comp: k.compIdx || "",
      depth: Number(k.plAvgDepth) || 0
    };
  }).filter((k) => k.keyword);

  list.sort((a, b) => b.total - a.total);

  const out = { ok: true, data: { seed: hint, list: list.slice(0, 120) } };
  if (debug) out.raw = text.slice(0, 2000);
  return out;
}

/* =====================================================================
   쿠팡 검색 1위 상품 → 그대로 비교 분석으로 넘긴다
   ===================================================================== */
/* 여러 이미지를 한꺼번에 받되 동시에 너무 많이 열지 않는다 */
async function thumbBatch(urls, size) {
  const out = new Array(urls.length).fill("");
  const CHUNK = 3;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const slice = urls.slice(i, i + CHUNK);
    const done = await Promise.all(slice.map((u) => makeThumb(u, size)));
    for (let j = 0; j < done.length; j++) out[i + j] = done[j];
    if (i + CHUNK < urls.length) await sleep(300);
  }
  return out;
}

/* 필요한 그림만 골라 받는다. 목록 스무 장을 통째로 받는 것보다 훨씬 가볍다. */
async function fetchThumbs(urls, size) {
  const list = (urls || []).slice(0, 40).map((u) => String(u || ""));
  if (!list.length) return { ok: true, data: { images: [] } };
  const images = await thumbBatch(list, size || 240);
  return { ok: true, data: { images } };
}

/* =====================================================================
   쿠팡 파트너스 공식 API
   쿠팡이 정식으로 열어둔 통로다. 화면을 긁지 않으므로 막히지 않는다.
   대신 검색은 한 시간에 열 번까지, 한 번에 열 개까지다.
   ===================================================================== */
const PARTNER_HOST = "https://api-gateway.coupang.com";
const PARTNER_PATH = "/v2/providers/affiliate_open_api/apis/openapi/products/search";
const PARTNER_HOUR_LIMIT = 10;

async function partnerCreds() {
  try {
    const o = await chrome.storage.local.get("sp.partners");
    return o["sp.partners"] || null;
  } catch (e) { return null; }
}

/* 쿠팡이 요구하는 서명 형식: 날짜 + 메서드 + 경로 + 질의문자열 을 이어 붙여 해시한다 */
function signedDate(d) {
  const p = (n) => (n < 10 ? "0" : "") + n;
  const t = d || new Date();
  return String(t.getUTCFullYear()).slice(2) + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) +
    "T" + p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds()) + "Z";
}
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.prototype.map.call(new Uint8Array(sig),
    (b) => ("0" + b.toString(16)).slice(-2)).join("");
}
async function partnerAuth(method, path, query, c) {
  const date = signedDate();
  const message = date + method + path + query;
  const signature = await hmacHex(c.secret, message);
  return "CEA algorithm=HmacSHA256, access-key=" + c.accessKey +
    ", signed-date=" + date + ", signature=" + signature;
}

/* 한 시간에 열 번 제한을 우리 쪽에서도 지킨다 */
let partnerCalls = [];
function partnerRoom() {
  const hourAgo = Date.now() - 3600000;
  partnerCalls = partnerCalls.filter((t) => t > hourAgo);
  return PARTNER_HOUR_LIMIT - partnerCalls.length;
}

async function partnerSearch(keyword, limit) {
  const c = await partnerCreds();
  if (!c || !c.accessKey || !c.secret) return { ok: false, noKey: true, error: "파트너스 키가 없습니다." };

  const kw = String(keyword || "").trim();
  if (!kw) return { ok: false, error: "키워드가 비어 있습니다." };
  if (partnerRoom() <= 0) {
    return { ok: false, quota: true,
      error: "쿠팡 파트너스는 한 시간에 열 번까지 검색할 수 있습니다. 잠시 뒤에 다시 시도해주세요." };
  }

  const want = Math.min(10, Math.max(1, limit || 10));
  const query = "keyword=" + encodeURIComponent(kw) + "&limit=" + want;
  const url = PARTNER_HOST + PARTNER_PATH + "?" + query;
  let auth;
  try {
    auth = await partnerAuth("GET", PARTNER_PATH, query, c);
  } catch (e) {
    return { ok: false, error: "서명을 만들지 못했습니다: " + (e && e.message ? e.message : e) };
  }

  partnerCalls.push(Date.now());
  let res, text;
  try {
    res = await fetch(url, { method: "GET", headers: { Authorization: auth } });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: "쿠팡 파트너스에 연결하지 못했습니다: " + (e && e.message ? e.message : e) };
  }

  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!res.ok || !json) {
    return { ok: false, error: "쿠팡 파트너스 응답이 올바르지 않습니다 (" + res.status + ")",
             raw: String(text).slice(0, 1200) };
  }
  if (json.rCode && String(json.rCode) !== "0") {
    return { ok: false, error: "쿠팡 파트너스: " + (json.rMessage || json.rCode),
             raw: String(text).slice(0, 1200) };
  }

  /* 응답 필드 이름이 조금씩 다를 수 있어 있는 대로 골라 담는다 */
  const rows = (json.data && (json.data.productData || json.data.products)) ||
               json.productData || [];
  const items = rows.map((r, i) => ({
    rank: i + 1,
    productId: String(r.productId || r.productid || ""),
    url: r.productUrl || r.productURL || "",
    name: r.productName || r.title || "",
    price: Number(r.productPrice || r.price || 0),
    basePrice: 0,
    unitPrice: "",
    rating: "",
    reviews: 0,
    rocket: !!(r.isRocket || r.rocket),
    freeShip: !!(r.isFreeShipping || r.freeShipping),
    image: r.productImage || r.image || ""
  })).filter((x) => x.name && x.price > 0);

  return { ok: true, data: { keyword: kw, items: items, read: items.length, partner: true } };
}

/* =====================================================================
   쿠팡 검색 결과 보관함
   같은 키워드를 다시 볼 때 쿠팡을 또 두드리지 않는다.
   요청을 줄이는 것이 차단을 피하는 가장 확실한 방법이다.
   ===================================================================== */
const SEARCH_CACHE_TTL = 12 * 60 * 60 * 1000;   /* 반나절 */
const SEARCH_CACHE_KEY = "sp.cp.";

async function cachedSearch(kw) {
  try {
    const key = SEARCH_CACHE_KEY + kw;
    const o = await chrome.storage.local.get(key);
    const hit = o[key];
    if (hit && hit.items && Date.now() - hit.at < SEARCH_CACHE_TTL) return hit.items;
  } catch (e) { /* 저장소를 못 읽으면 그냥 새로 받는다 */ }
  return null;
}
async function keepSearch(kw, items) {
  if (!kw || !items || !items.length) return;
  try {
    await chrome.storage.local.set({ [SEARCH_CACHE_KEY + kw]: { at: Date.now(), items: items } });
  } catch (e) {
    /* 자리가 모자라면 통째로 비우고 이번 것만 남긴다 */
    try {
      await clearSearchCache();
      await chrome.storage.local.set({ [SEARCH_CACHE_KEY + kw]: { at: Date.now(), items: items } });
    } catch (e2) {}
  }
}
async function clearSearchCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.indexOf(SEARCH_CACHE_KEY) === 0);
    if (keys.length) await chrome.storage.local.remove(keys);
    return { ok: true, data: { cleared: keys.length } };
  } catch (e) {
    return { ok: false, error: "저장된 검색 기록을 비우지 못했습니다." };
  }
}
async function countSearchCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const n = Object.keys(all).filter((k) => k.indexOf(SEARCH_CACHE_KEY) === 0).length;
    return { ok: true, data: { count: n } };
  } catch (e) { return { ok: true, data: { count: 0 } }; }
}

/* 쿠팡 화면 안의 검색창에 글자를 넣어 검색한다.
   검색 주소를 곧바로 여는 것보다 사람이 쓰는 모습에 가까워 덜 막힌다. */
function typeIntoCoupang(keyword) {
  function findBox() {
    var sels = [
      "#headerSearchKeyword", 'input[name="q"]', 'input[id*="search"]',
      'input[placeholder*="찾고"]', 'input[placeholder*="검색"]',
      'form[action*="search"] input[type="text"]', 'input[type="search"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }
  return new Promise(function (resolve) {
    var box = findBox();
    if (!box) return resolve({ ok: false, error: "쿠팡 검색창을 찾지 못했습니다." });
    try {
      box.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(box, keyword);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { box.value = keyword; }
    setTimeout(function () {
      var form = box.form || (box.closest ? box.closest("form") : null);
      var btn = document.querySelector('button[type="submit"], [class*="search-button"], [class*="searchBtn"]');
      try {
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
      } catch (e) {}
      if (btn && btn.click) { try { btn.click(); } catch (e) {} }
      else if (form) { try { form.submit(); } catch (e) {} }
      resolve({ ok: true });
    }, 500);
  });
}

/* 지금 사람이 보고 있는 쿠팡 검색 화면을 그대로 읽는다.
   우리가 페이지를 열지 않으므로 쿠팡이 막을 거리가 없다. */
/* 사람이 직접 열어본 쿠팡 검색 탭. 읽기를 누르면 이것부터 본다. */
let openedCoupangTab = null;

/* 카테고리 목록을 볼 때 쓰는 탭. 한 탭만 쓰고, 쪽을 넘길 때도 그 탭 주소만 바꾼다.
   탭을 여러 개 열거나 빠르게 부르면 쿠팡이 막는다. 사람이 보는 속도로 움직인다. */
async function coupangOpenUrl(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\/(www\.)?coupang\.com\//i.test(target)) {
    return { ok: false, error: "쿠팡 주소가 아닙니다." };
  }
  const cool = coupangCooling();
  if (cool) {
    return { ok: false, blocked: true,
      error: "쿠팡이 접속을 잠시 막아두었습니다. " + cool + "초쯤 뒤에 다시 시도해주세요." };
  }
  try {
    if (openedCoupangTab != null) {
      try {
        await chrome.tabs.get(openedCoupangTab);
        await polite("coupang-page", pageGap());
        await chrome.tabs.update(openedCoupangTab, { url: target, active: true });
        const t = await chrome.tabs.get(openedCoupangTab);
        try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
        await waitForLoad(openedCoupangTab);
        return { ok: true, data: { tabId: openedCoupangTab, reused: true } };
      } catch (e) { openedCoupangTab = null; }
    }
    const tab = await chrome.tabs.create({ url: target, active: true });
    openedCoupangTab = tab.id;
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    await waitForLoad(tab.id);
    return { ok: true, data: { tabId: tab.id, reused: false } };
  } catch (e) {
    return { ok: false, error: "쿠팡 화면을 열지 못했습니다." };
  }
}

/* 쿠팡 카테고리 차림표를 한 번만 읽어 저장해 둔다.
   이 목록은 자주 바뀌지 않으므로 이레 동안 그대로 쓴다.
   그래서 카테고리를 고르는 일로 쿠팡을 부르는 횟수는 늘지 않는다. */
const CAT_TREE_TTL = 7 * 24 * 3600 * 1000;

async function coupangCatTree(force) {
  if (!force) {
    try {
      const got = await chrome.storage.local.get("sp.catTree");
      const box = got["sp.catTree"];
      if (box && box.at && Date.now() - box.at < CAT_TREE_TTL && (box.tree || []).length) {
        return { ok: true, data: { tree: box.tree, cached: true, at: box.at } };
      }
    } catch (e) { /* 저장된 게 없으면 새로 읽는다 */ }
  }

  const cool = coupangCooling();
  if (cool) {
    return { ok: false, blocked: true,
      error: "쿠팡이 접속을 잠시 막아두었습니다. " + cool + "초쯤 뒤에 다시 시도해주세요." };
  }

  /* 이미 열려 있는 쿠팡 탭이 있으면 그걸 쓴다. 없을 때만 하나 연다. */
  let tabId = null;
  let borrowed = false;
  try {
    const open = await chrome.tabs.query({ url: ["*://*.coupang.com/*", "*://coupang.com/*"] });
    const live = (open || []).filter((t) => t && t.id != null && !/login/i.test(t.url || ""))[0];
    if (live) { tabId = live.id; borrowed = true; }
  } catch (e) { tabId = null; }

  await beginJob();
  try {
    if (tabId == null) {
      const tab = await openSideTab("https://www.coupang.com/");
      tabId = tab.id;
      await waitForLoad(tabId);
      await sleep(1800);
    }
    await ensureInjected(tabId);

    let res = null;
    for (let i = 0; i < 6; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "catTree" }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(900);
      await ensureInjected(tabId);
    }
    if (!res || !res.ok) {
      const why = await blockedText(tabId);
      if (why) {
        markCoupangBlocked(5);
        return { ok: false, blocked: true,
          error: "쿠팡이 접속을 막았습니다. 5분쯤 쉬었다가 다시 시도해주세요. (" + why + ")" };
      }
      return { ok: false, error: (res && res.error) || "카테고리 차림표를 읽지 못했습니다." };
    }

    const tree = (res.data && res.data.tree) || [];
    try {
      await chrome.storage.local.set({ "sp.catTree": { at: Date.now(), tree: tree } });
    } catch (e) { /* 저장 실패는 이번만 다시 읽으면 된다 */ }
    return { ok: true, data: {
      tree: tree, cached: false,
      links: res.data && res.data.links, tops: res.data && res.data.tops,
      leaves: res.data && res.data.leaves
    } };
  } catch (e) {
    return { ok: false, error: "카테고리 차림표를 읽지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    if (!borrowed) await parkSideWindow();
    releaseAwake();
  }
}

/* 지금 보고 있는 쿠팡 목록의 다음 쪽으로 넘긴다. 새 탭을 열지 않는다. */
async function coupangNextPage() {
  if (openedCoupangTab == null) {
    return { ok: false, error: "먼저 쿠팡에서 목록을 열어주세요." };
  }
  let here = "";
  try {
    const t = await chrome.tabs.get(openedCoupangTab);
    here = (t && t.url) || "";
  } catch (e) {
    openedCoupangTab = null;
    return { ok: false, error: "그 쿠팡 탭이 닫혔습니다. 다시 열어주세요." };
  }
  if (!/coupang\.com/i.test(here)) {
    return { ok: false, error: "그 탭은 쿠팡 화면이 아닙니다." };
  }

  let next = "";
  try {
    const u = new URL(here);
    const now = parseInt(u.searchParams.get("page") || "1", 10) || 1;
    u.searchParams.set("page", String(now + 1));
    next = u.toString();
  } catch (e) {
    return { ok: false, error: "쪽 번호를 바꾸지 못했습니다." };
  }

  /* 사람이 다음 쪽을 누르는 정도의 간격을 둔다 */
  await polite("coupang-page", pageGap());
  try {
    await chrome.tabs.update(openedCoupangTab, { url: next, active: true });
    await waitForLoad(openedCoupangTab);
    await sleep(1400);
  } catch (e) {
    return { ok: false, error: "다음 쪽으로 넘기지 못했습니다." };
  }

  const why = await blockedText(openedCoupangTab);
  if (why) {
    markCoupangBlocked(5);
    return { ok: false, blocked: true,
      error: "쿠팡이 접속을 막았습니다. 5분쯤 쉬었다가 다시 시도해주세요. (" + why + ")" };
  }
  return { ok: true, data: { url: next } };
}

async function readActiveCoupang(limit) {
  const want = Math.min(40, Math.max(1, limit || 20));

  /* 쿠팡 탭을 여러 갈래로 찾는다.
     쿠팡은 주소를 자주 갈아끼우므로 /np/search 만 보면 놓친다.
     그래서 쿠팡 탭을 모두 모은 뒤, 그중 검색 결과로 보이는 것을 고른다. */
  let all = [];
  try {
    all = await chrome.tabs.query({ url: ["*://*.coupang.com/*", "*://coupang.com/*"] });
  } catch (e) { all = [] }
  all = (all || []).filter((t) => t && t.id != null);

  const isSearch = (t) => /\/np\/search|\/np\/categories|[?&]q=/i.test(t.url || "");

  /* 쿠팡 열기로 띄웠던 탭이 아직 살아 있으면 그것부터 */
  let hit = null;
  if (openedCoupangTab != null) {
    const mine = all.filter((t) => t.id === openedCoupangTab)[0];
    if (mine) hit = mine;
    else openedCoupangTab = null;
  }

  try {
    if (!hit) {
      const act = await chrome.tabs.query({ active: true, currentWindow: true });
      const cur = (act || [])[0];
      if (cur && /coupang\.com/i.test(cur.url || "") && isSearch(cur)) hit = cur;
    }
  } catch (e) { /* 못 읽으면 아래에서 고른다 */ }

  /* 아니면 열려 있는 쿠팡 탭 가운데 검색 화면을 고른다. 가장 최근 것이 앞에 오도록 뒤에서부터 본다. */
  if (!hit) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (isSearch(all[i])) { hit = all[i]; break; }
    }
  }

  if (!hit) {
    if (!all.length) {
      return { ok: false, error: "쿠팡 탭이 하나도 열려 있지 않습니다. 키워드 표에서 쿠팡 열기를 먼저 눌러주세요." };
    }
    let where = "";
    try {
      where = all.map((t) => String(t.url || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 46)).join(" / ");
    } catch (e) { where = ""; }
    return { ok: false,
      error: "쿠팡 탭은 열려 있는데 검색 결과 화면이 아닙니다. 그 탭에서 검색을 한 번 해주세요. (지금 주소 " + where + ")" };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: hit.id }, files: ["scrape.js"] });
  } catch (e) { /* 이미 붙어 있으면 무시 */ }
  const res = await new Promise((resolve) => {
    chrome.tabs.sendMessage(hit.id, { type: "searchTop", limit: want }, (r) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r || null);
    });
  });
  if (!res) {
    return { ok: false,
      error: "그 쿠팡 탭에 수집기를 붙이지 못했습니다. 그 탭을 한 번 새로고침한 뒤 다시 눌러주세요." };
  }
  if (!res.ok) {
    return { ok: false, error: "그 화면에서 상품을 읽지 못했습니다. " + (res.error || "") };
  }
  const items = (res.data && res.data.items) || [];
  let kw = "";
  try { kw = decodeURIComponent((String(hit.url).match(/[?&]q=([^&]*)/) || [, ""])[1] || ""); } catch (e) {}
  await keepSearch(kw, items);
  return { ok: true, data: { keyword: kw, items: items, read: items.length, manual: true } };
}

/* 쿠팡 작업용 탭 하나를 계속 쓴다. 자동 소싱처럼 여러 번 검색할 때 쓴다. */
let coupangTabId = null;
let coupangSession = false;

async function coupangGo(url) {
  await polite("coupang-page", pageGap());
  coupangHits++;
  if (coupangHits % LONG_REST_EVERY === 0) await sleep(LONG_REST_MS);

  if (coupangTabId != null) {
    try {
      /* url 이 없으면 지금 열린 화면에서 검색창만 쓴다 */
      if (url) await chrome.tabs.update(coupangTabId, { url });
      else await chrome.tabs.get(coupangTabId);
      return coupangTabId;
    } catch (e) { coupangTabId = null; }
  }
  const tab = await openWorkTab(url || "https://www.coupang.com/", false);
  coupangTabId = tab.id;
  return tab.id;
}
async function endCoupangSession() {
  coupangSession = false;
  if (coupangTabId != null) {
    await closeWorkTab(coupangTabId);
    coupangTabId = null;
  }
  return { ok: true };
}

async function coupangTop(keyword, limit, withImages) {
  const kw = String(keyword || "").trim();
  const want = Math.min(40, Math.max(1, limit || 5));
  if (!kw) return { ok: false, error: "키워드가 비어 있습니다." };
  /* 저장해 둔 결과가 있으면 쿠팡을 건드리지 않는다 */
  const saved = await cachedSearch(kw);
  if (saved) {
    return { ok: true, data: { keyword: kw, items: saved, read: saved.length, cached: true } };
  }

  /* 공식 통로가 열려 있으면 그쪽으로 간다. 화면을 긁지 않으니 막히지 않는다. */
  const viaPartner = await partnerSearch(kw, Math.min(10, want));
  if (viaPartner.ok && viaPartner.data.items.length) {
    await keepSearch(kw, viaPartner.data.items);
    return viaPartner;
  }
  if (viaPartner.quota) return viaPartner;

  const cool = coupangCooling();
  if (cool) {
    return { ok: false, blocked: true,
      error: "쿠팡이 접속을 잠시 막아두었습니다. " + cool + "초쯤 뒤에 다시 시도해주세요." };
  }
  await beginJob();
  let tabId = null;
  try {
    /* 필요한 만큼만 불러온다. 한 번에 많이 부를수록 쿠팡이 막을 확률이 올라간다. */
    /* 검색 주소를 곧바로 열지 않는다. 쿠팡 화면을 띄운 뒤 검색창에 글자를 넣는다. */
    const home = "https://www.coupang.com/";
    const tabId0 = await coupangGo(coupangTabId == null ? home : null);
    const tab = { id: tabId0 };
    tabId = tab.id;
    let loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "쿠팡을 열지 못했습니다." };

    let typed = null;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId }, func: typeIntoCoupang, args: [kw]
      });
      typed = r && r[0] ? r[0].result : null;
    } catch (e) { typed = null; }

    if (!typed || !typed.ok) {
      /* 검색창을 못 찾으면 어쩔 수 없이 주소로 간다 */
      const listSize = want <= 10 ? 20 : 36;
      const url = "https://www.coupang.com/np/search?q=" + encodeURIComponent(kw) +
        "&channel=user&listSize=" + listSize + "&sorter=scoreDesc";
      try { await chrome.tabs.update(tabId, { url }); } catch (e) {}
    }
    await sleep(2000);
    loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "쿠팡 검색 결과를 열지 못했습니다." };
    await ensureInjected(tabId);

    let res = null;
    for (let i = 0; i < 8; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "searchTop", limit: want }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(800);
      if (i === 3) await ensureInjected(tabId);
    }
    if (!res || !res.ok || !((res.data && res.data.items) || []).length) {
      const why = await blockedText(tabId);
      if (why) {
        markCoupangBlocked(5);
        return { ok: false, blocked: true,
          error: "쿠팡이 접속을 막았습니다. 5분쯤 쉬었다가 다시 시도해주세요. (" + why + ")" };
      }
      if (!res) return { ok: false, error: "쿠팡 검색 결과를 읽지 못했습니다." };
      if (!res.ok) return res;
    }

    const items = (res.data && res.data.items) || [];
    if (withImages && items.length) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 160);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    await keepSearch(kw, items);
    return { ok: true, data: { keyword: kw, items: items, read: items.length } };
  } catch (e) {
    return { ok: false, error: "쿠팡 상위 상품을 찾지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    /* 이어서 더 검색할 예정이면 탭을 그대로 둔다 */
    if (!coupangSession) {
      await closeWorkTab(tabId);
      if (tabId === coupangTabId) coupangTabId = null;
    }
    releaseAwake();
  }
}

/* =====================================================================
   테무 — 베스트셀러와 별점 5점

   테무는 채널 화면 두 개를 그대로 쓴다. 갈래(카테고리)는 주소가 아니라
   화면 위 딱지를 눌러 갈아끼우는 구조라, 붙여넣은 스크립트가 대신 눌러준다.
   ===================================================================== */
const TEMU_CHANNELS = {
  best: "https://www.temu.com/kr/channel/best-sellers.html",
  star: "https://www.temu.com/kr/channel/full-star.html",
  new:  "https://www.temu.com/kr/channel/new-in.html"
};

async function temuOpen(channel) {
  const url = TEMU_CHANNELS[channel] || TEMU_CHANNELS.best;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    return { ok: true, data: { tabId: tab.id } };
  } catch (e) {
    return { ok: false, error: "테무를 열지 못했습니다." };
  }
}

async function temuTop(channel, limit, category, withImages) {
  const url = TEMU_CHANNELS[channel] || TEMU_CHANNELS.best;
  const want = Math.min(60, Math.max(1, limit || 20));

  await beginJob();
  let tabId = null;
  try {
    /* 테무는 화면을 다 그린 뒤에야 상품이 생긴다.
       배경 탭은 크롬이 일을 늦춰서 끝내 안 그려진다. 그래서 앞으로 띄운다.
       다 읽고 나면 아래에서 소싱 프로 탭으로 되돌린다. */
    const tab = await openSideTab(url);
    tabId = tab.id;
    await waitForLoad(tabId);      /* 못 기다려도 계속 간다. 뒤에서 다시 확인한다. */
    await sleep(3600);
    await ensureInjected(tabId);

    let res = null;
    for (let i = 0; i < 10; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "temuTop", limit: want, category: category || "" }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(1200);
      await ensureInjected(tabId);
    }
    if (!res) return { ok: false, error: "테무 화면에 수집기를 붙이지 못했습니다. 테무 탭을 직접 열어 한 번 새로고침해주세요." };
    if (!res.ok) {
      let now = "";
      try { const t = await chrome.tabs.get(tabId); now = t.url || ""; } catch (e) {}
      if (/login|signin/i.test(now)) {
        return { ok: false, needsLogin: true,
          error: "테무가 로그인을 요구합니다. 로그인한 뒤 다시 눌러주세요." };
      }
      return res;
    }

    const items = (res.data && res.data.items) || [];
    if (withImages && items.length) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 160);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    return { ok: true, data: {
      channel: channel || "best",
      category: category || "",
      picked: !!(res.data && res.data.picked),
      items: items, read: items.length
    } };
  } catch (e) {
    return { ok: false, error: "테무 상품을 찾지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    await parkSideWindow();
    releaseAwake();
  }
}

/* =====================================================================
   타오바오 — 판매량 순 인기 상품

   예전 순위 사이트(top.taobao.com)는 없어졌다. 지금은 검색 결과를
   판매량 순으로 정렬한 것이 사실상의 베스트 목록이다.
   로그인한 상태라야 결과가 보이므로, 비어 있으면 로그인을 안내한다.
   ===================================================================== */
function taobaoSearchUrl(keyword) {
  return "https://s.taobao.com/search?q=" + encodeURIComponent(keyword) + "&sort=sale-desc";
}

async function taobaoLoggedIn() {
  try {
    const c = await chrome.cookies.get({ url: "https://www.taobao.com/", name: "_nk_" });
    if (c && c.value) return true;
    const t = await chrome.cookies.get({ url: "https://www.taobao.com/", name: "tracknick" });
    return !!(t && t.value);
  } catch (e) {
    return true; /* 확인이 안 되면 일단 진행한다 */
  }
}

async function temuLoggedIn() {
  /* 테무는 로그인해야 개인화된 목록이 제대로 나온다. 쿠키로 먼저 확인한다. */
  const names = ["user_uin", "api_uid", "region", "_bee"];
  for (let i = 0; i < names.length; i++) {
    try {
      const c = await chrome.cookies.get({ url: "https://www.temu.com/", name: names[i] });
      if (c && c.value && c.value.length > 6) return true;
    } catch (e) { /* 쿠키를 못 읽으면 다음 것을 본다 */ }
  }
  return false;
}

async function shopLogin(site) {
  if (site === "temu") {
    const on = await temuLoggedIn();
    return { ok: true, data: { site: "temu", on: on } };
  }
  if (site === "taobao") {
    const on = await taobaoLoggedIn();
    return { ok: true, data: { site: "taobao", on: on } };
  }
  return { ok: false, error: "알 수 없는 곳입니다." };
}

async function shopLoginOpen(site) {
  const url = site === "temu"
    ? "https://www.temu.com/kr/login.html"
    : "https://login.taobao.com/";
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    loginTabId = tab.id;
    return { ok: true, data: { tabId: tab.id } };
  } catch (e) {
    return { ok: false, error: "로그인 화면을 열지 못했습니다." };
  }
}

async function taobaoOpen(keyword) {
  const url = keyword ? taobaoSearchUrl(keyword) : "https://login.taobao.com/";
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    return { ok: true, data: { tabId: tab.id } };
  } catch (e) {
    return { ok: false, error: "타오바오를 열지 못했습니다." };
  }
}

async function taobaoTop(keyword, limit, withImages) {
  const kw = String(keyword || "").trim();
  const want = Math.min(40, Math.max(1, limit || 20));
  if (!kw) return { ok: false, error: "키워드가 비어 있습니다." };

  const signedIn = await taobaoLoggedIn();
  if (!signedIn) {
    return { ok: false, needsLogin: true,
      error: "타오바오에 로그인되어 있지 않습니다. 로그인한 뒤 다시 눌러주세요." };
  }

  await beginJob();
  let tabId = null;
  try {
    const tab = await openSideTab(taobaoSearchUrl(kw));
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "타오바오를 열지 못했습니다." };
    await sleep(2200);
    await ensureInjected(tabId);

    let res = null;
    for (let i = 0; i < 8; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "taobaoTop", limit: want }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(900);
      if (i === 3) await ensureInjected(tabId);
    }
    if (!res) return { ok: false, error: "타오바오 화면을 읽지 못했습니다." };
    if (!res.ok) {
      let url = "";
      try { const t = await chrome.tabs.get(tabId); url = t.url || ""; } catch (e) {}
      if (/login\.taobao\.com/i.test(url)) {
        return { ok: false, needsLogin: true,
          error: "타오바오가 로그인을 요구합니다. 로그인한 뒤 다시 눌러주세요." };
      }
      return res;
    }

    const items = (res.data && res.data.items) || [];
    if (withImages && items.length) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 160);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    return { ok: true, data: { keyword: kw, items: items, read: items.length } };
  } catch (e) {
    return { ok: false, error: "타오바오 인기 상품을 찾지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    await parkSideWindow();
    releaseAwake();
  }
}

/* =====================================================================
   쿠팡 리뷰 — 최근 리뷰를 모아 좋은 점과 나쁜 점을 뽑는 재료로 쓴다.

   쿠팡 상품 화면이 스스로 부르는 리뷰 통로(/next-api/review)를 그대로 쓴다.
   한 번에 50개씩 받으므로 100개는 두 번만 부르면 된다. 화면을 넘길 일이 없어 막힐 거리가 적다.
   먼저 여기서 바로 부르고, 막히면 쿠팡 탭 안에서 같은 주소로 부른다.
   ===================================================================== */
const REVIEW_SORTS = ["DATE_DESC", "ORDER_SCORE_ASC"];

function reviewUrl(pid, page, size, sortBy) {
  const q = new URLSearchParams({
    productId: String(pid), page: String(page), size: String(size),
    sortBy: sortBy, ratingSummary: "true", ratings: "", market: ""
  });
  return "https://www.coupang.com/next-api/review?" + q.toString();
}

/* 쿠팡 탭 안에서 실행된다. 같은 출처라 쿠키가 그대로 실린다. */
async function askReviewInPage(url) {
  try {
    const res = await fetch(url, { method: "GET", credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "HTTP_" + res.status };
    const body = await res.json();
    return { ok: true, body: body };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function reviewPageDirect(url) {
  try {
    const res = await fetch(url, { method: "GET", credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "HTTP_" + res.status };
    const body = await res.json();
    return { ok: true, body: body };
  } catch (e) {
    return { ok: false, error: "NET" };
  }
}

async function reviewPageInTab(url, pid) {
  let tabId = null;
  let made = false;
  try {
    const open = await chrome.tabs.query({ url: ["*://www.coupang.com/*"] });
    const live = (open || []).filter((t) => t && t.id != null && !/login/i.test(t.url || ""))[0];
    if (live) tabId = live.id;
  } catch (e) { tabId = null; }
  if (tabId == null) {
    const tab = await openSideTab("https://www.coupang.com/vp/products/" + pid);
    tabId = tab.id;
    made = true;
    await waitForLoad(tabId);
    await sleep(1200);
  }
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: askReviewInPage, args: [url] });
    return (r && r[0] && r[0].result) || { ok: false, error: "NO_RESULT" };
  } catch (e) {
    return { ok: false, error: "INJECT" };
  } finally {
    if (made) await parkSideWindow();
  }
}

function mapReview(r) {
  const title = String((r && r.title) || "").trim();
  const body = String((r && r.content) || "").trim();
  const text = title && body ? (title + "\n" + body) : (title || body);
  const at = r && r.reviewAt ? new Date(r.reviewAt) : null;
  return {
    stars: Number(r && r.rating) || 0,
    text: text,
    option: String((r && r.itemName) || "").trim(),
    date: at && !isNaN(at.getTime()) ? at.toISOString().slice(0, 10) : "",
    at: at && !isNaN(at.getTime()) ? at.getTime() : 0,
    photo: Array.isArray(r && r.attachments) && r.attachments.length > 0,
    helpful: Number(r && r.helpfulTrueCount) || 0
  };
}

/* 한 가지 방법(바로 부르기 또는 쿠팡 탭 안에서 부르기)과 한 가지 정렬로 리뷰를 모은다 */
async function fetchReviewsOnce(pid, want, sortBy, way) {
  const size = 50;
  const raw = [];
  let summary = null, total = null, err = "";
  for (let page = 1; raw.length < want && page <= Math.ceil(want / size) + 1; page++) {
    const url = reviewUrl(pid, page, size, sortBy);
    const got = way === "direct" ? await reviewPageDirect(url) : await reviewPageInTab(url, pid);
    if (!got.ok) { err = got.error || "실패"; break; }
    const b = got.body;
    if (!b || b.rCode !== "RET0000") { err = (b && (b.rMessage || b.rCode)) || "응답 모양이 다름"; break; }
    const rData = b.rData || {};
    const paging = rData.paging || {};
    const contents = Array.isArray(paging.contents) ? paging.contents : [];
    if (!summary && rData.ratingSummaryTotal) summary = rData.ratingSummaryTotal;
    if (total == null && rData.reviewTotalCount != null) total = Number(rData.reviewTotalCount);
    contents.forEach((c) => raw.push(c));
    const tp = Number(paging.totalPage);
    if (!contents.length || contents.length < size || (Number.isFinite(tp) && page >= tp)) break;
    await sleep(700);
  }
  return { raw, summary, total, err };
}

async function coupangReviews(productId, count) {
  const pid = String(productId || "").trim();
  if (!/^\d{5,}$/.test(pid)) return { ok: false, error: "쿠팡 상품번호가 올바르지 않습니다." };
  const want = Math.max(10, Math.min(300, Number(count) || 100));
  const cool = coupangCooling();
  if (cool) {
    return { ok: false, blocked: true,
      error: "쿠팡이 접속을 잠시 막아두었습니다. " + cool + "초쯤 뒤에 다시 시도해주세요." };
  }

  /* 쿠팡 탭이 열려 있으면 그 안에서 먼저 부른다. 참고한 확장프로그램이 쓰는 방식이라 가장 확실하다.
     빈 목록이 오면 실패로 보고 다음 방법으로 넘어간다. 예전에는 빈 목록을 그대로 결과로 써서 0개가 나왔다. */
  let hasTab = false;
  try {
    const open = await chrome.tabs.query({ url: ["*://www.coupang.com/*"] });
    hasTab = (open || []).some((t) => t && t.id != null && !/login/i.test(t.url || ""));
  } catch (e) { hasTab = false; }
  const ways = hasTab ? ["tab", "direct"] : ["direct", "tab"];
  const attempts = [];
  REVIEW_SORTS.forEach((sortBy) => ways.forEach((way) => attempts.push({ sortBy, way })));

  const log = [];
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const got = await fetchReviewsOnce(pid, want, a.sortBy, a.way);
    log.push((a.way === "tab" ? "탭" : "바로") + "/" + a.sortBy + " " + got.raw.length + "개" + (got.err ? "(" + got.err + ")" : ""));

    if (!got.raw.length) {
      /* 쿠팡이 전체 리뷰 수를 0 이라고 말하면 정말 리뷰가 없는 상품이다. 더 시도하지 않는다. */
      const count0 = got.total === 0 || (got.summary && Number(got.summary.ratingCount) === 0);
      if (count0 && !got.err) {
        return { ok: true, data: { productId: pid, reviews: [], read: 0, total: 0, average: null,
          distribution: {}, sortUsed: a.sortBy, way: a.way, tried: log.join(" · "), empty: true } };
      }
      continue;
    }

    const list = got.raw.map(mapReview).filter((x) => x.text);
    list.sort((x, y) => y.at - x.at);
    const reviews = list.slice(0, want);
    const summary = got.summary;
    const dist = {};
    ((summary && summary.ratingSummaries) || []).forEach((row) => {
      if (row && row.rating != null) dist[row.rating] = Number(row.percentage) || 0;
    });
    return { ok: true, data: {
      productId: pid,
      reviews: reviews,
      read: reviews.length,
      total: got.total != null ? got.total : (summary && summary.ratingCount) || null,
      average: summary && summary.ratingAverage != null ? Number(summary.ratingAverage) : null,
      distribution: dist,
      sortUsed: a.sortBy,
      way: a.way,
      tried: log.join(" · ")
    } };
  }

  return { ok: false, error: "쿠팡 리뷰를 받지 못했습니다. (" + log.join(" · ") + ")" };
}

/* =====================================================================
   쿠팡 화면에서 누르는 리뷰 분석

   리뷰는 여기서 받는다. 문장으로 정리하는 일은 소싱 프로 화면만 할 수 있다.
   그래서 열려 있는 소싱 프로 탭에 리뷰를 넘겨 정리를 부탁하고, 답을 쿠팡 화면으로 돌려준다.
   소싱 프로가 안 열려 있으면 숫자와 리뷰 원문만 돌려준다.
   ===================================================================== */
const INSIGHT_TTL = 15 * 60 * 1000;
const insightCache = new Map();
const APP_URLS = [
  "https://claude.ai/*", "https://*.claude.ai/*", "https://*.claudeusercontent.com/*",
  "https://*.claude.site/*", "https://*.artifacts.claude.com/*",
  "http://localhost/*", "http://127.0.0.1/*"
];

async function appTabsInOrder() {
  const patterns = APP_URLS.slice();
  try {
    const reg = await chrome.scripting.getRegisteredContentScripts();
    (reg || []).forEach((sc) => {
      if (String(sc.id || "").indexOf("sp-bridge-") === 0) (sc.matches || []).forEach((m) => patterns.push(m));
    });
  } catch (e) { /* 따로 연결한 주소가 없으면 기본 주소만 본다 */ }
  let list = [];
  try { list = await chrome.tabs.query({ url: patterns }); } catch (e) { list = []; }
  await recallTabs();
  list = (list || []).filter((t) => t && t.id != null);
  list.sort((a, b) => (b.id === appTabId ? 1 : 0) - (a.id === appTabId ? 1 : 0));
  return list.slice(0, 6);
}

function askAppTab(tabId, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 100000);
    try {
      chrome.tabs.sendMessage(tabId, payload, (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r || null);
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function reviewInsightFromPage(productId, name, force) {
  const pid = String(productId || "").trim();
  const hit = insightCache.get(pid);
  if (!force && hit && Date.now() - hit.t < INSIGHT_TTL) return hit.res;

  const rv = await coupangReviews(pid, 100);
  if (!rv.ok) return rv;
  const d = rv.data || {};
  const reviews = d.reviews || [];
  if (!reviews.length) {
    return { ok: false, error: d.empty
      ? "이 상품에는 아직 리뷰가 없습니다."
      : "리뷰를 한 개도 받지 못했습니다. (" + (d.tried || "") + ")" };
  }
  const slim = (r) => ({ stars: r.stars, text: String(r.text || "").slice(0, 300), option: r.option, date: r.date });

  const lows = reviews.filter((r) => r.stars && r.stars <= 3).slice(0, 5).map(slim);
  const highs = reviews.filter((r) => r.stars >= 5 && String(r.text || "").length >= 20)
    .slice().sort((a, b) => String(b.text).length - String(a.text).length).slice(0, 3).map(slim);

  let insight = null;
  let noApp = true;
  let appError = "";
  if (reviews.length) {
    const tabs = await appTabsInOrder();
    const payload = {
      type: "spAnalyze",
      name: String(name || "").slice(0, 120),
      reviews: reviews.map((r) => ({ stars: r.stars, text: String(r.text || "").slice(0, 400), option: r.option }))
    };
    for (let i = 0; i < tabs.length; i++) {
      const r = await askAppTab(tabs[i].id, payload);
      if (!r) continue;
      noApp = false;
      if (r.ok && r.data) { insight = r.data; break; }
      appError = r.error || "";
    }
  }

  const res = { ok: true, data: {
    productId: pid,
    read: reviews.length,
    total: d.total,
    average: d.average,
    distribution: d.distribution || {},
    lowCount: reviews.filter((r) => r.stars && r.stars <= 3).length,
    photoCount: reviews.filter((r) => r.photo).length,
    lows: lows,
    highs: highs,
    insight: insight,
    noApp: noApp,
    appError: appError
  } };
  if (insight) insightCache.set(pid, { t: Date.now(), res: res });
  return res;
}

/* =====================================================================
   1688 상품 화면 — 사진 받기, 상품 정보, 옵션 정보

   1688 상세 화면은 필요한 값을 전부 페이지 안 데이터(window.context)에 담아 둔다.
   화면 글자를 긁지 않고 그 데이터를 그대로 읽는다. 1688 이 한국어 번역을 켜 두면 옵션 이름도 한국어로 온다.
   이 데이터는 페이지 쪽 세계에만 있어서, 콘텐츠 스크립트가 아니라 MAIN 세계에 넣어 읽는다.
   ===================================================================== */
function read1688InPage() {
  try {
    var ctx = window.context && window.context.result;
    if (!ctx) return { ok: false, error: "NO_CONTEXT" };
    var D = ctx.data || {};
    var m = (ctx.global && ctx.global.globalData && ctx.global.globalData.model) || {};
    var od = m.offerDetail || {}, tm = m.tradeModel || {}, dd = m.detailDescription || {};
    var fields = function (n) { return (D[n] && D[n].fields) || {}; };

    var abs = function (u) {
      u = String(u || "").trim();
      if (!u) return "";
      if (u.indexOf("//") === 0) u = "https:" + u;
      if (!/^https?:/i.test(u)) u = "https://cbu01.alicdn.com/" + u.replace(/^\//, "");
      return u.replace(/^http:/i, "https:");
    };
    /* 작은 그림 꼬리(_220x220.jpg, .310x310.jpg, _.webp)를 떼어 원본 크기로 받는다 */
    var big = function (u) {
      return abs(u)
        .replace(/(\.(?:jpg|jpeg|png|webp|gif))_[^/]*$/i, "$1")
        .replace(/\.\d+x\d+(\.(?:jpg|jpeg|png|webp))$/i, "$1");
    };
    var uniq = function (list) {
      var seen = {}, out = [];
      list.forEach(function (u) { if (u && !seen[u]) { seen[u] = 1; out.push(u); } });
      return out;
    };

    var mainImages = uniq((od.imageList || []).map(function (x) {
      return big(x && (x.fullPathImageURI || x.imageURI));
    }));
    if (!mainImages.length) {
      var g = fields("gallery");
      mainImages = uniq((g.offerImgList || g.mainImage || []).map(big));
    }

    var options = (od.skuProps || []).map(function (p) {
      return {
        prop: String(p.prop || "옵션"),
        values: (p.value || []).map(function (v) {
          return { name: String(v.name || ""), image: v.imageUrl ? big(v.imageUrl) : "" };
        })
      };
    });

    var pws = dd.pieceWeightScale || {};
    var packRows = Array.isArray(pws.pieceWeightScaleInfo) ? pws.pieceWeightScaleInfo : [];
    var packById = {};
    packRows.forEach(function (r) { if (r && r.skuId != null) packById[String(r.skuId)] = r; });

    var skus = (tm.skuMap || []).map(function (k) {
      var pk = packById[String(k.skuId)] || null;
      return {
        spec: String(k.specAttrs || "").replace(/&gt;/g, " / "),
        price: k.discountPrice || k.price || "",
        stock: k.canBookCount != null ? Number(k.canBookCount) : null,
        sold: k.saleCount != null ? Number(k.saleCount) : null,
        skuId: k.skuId,
        length: pk ? pk.length : null, width: pk ? pk.width : null, height: pk ? pk.height : null,
        weight: pk ? pk.weight : null
      };
    });

    var attrs = (od.featureAttributes || []).map(function (a) {
      var v = a.value != null && a.value !== "" ? a.value : (a.values || []).join(", ");
      return { name: String(a.name || ""), value: String(v || "") };
    }).filter(function (a) { return a.name && a.value; });

    var html = (window.offer_details && window.offer_details.content) || "";
    var descImages = uniq((html.match(/https?:\/\/[^"'\s)<>]+?\.(?:jpg|jpeg|png|webp|gif)/gi) || [])
      .concat((html.match(/\/\/[^"'\s)<>]+?alicdn\.com[^"'\s)<>]+?\.(?:jpg|jpeg|png|webp|gif)/gi) || []))
      .map(big));
    var descText = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);

    var t = fields("productTitle");
    var shop = t.shopInfo || {};
    var vid = od.wirelessVideo || {};
    var vurls = vid.videoUrls || {};

    return { ok: true, data: {
      offerId: String(od.offerId || tm.offerId || ""),
      url: String(location.href).split("?")[0],
      title: String(od.subject || t.title || document.title || "").trim(),
      category: String(od.leafCategoryName || ""),
      unit: String(tm.unit || t.unit || ""),
      moq: tm.beginAmount != null ? Number(tm.beginAmount) : null,
      minPrice: tm.minPrice || "",
      maxPrice: tm.maxPrice || "",
      /* 옵션마다 가격이 다른 상품은 currentPrices 가 수량 구간이 아니라 최저·최고가라 구간으로 쓰지 않는다 */
      tiers: (tm.offerPriceModel && tm.offerPriceModel.priceDisplayType === "skuPrice")
        ? []
        : ((tm.offerPriceModel && tm.offerPriceModel.currentPrices) || []).map(function (x) {
            return { from: x.beginAmount, price: x.price };
          }),
      saleCount: tm.saleCount != null ? Number(tm.saleCount) : (t.saleNum || null),
      shop: String(shop.companyName || shop.shopName || shop.name || shop.sellerName || ""),
      mainImages: mainImages,
      options: options,
      skus: skus,
      packColumns: (pws.columnList || []).map(function (c) { return { name: c.name, label: c.label }; }),
      packRows: packRows,
      attrs: attrs,
      descImages: descImages,
      descText: descText,
      descUrl: abs(od.detailUrl || (fields("description").detailUrl) || ""),
      video: abs(vurls.android || vurls.ios || ""),
      videoCover: abs(vid.coverUrl || "")
    } };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function offer1688Read(tabId) {
  if (tabId == null) return { ok: false, error: "1688 탭을 찾지 못했습니다." };
  let out = null;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: read1688InPage });
      out = r && r[0] ? r[0].result : null;
    } catch (e) {
      out = { ok: false, error: "INJECT" };
    }
    if (out && out.ok) break;
    await sleep(900);
  }
  if (!out || !out.ok) {
    return { ok: false, error: out && out.error === "NO_CONTEXT"
      ? "이 화면에서 1688 상품 데이터를 찾지 못했습니다. 상품 상세 화면인지 확인하고 새로고침해주세요."
      : "1688 상품 정보를 읽지 못했습니다. (" + ((out && out.error) || "알 수 없음") + ")" };
  }

  /* 상세 설명은 나중에 불러오는 경우가 있다. 페이지에 아직 없으면 설명 주소를 직접 받아 사진만 뽑는다. */
  const d = out.data;
  if (!d.descImages.length && d.descUrl) {
    try {
      const res = await fetch(d.descUrl, { credentials: "include" });
      const text = await res.text();
      const found = (text.match(/(?:https?:)?\/\/[^"'\s)<>\\]+?\.(?:jpg|jpeg|png|webp|gif)/gi) || [])
        .map((u) => (u.indexOf("//") === 0 ? "https:" + u : u).replace(/^http:/i, "https:"))
        .map((u) => u.replace(/(\.(?:jpg|jpeg|png|webp|gif))_[^/]*$/i, "$1"));
      d.descImages = Array.from(new Set(found));
      if (!d.descText) {
        d.descText = text.replace(/\\u003c/gi, "<").replace(/<[^>]+>/g, " ").replace(/\\[nrt]/g, " ")
          .replace(/\s+/g, " ").trim().slice(0, 3000);
      }
    } catch (e) { /* 설명을 못 받아도 나머지는 쓴다 */ }
  }
  return { ok: true, data: d };
}

function safeName(t, max) {
  return String(t || "").replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 40) || "상품";
}
function extOf(u, fallback) {
  const m = String(u || "").split("?")[0].match(/\.(jpg|jpeg|png|webp|gif|mp4)$/i);
  return m ? m[1].toLowerCase() : (fallback || "jpg");
}
function textDataUrl(text, mime) {
  return "data:" + (mime || "text/plain") + ";charset=utf-8;base64," + btoa(unescape(encodeURIComponent(text)));
}
function downloadOne(url, filename) {
  return new Promise((resolve) => {
    try {
      chrome.downloads.download({ url: url, filename: filename, saveAs: false, conflictAction: "uniquify" }, (id) => {
        if (chrome.runtime.lastError || id == null) return resolve(false);
        resolve(true);
      });
    } catch (e) { resolve(false); }
  });
}

/* kinds: main, option, desc, video, info */
async function offer1688Download(data, kinds, infoText, optionCsv) {
  const d = data || {};
  const k = kinds || {};
  const folder = "1688/" + safeName((d.offerId ? d.offerId + "_" : "") + (d.title || ""), 50);
  const jobs = [];
  const pad = (n) => (n < 10 ? "0" + n : String(n));

  if (k.main) (d.mainImages || []).forEach((u, i) => jobs.push({ url: u, name: "대표_" + pad(i + 1) + "." + extOf(u) }));
  if (k.option) {
    let n = 0;
    (d.options || []).forEach((p) => (p.values || []).forEach((v) => {
      if (!v.image) return;
      n += 1;
      jobs.push({ url: v.image, name: "옵션_" + pad(n) + "_" + safeName(v.name, 30) + "." + extOf(v.image) });
    }));
  }
  if (k.desc) (d.descImages || []).forEach((u, i) => jobs.push({ url: u, name: "상세_" + pad(i + 1) + "." + extOf(u) }));
  if (k.video && d.video) jobs.push({ url: d.video, name: "영상." + extOf(d.video, "mp4") });
  if (k.info && infoText) jobs.push({ url: textDataUrl(infoText), name: "상품정보.txt" });
  if (k.info && optionCsv) jobs.push({ url: textDataUrl("﻿" + optionCsv, "text/csv"), name: "옵션.csv" });

  let ok = 0, fail = 0;
  for (let i = 0; i < jobs.length; i++) {
    const done = await downloadOne(jobs[i].url, folder + "/" + jobs[i].name);
    if (done) ok++; else fail++;
    await sleep(160);
  }
  return { ok: ok > 0, data: { ok: ok, fail: fail, total: jobs.length, folder: folder },
           error: ok ? "" : "받은 파일이 없습니다." };
}

/* =====================================================================
   쿠팡 윙 — 최근 28일 판매량과 조회수

   윙은 판매자 본인이 들어가는 곳이라, 남의 상품이라도 28일 실적을 알려준다.
   추정이 아니라 쿠팡이 주는 값이다. 대신 로그인된 윙 탭이 하나 열려 있어야 한다.
   부르는 일은 그 윙 탭 안에서 시킨다. 그래야 로그인 상태가 그대로 쓰인다.
   ===================================================================== */
const WING_URL = "https://wing.coupang.com/";
const WING_TTL_MS = 15 * 60 * 1000;   /* 같은 상품은 15분간 다시 묻지 않는다 */
const WING_GAP_MS = 320;              /* 연달아 부를 때 사이 간격 */
const wingCache = new Map();
const wingFlight = new Map();

async function wingTab() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: "*://wing.coupang.com/*" }); } catch (e) { tabs = []; }
  return (tabs || [])[0] || null;
}

/* 윙 탭이 없으면 뒤에 조용히 하나 만든다. 화면은 뜨지 않는다.
   한 번 만들면 그대로 두고 계속 쓴다. 상품마다 새로 열지 않는다. */
let wingHelperTab = null;

async function ensureWingTab() {
  if (wingHelperTab != null) {
    try {
      const t = await chrome.tabs.get(wingHelperTab);
      if (t && /wing\.coupang\.com/i.test(t.url || "")) return t;
    } catch (e) { /* 닫혔으면 다시 만든다 */ }
    wingHelperTab = null;
  }
  try {
    const tab = await chrome.tabs.create({ url: WING_URL, active: false, pinned: true });
    wingHelperTab = tab.id;
    await waitForLoad(tab.id);
    await sleep(1200);
    const now = await chrome.tabs.get(tab.id);
    /* 로그인 화면으로 넘어갔으면 값을 받을 수 없다 */
    if (!now || /login|signin/i.test(now.url || "")) return null;
    return now;
  } catch (e) {
    return null;
  }
}

async function closeWingTab() {
  if (wingHelperTab == null) return;
  const id = wingHelperTab;
  wingHelperTab = null;
  try { await chrome.tabs.remove(id); } catch (e) { /* 이미 닫힘 */ }
}

async function wingStatus() {
  /* 탭이 있는지보다 중요한 건 로그인 쿠키가 살아 있는지다.
     쿠키만 있으면 탭 없이도 값을 받아온다. */
  let signedIn = false;
  try {
    const names = ["XSRF-TOKEN", "sid", "AccessToken", "wing_sid"];
    for (let i = 0; i < names.length; i++) {
      const c = await chrome.cookies.get({ url: "https://wing.coupang.com/", name: names[i] });
      if (c && c.value && c.value.length > 6) { signedIn = true; break; }
    }
  } catch (e) { signedIn = false; }

  const tab = await wingTab();
  return { ok: true, data: {
    signedIn: signedIn,
    open: !!tab,
    tabId: tab ? tab.id : null,
    url: tab ? tab.url : ""
  } };
}

async function wingOpen() {
  const tab = await wingTab();
  if (tab) {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) {}
    return { ok: true, data: { open: true, made: false } };
  }
  try {
    const made = await chrome.tabs.create({ url: WING_URL, active: true });
    return { ok: true, data: { open: true, made: true, tabId: made.id } };
  } catch (e) {
    return { ok: false, error: "윙을 열지 못했습니다." };
  }
}

/* 윙 탭 안에서 실행된다. 화면을 건드리지 않고 값만 물어본다. */
async function askWing(pid) {
  try {
    const raw = (document.cookie.split("; ").find((c) => c.indexOf("XSRF-TOKEN=") === 0) || "");
    const token = raw ? decodeURIComponent(raw.split("=")[1] || "") : "";
    const head = { "accept": "application/json, text/plain, */*", "content-type": "application/json" };
    if (token) head["x-xsrf-token"] = token;

    const res = await fetch("https://wing.coupang.com/tenants/seller-web/pre-matching/search", {
      method: "POST",
      mode: "cors",
      credentials: "include",
      headers: head,
      body: JSON.stringify({
        keyword: String(pid),
        excludedProductIds: [],
        searchPage: 0,
        searchOrder: "DEFAULT",
        sortType: "DEFAULT"
      })
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "LOGIN" };
    if (!res.ok) return { ok: false, error: "HTTP_" + res.status };

    const body = await res.json();
    const list = Array.isArray(body && body.result) ? body.result : [];
    const hit = list.filter(function (e) { return String(e && e.productId) === String(pid); })[0] || null;
    if (!hit) return { ok: true, data: { sold: null, views: null, found: false } };
    return {
      ok: true,
      data: {
        sold: hit.salesLast28d == null ? null : Number(hit.salesLast28d),
        views: hit.pvLast28Day == null ? null : Number(hit.pvLast28Day),
        found: true
      }
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/* 윙 탭을 열지 않고 여기서 바로 물어본다.

   이 서비스워커는 윙 주소에 대한 권한을 갖고 있어서, 브라우저를 거치지 않고
   로그인 쿠키를 실어 부를 수 있다. 화면이 필요 없으니 탭도 창도 뜨지 않는다.
   윙에 로그인만 되어 있으면 된다. 접속해 있을 필요는 없다. */
async function askWingDirect(pid) {
  let token = "";
  try {
    const c = await chrome.cookies.get({ url: "https://wing.coupang.com/", name: "XSRF-TOKEN" });
    if (c && c.value) token = decodeURIComponent(c.value);
  } catch (e) { /* 토큰이 없어도 한 번 불러본다 */ }

  const head = { "accept": "application/json, text/plain, */*", "content-type": "application/json" };
  if (token) head["x-xsrf-token"] = token;

  let res = null;
  try {
    res = await fetch("https://wing.coupang.com/tenants/seller-web/pre-matching/search", {
      method: "POST",
      credentials: "include",
      headers: head,
      body: JSON.stringify({
        keyword: String(pid),
        excludedProductIds: [],
        searchPage: 0,
        searchOrder: "DEFAULT",
        sortType: "DEFAULT"
      })
    });
  } catch (e) {
    return { ok: false, error: "NET" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "LOGIN" };
  if (!res.ok) return { ok: false, error: "HTTP_" + res.status };

  let body = null;
  try { body = await res.json(); } catch (e) { return { ok: false, error: "PARSE" }; }
  const list = Array.isArray(body && body.result) ? body.result : [];
  const found = list.filter((e) => String(e && e.productId) === String(pid))[0] || null;
  if (!found) return { ok: true, data: { sold: null, views: null, found: false } };
  return {
    ok: true,
    data: {
      sold: found.salesLast28d == null ? null : Number(found.salesLast28d),
      views: found.pvLast28Day == null ? null : Number(found.pvLast28Day),
      found: true
    }
  };
}

async function wing28(productId) {
  const pid = String(productId || "").trim();
  if (!/^\d{5,}$/.test(pid)) return { ok: false, error: "상품번호가 올바르지 않습니다." };

  const now = Date.now();
  const hit = wingCache.get(pid);
  if (hit && now - hit.t < WING_TTL_MS) return hit.res;
  if (wingFlight.has(pid)) return wingFlight.get(pid);

  const job = (async () => {
    try {
      /* 1) 탭 없이 바로 물어본다. 이게 되면 화면이 하나도 안 뜬다. */
      const direct = await askWingDirect(pid);
      if (direct.ok) {
        const res = { ok: true, data: direct.data, how: "direct" };
        wingCache.set(pid, { t: Date.now(), res: res });
        return res;
      }
      if (direct.error === "LOGIN") {
        return { ok: false, needsLogin: true,
          error: "쿠팡 윙에 로그인되어 있지 않습니다. 윙에 한 번 로그인해주세요." };
      }

      /* 2) 바로 묻기가 막히면, 윙 탭 안에서 대신 물어본다.
            열린 윙 탭이 없으면 우리가 뒤에 하나 만든다.
            이 탭은 화면을 그릴 필요가 없다. 묻고 답만 받으면 되므로
            배경 탭으로 열어도 잘 돈다. 사람 눈에는 아무것도 안 보인다. */
      let tab = await wingTab();
      if (!tab) tab = await ensureWingTab();
      if (!tab) {
        return { ok: false, needsLogin: true,
          error: "쿠팡 윙에서 28일 실적을 받지 못했습니다. 윙에 한 번 로그인해주세요." };
      }

      let out = null;
      try {
        const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: askWing, args: [pid] });
        out = r && r[0] ? r[0].result : null;
      } catch (e) {
        return { ok: false, error: "윙 탭에 접근하지 못했습니다." };
      }
      if (!out) return { ok: false, error: "윙이 답하지 않았습니다." };
      if (!out.ok) {
        if (out.error === "LOGIN") return { ok: false, needsLogin: true, error: "윙에 로그인되어 있지 않습니다." };
        return { ok: false, error: "윙에서 값을 받지 못했습니다. (" + out.error + ")" };
      }
      const res = { ok: true, data: out.data };
      wingCache.set(pid, { t: Date.now(), res: res });
      return res;
    } finally {
      wingFlight.delete(pid);
    }
  })();

  wingFlight.set(pid, job);
  return job;
}

/* 여러 상품을 차례로 묻는다. 한꺼번에 몰아 부르지 않는다. */
async function wing28Batch(ids) {
  const list = (ids || []).map((v) => String(v || "").trim()).filter((v) => /^\d{5,}$/.test(v));
  const out = {};
  let needsWing = false, needsLogin = false;
  for (let i = 0; i < list.length; i++) {
    const r = await wing28(list[i]);
    if (r.ok && r.data) out[list[i]] = r.data;
    else {
      if (r.needsWing) { needsWing = true; break; }
      if (r.needsLogin) { needsLogin = true; break; }
    }
    if (i < list.length - 1) await sleep(WING_GAP_MS);
  }
  return { ok: !needsWing && !needsLogin, needsWing, needsLogin, data: { stats: out, read: Object.keys(out).length },
           error: needsWing ? "쿠팡 윙 탭이 없습니다." : (needsLogin ? "윙에 로그인되어 있지 않습니다." : "") };
}

/* 쿠팡 화면에 값을 덧씌울지 여부 */
async function overlayPref(on) {
  if (on === undefined || on === null) {
    const got = await chrome.storage.local.get("spOverlay");
    return { ok: true, data: { on: got.spOverlay !== false } };
  }
  await chrome.storage.local.set({ spOverlay: !!on });
  return { ok: true, data: { on: !!on } };
}

/* =====================================================================
   1688 이미지 검색 — 쿠팡 썸네일을 그대로 넣어 같은 물건을 찾는다
   ===================================================================== */
/* 1688 첫 화면의 검색창에 이미지 검색 버튼이 있고, 붙여넣기로도 검색이 된다.
   탭은 항상 하나만 연다. 여러 개를 열면 예전 검색 결과를 읽어 엉뚱한 상품이 들어온다. */
const IMAGE_SEARCH_URL = "https://www.1688.com/";
const LOGIN_1688_URL = "https://login.1688.com/member/signin.htm";

/* 요청을 보낸 소싱 프로 탭과, 우리가 연 1688 로그인 탭 */
let appTabId = null;
let loginTabId = null;
async function rememberTabs() {
  try { await chrome.storage.session.set({ "sp.appTab": appTabId, "sp.loginTab": loginTabId }); } catch (e) {}
}
async function recallTabs() {
  if (appTabId != null) return;
  try {
    const o = await chrome.storage.session.get(["sp.appTab", "sp.loginTab"]);
    if (o["sp.appTab"] != null) appTabId = o["sp.appTab"];
    if (o["sp.loginTab"] != null) loginTabId = o["sp.loginTab"];
  } catch (e) {}
}

/* 일이 끝나면 보던 화면으로 되돌려 준다. 1688 탭에 남겨두지 않는다. */
async function backToApp(closeLogin) {
  await recallTabs();
  if (closeLogin && loginTabId != null) {
    try { await chrome.tabs.remove(loginTabId); } catch (e) { /* 이미 닫힘 */ }
    loginTabId = null;
    await rememberTabs();
  }
  if (appTabId == null) return { ok: false, error: "돌아갈 소싱 프로 탭을 찾지 못했습니다." };
  try {
    const tab = await chrome.tabs.get(appTabId);
    await chrome.tabs.update(appTabId, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "소싱 프로 탭이 닫혀 있습니다." };
  }
}

/* =====================================================================
   1688 로그인 확인 — 쿠키만 읽는다. 탭을 열지 않아 즉시 끝난다.
   로그인하면 1688 이 __cn_logon__ 과 __cn_logon_id__ 를 심는다.
   쿠키를 읽을 수 없으면 판단을 미루고(null) 수집을 막지 않는다.
   ===================================================================== */
function readCookies(domain) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ domain: domain }, (list) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(list || []);
      });
    } catch (e) { resolve(null); }
  });
}
async function login1688Status() {
  if (!chrome.cookies) return { ok: true, data: { loggedIn: null, who: "" } };
  const list = await readCookies("1688.com");
  if (!list) return { ok: true, data: { loggedIn: null, who: "" } };

  const pick = (name) => {
    const hit = list.find((c) => c.name === name && c.value);
    return hit ? decodeURIComponent(hit.value) : "";
  };
  const flag = pick("__cn_logon__");
  const nick = pick("__cn_logon_id__") || pick("_nk_") || pick("tracknick") || pick("lgc");
  const unb = pick("unb");

  if (flag === "true") return { ok: true, data: { loggedIn: true, who: nick } };
  if (flag === "false" && !nick) return { ok: true, data: { loggedIn: false, who: "" } };
  if (nick || unb) return { ok: true, data: { loggedIn: true, who: nick } };
  return { ok: true, data: { loggedIn: false, who: "" } };
}

/* 일이 끝나면 1688 탭을 모두 닫는다. 소싱 프로 화면만 남긴다.
   직접 마무리하시라고 남겨둔 탭은 keepAssisted 일 때 건드리지 않는다. */
async function closeAll1688(keepAssisted) {
  const keep = keepAssisted ? await getAssistedTab() : null;
  let closed = 0;
  let list = [];
  try {
    list = await chrome.tabs.query({ url: ["*://*.1688.com/*", "*://*.alibaba.com/*"] });
  } catch (e) { list = []; }
  for (const t of list) {
    if (!t || t.id == null) continue;
    if (keep != null && t.id === keep) continue;
    try {
      await chrome.tabs.remove(t.id);
      closed++;
      openedTabs.delete(t.id);
    } catch (e) { /* 이미 닫힘 */ }
  }
  await saveTracked();
  if (keep == null) {
    assistedTabId = null;
    try { await chrome.storage.session.remove("sp.assistedTab"); } catch (e) {}
  }
  if (keep == null) await parkSideWindow();
  await backToApp(false);
  return { ok: true, data: { closed: closed } };
}

/* 뒤에 열어둔 1688 탭을 앞으로 꺼낸다. 사용자가 직접 누를 때만 부른다. */
async function focus1688Tab() {
  const id = await getAssistedTab();
  if (id == null) return { ok: false, error: "열어둔 1688 탭이 없습니다." };
  try {
    const tab = await chrome.tabs.get(id);
    await chrome.tabs.update(id, { active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    return { ok: true, data: { tabId: id } };
  } catch (e) {
    await dropAssistedTab(false);
    return { ok: false, error: "1688 탭이 이미 닫혔습니다." };
  }
}

/* 로그인 화면을 눈에 보이게 띄운다. 로그인은 사용자가 직접 한다. */
async function login1688Open() {
  try {
    const tab = await chrome.tabs.create({ url: LOGIN_1688_URL, active: true });
    loginTabId = tab.id;
    await rememberTabs();
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    return { ok: true, data: { tabId: tab.id } };
  } catch (e) {
    return { ok: false, error: "1688 로그인 화면을 열지 못했습니다." };
  }
}

/* 직접 마무리하시라고 남겨둔 탭. 결과는 오직 이 탭에서만 읽는다. */
let assistedTabId = null;
async function setAssistedTab(id) {
  assistedTabId = id;
  try { await chrome.storage.session.set({ "sp.assistedTab": id }); } catch (e) {}
}
async function getAssistedTab() {
  if (assistedTabId != null) return assistedTabId;
  try {
    const o = await chrome.storage.session.get("sp.assistedTab");
    assistedTabId = o["sp.assistedTab"] != null ? o["sp.assistedTab"] : null;
  } catch (e) { assistedTabId = null; }
  return assistedTabId;
}
async function dropAssistedTab(close) {
  const id = await getAssistedTab();
  if (id != null && close) { try { await chrome.tabs.remove(id); } catch (e) {} }
  assistedTabId = null;
  try { await chrome.storage.session.remove("sp.assistedTab"); } catch (e) {}
}

/* 1688 첫 화면에서 사람이 하는 그대로 밟는다.
   브라우저로 직접 확인한 순서다.
   1) input[type=file].image-file-reader-wrapper 에 사진을 넣는다
   2) 오른쪽에 "같은 스타일을 찾아드립니다" 패널이 뜬다
   3) 그 안의 .copy-image-container .search-btn 을 누른다
   4) 결과가 새 탭에서 열린다 */
function uploadTheKnownWay(dataUrl) {
  function toFile(u) {
    var parts = String(u).split(",");
    var mime = (parts[0].match(/data:([^;]+)/) || [, "image/jpeg"])[1];
    var bin = atob(parts[1] || "");
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], "search.jpg", { type: mime });
  }
  function waitFor(find, ms) {
    return new Promise(function (done) {
      var spent = 0;
      (function tick() {
        var el = null;
        try { el = find(); } catch (e) { el = null; }
        if (el) return done(el);
        spent += 300;
        if (spent >= ms) return done(null);
        setTimeout(tick, 300);
      })();
    });
  }

  return (async function () {
    var file;
    try { file = toFile(dataUrl); }
    catch (e) { return { ok: false, step: "file", error: "사진을 파일로 바꾸지 못했습니다." }; }

    var input = await waitFor(function () {
      return document.querySelector('input[type="file"].image-file-reader-wrapper') ||
             document.querySelector('input[type="file"][accept*="jpg"]') ||
             document.querySelector('input[type="file"][accept*="image"]');
    }, 12000);
    if (!input) return { ok: false, step: "input", error: "사진 넣을 칸을 찾지 못했습니다." };

    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      return { ok: false, step: "set", error: "사진을 칸에 넣지 못했습니다: " + (e && e.message ? e.message : e) };
    }

    var btn = await waitFor(function () {
      return document.querySelector(".copy-image-container .search-btn");
    }, 12000);
    if (!btn) {
      var up = /업로드\s*완료|上传完成/.test(document.body ? document.body.innerText || "" : "");
      return { ok: false, step: up ? "button" : "upload",
               error: up ? "검색 버튼을 찾지 못했습니다." : "사진이 올라가지 않았습니다." };
    }

    try {
      btn.scrollIntoView({ block: "center" });
      btn.click();
    } catch (e) {
      return { ok: false, step: "click", error: "검색 버튼을 누르지 못했습니다." };
    }
    return { ok: true, step: "clicked" };
  })();
}

/* 이 함수는 1688 페이지 안에서 실행된다. 파일 칸에 넣기, 끌어다 놓기, 붙여넣기를 차례로 시도한다. */
function putImageIntoSearch(dataUrl, opts) {
  function toFile(u) {
    var parts = String(u).split(",");
    var mime = (parts[0].match(/data:([^;]+)/) || [, "image/jpeg"])[1];
    var bin = atob(parts[1] || "");
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], "search.jpg", { type: mime });
  }
  function makeDT(file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }
  function inputs() {
    var all = Array.prototype.filter.call(
      document.querySelectorAll('input[type="file"]'),
      function (el) { return !el.disabled; }
    );
    /* 1688 첫 화면의 이미지 검색 칸은 이 클래스를 쓴다. 확인하고 넣은 값이다. */
    var known = [];
    var rest = [];
    for (var i = 0; i < all.length; i++) {
      var cls = String(all[i].className || "");
      var acc = String(all[i].getAttribute("accept") || "");
      if (/image-file-reader/i.test(cls) || /jpg|jpeg|png|image/i.test(acc)) known.push(all[i]);
      else rest.push(all[i]);
    }
    return known.concat(rest);
  }
  var TRIGGERS = [
    '[class*="camera"]', '[class*="Camera"]', '[class*="photo"]', '[class*="Photo"]',
    '[class*="image-search"]', '[class*="imageSearch"]', '[class*="img-search"]',
    '[class*="imgSearch"]', '[class*="picSearch"]', '[class*="pic-search"]',
    '[class*="upload"]', '[class*="Upload"]', '[class*="drag"]', '[class*="drop"]',
    '[title*="图片"]', '[aria-label*="图片"]', '[data-spm*="img"]', '[data-spm*="pic"]'
  ];
  /* 숨어 있는 업로드 칸이 드러나도록 마우스만 올려본다.
     여기서 클릭하면 윈도우 파일 선택창이 떠서 화면을 막으므로 누르지 않는다. */
  function poke() {
    for (var i = 0; i < TRIGGERS.length; i++) {
      var els = document.querySelectorAll(TRIGGERS[i]);
      for (var j = 0; j < els.length && j < 4; j++) {
        try {
          els[j].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          els[j].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        } catch (e) { /* 반응하지 않는 요소는 넘어간다 */ }
      }
    }
  }
  function dropOn(file) {
    var zones = [];
    for (var i = 0; i < TRIGGERS.length; i++) {
      var el = document.querySelector(TRIGGERS[i]);
      if (el) zones.push(el);
    }
    zones.push(document.body);
    for (var z = 0; z < zones.length; z++) {
      try {
        var dt = makeDT(file);
        ["dragenter", "dragover", "drop"].forEach(function (t) {
          zones[z].dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
      } catch (e) { /* DragEvent 를 막는 경우 */ }
    }
  }
  /* 1688 안내대로 붙여넣기로 이미지 검색을 건다.
     ClipboardEvent 생성자에 clipboardData 를 넘겨도 무시되므로 직접 심어야 한다. */
  function pasteIn(file) {
    function makeEvent() {
      var dt = makeDT(file);
      var ev;
      try {
        ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      } catch (e) {
        ev = document.createEvent("Event");
        ev.initEvent("paste", true, true);
      }
      try {
        Object.defineProperty(ev, "clipboardData", { value: dt, configurable: true });
      } catch (e) { /* 못 심으면 그냥 보낸다 */ }
      return ev;
    }
    var box = document.querySelector(
      'input[name="keywords"], #alisearch-keywords, input[placeholder*="搜索"], ' +
      'input[type="search"], form[action*="search"] input[type="text"]'
    );
    var targets = [];
    if (box) { try { box.focus(); } catch (e) {} targets.push(box); }
    var camera = findImageSearchButton();
    if (camera) targets.push(camera);
    targets.push(document.body, document.documentElement, document);
    for (var i = 0; i < targets.length; i++) {
      try { targets[i].dispatchEvent(makeEvent()); } catch (e) { /* 다음 대상으로 */ }
    }
  }

  /* 사진이 올라가면 "업로드 완료" 패널이 뜬다. 그 안의 이미지 검색 버튼을 눌러야 실제로 검색된다.
     검색창 옆의 같은 이름 버튼은 파일 선택창을 여니 절대 누르면 안 된다. */
  /* 그림자 DOM 안에 있는 경우까지 훑는다 */
  function deepAll(sel) {
    var out = [];
    (function walk(root, depth) {
      if (!root || depth > 6 || out.length > 8000) return;
      try {
        var found = root.querySelectorAll(sel);
        for (var i = 0; i < found.length; i++) out.push(found[i]);
        var all = root.querySelectorAll("*");
        for (var j = 0; j < all.length && j < 4000; j++) {
          if (all[j].shadowRoot) walk(all[j].shadowRoot, depth + 1);
        }
      } catch (e) { /* 접근이 막힌 뿌리는 건너뛴다 */ }
    })(document, 0);
    return out;
  }

  function panelSearchButton() {
    var LABELS = ["이미지 검색", "이미지검색", "以图搜款", "以图搜图", "图片搜索", "搜索", "검색"];
    var MARK = /(업로드\s*완료|비슷한\s*제품|같은\s*스타일|上传完成|相似款|同款)/;
    var conts = deepAll("div, section, aside, form");
    for (var i = 0; i < conts.length; i++) {
      var el = conts[i];
      var t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 4 || t.length > 300) continue;
      if (!MARK.test(t)) continue;
      var cands = el.querySelectorAll('button, a, [role="button"], span, div, em, i');
      for (var j = 0; j < cands.length; j++) {
        var ct = (cands[j].textContent || "").replace(/\s+/g, " ").trim();
        if (ct.length <= 10 && LABELS.indexOf(ct) >= 0) {
          if (cands[j].querySelector("input[type='file']")) continue;   // 파일 선택창을 여는 버튼은 제외
          return (cands[j].closest && cands[j].closest('button, a, [role="button"]')) || cands[j];
        }
      }
    }
    return null;
  }

  /* 검색창 옆의 이미지 검색 버튼을 글자로 찾는다 */
  function findImageSearchButton() {
    var LABELS = ["이미지 검색", "이미지검색", "以图搜款", "以图搜图", "图片搜索", "Image Search"];
    var nodes = document.querySelectorAll("button, a, span, div, i");
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var t = (nodes[i].textContent || "").trim();
      if (t.length > 14) continue;
      for (var j = 0; j < LABELS.length; j++) {
        if (t === LABELS[j] || (t.length <= 14 && t.indexOf(LABELS[j]) >= 0)) {
          return (nodes[i].closest && nodes[i].closest('button, a, [role="button"]')) || nodes[i];
        }
      }
    }
    return null;
  }

  /* 자동으로 안 되면 화면 구석에 사진을 띄워, 직접 끌어다 놓거나 내려받을 수 있게 한다 */
  function showHelper(url) {
    if (document.getElementById("__sp_helper")) return;
    var box = document.createElement("div");
    box.id = "__sp_helper";
    box.style.cssText = [
      "position:fixed", "right:18px", "top:18px", "z-index:2147483647",
      "background:#fff", "border:2px solid #12a58c", "border-radius:14px",
      "padding:14px", "width:226px", "box-shadow:0 14px 36px rgba(0,0,0,.28)",
      "font-family:'Malgun Gothic',sans-serif", "color:#1f2937"
    ].join(";");
    box.innerHTML =
      '<div style="font-size:12.5px;font-weight:800;color:#123c34;margin-bottom:9px;">SOURCING PRO</div>' +
      '<img id="__sp_img" alt="" draggable="true" style="width:100%;border-radius:10px;display:block;cursor:grab;background:#f4f6f8;">' +
      '<a id="__sp_dl" download="sourcing.jpg" style="display:block;margin-top:9px;text-align:center;background:#12a58c;color:#fff;' +
      'border-radius:9px;padding:8px 0;font-size:11.5px;font-weight:700;text-decoration:none;">사진 내려받기</a>' +
      '<div style="margin-top:9px;font-size:11px;line-height:1.6;color:#5b6472;">' +
      '검색창의 카메라 아이콘을 눌러 이 사진을 올려주세요. 결과가 뜨면 Sourcing Pro 에서 ' +
      '<b>열린 1688 결과 가져오기</b> 를 누르시면 됩니다.</div>' +
      '<button id="__sp_x" style="position:absolute;right:8px;top:8px;border:none;background:none;cursor:pointer;' +
      'font-size:14px;color:#b6bec7;line-height:1;">×</button>';
    document.documentElement.appendChild(box);
    var img = box.querySelector("#__sp_img");
    var dl = box.querySelector("#__sp_dl");
    img.src = url;
    dl.href = url;
    box.querySelector("#__sp_x").onclick = function () { box.remove(); };
  }

  return new Promise(function (resolve) {
    var file;
    try { file = toFile(dataUrl); }
    catch (e) { return resolve({ ok: false, error: "이미지를 파일로 바꾸지 못했습니다." }); }

    function fillInputs(list) {
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].files = makeDT(file).files;
          list[i].dispatchEvent(new Event("input", { bubbles: true }));
          list[i].dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) { /* 다음 칸으로 */ }
      }
    }

    /* 사진을 넣는다. 숨어 있는 파일 칸이 있으면 그쪽, 없으면 붙여넣기. */
    var filled = false;
    var ready = inputs();
    if (ready.length) {
      fillInputs(ready);
      filled = true;
    } else {
      pasteIn(file);
      dropOn(file);
    }

    /* 여기서 끝내면 안 된다. 업로드가 끝나면 뜨는 패널의 검색 버튼까지 눌러야 결과가 나온다. */
    var waited = 0;
    (function watch() {
      var run = panelSearchButton();
      if (run) {
        try {
          run.scrollIntoView({ block: "center" });
          run.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          run.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          run.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          run.click();
        } catch (e) { /* 못 누르면 아래로 */ }
        return resolve({ ok: true, how: "clicked", inputs: filled ? 1 : 0 });
      }
      if (!filled) {
        var late = inputs();
        if (late.length) { fillInputs(late); filled = true; }
      }
      waited += 700;
      if (waited < 14000) {
        if (waited === 2800 || waited === 7000) { poke(); if (!filled) pasteIn(file); }
        return setTimeout(watch, 700);
      }
      if (filled) return resolve({ ok: true, how: "file-late", inputs: 1 });
      if (window.top === window && opts && opts.helper) showHelper(dataUrl);
      resolve({ ok: true, how: "manual", inputs: 0 });
    })();
  });
}

/* 1688은 이미지 검색 버튼을 두 번 눌러야 한다.
   처음 누르면 업로드가 확정되고, 다음 화면에서 한 번 더 눌러야 결과가 나온다.
   이 함수는 페이지 안에서 실행되며, 지금 화면에 그 버튼이 있으면 눌러준다. */
function clickPanelSearch() {
  function deepAll(sel) {
    var out = [];
    (function walk(root, depth) {
      if (!root || depth > 6 || out.length > 8000) return;
      try {
        var found = root.querySelectorAll(sel);
        for (var i = 0; i < found.length; i++) out.push(found[i]);
        var all = root.querySelectorAll("*");
        for (var j = 0; j < all.length && j < 4000; j++) {
          if (all[j].shadowRoot) walk(all[j].shadowRoot, depth + 1);
        }
      } catch (e) { /* 접근이 막힌 뿌리는 건너뛴다 */ }
    })(document, 0);
    return out;
  }
  /* 사이트가 어떤 이벤트를 듣는지 알 수 없어 눌리는 순서 전체를 보낸다 */
  function pressHard(el) {
    var ok = false;
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    try { if (el.focus) el.focus(); } catch (e) {}
    var r = { clientX: 0, clientY: 0 };
    try {
      var b = el.getBoundingClientRect();
      r.clientX = Math.round(b.left + b.width / 2);
      r.clientY = Math.round(b.top + b.height / 2);
    } catch (e) {}
    var opts = { bubbles: true, cancelable: true, composed: true, view: window,
                 clientX: r.clientX, clientY: r.clientY, button: 0 };
    ["pointerover", "pointerenter", "pointerdown", "pointerup"].forEach(function (t) {
      try { el.dispatchEvent(new PointerEvent(t, Object.assign({ pointerId: 1, isPrimary: true }, opts))); ok = true; }
      catch (e) { /* 지원하지 않으면 넘어간다 */ }
    });
    ["mouseover", "mouseenter", "mousedown", "mouseup", "click"].forEach(function (t) {
      try { el.dispatchEvent(new MouseEvent(t, opts)); ok = true; } catch (e) {}
    });
    try { el.click(); ok = true; } catch (e) {}
    return ok;
  }

  /* 1688 화면을 직접 열어 확인한 자리부터 누른다.
     사진을 올리면 오른쪽에 "같은 스타일을 찾아드립니다" 패널이 뜨고,
     그 안의 .copy-image-container .search-btn 이 진짜 검색 버튼이다.
     누르면 결과가 새 탭에서 열린다. */
  /* 이미 결과 화면이면 다시 누르지 않는다. 누르면 탭만 늘어난다. */
  if (/pc-image-search|imageSearch/i.test(location.href)) {
    return { clicked: false, panels: 0, hits: 0, pressed: 0, via: "onResults" };
  }

  var known = document.querySelector(".copy-image-container .search-btn");
  if (known) {
    var okKnown = pressHard(known);
    if (okKnown) return { clicked: true, panels: 1, hits: 1, pressed: 1, via: "known" };
  }

  /* 반드시 이미지 검색을 가리키는 말만 쓴다.
     "검색" 하나만 넣으면 검색창 옆의 일반 검색 버튼이 걸려 빈 검색이 실행된다. */
  var LABELS = ["이미지 검색", "이미지검색", "以图搜款", "以图搜图", "图片搜索"];
  var MARK = /(업로드\s*완료|비슷한\s*제품|같은\s*스타일|上传完成|相似款|同款)/;
  /* 검색창 줄에는 대량 검색이 함께 있다. 그 줄은 패널이 아니다. */
  var HEADER = /(대량\s*검색|批量|공장\s*찾기|공업제품)/;

  var conts = deepAll("div, section, aside, form").filter(function (el) {
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return t.length >= 4 && t.length <= 300 && MARK.test(t) && !HEADER.test(t);
  });
  /* 가장 좁은 상자가 진짜 패널이다 */
  conts.sort(function (a, b) {
    return (a.textContent || "").length - (b.textContent || "").length;
  });

  var panels = conts.length, hits = 0;
  for (var i = 0; i < conts.length; i++) {
    var el = conts[i];
    var cands = el.querySelectorAll('button, a, [role="button"], span, div, em, i');
    for (var j = 0; j < cands.length; j++) {
      var ct = (cands[j].textContent || "").replace(/\s+/g, " ").trim();
      if (ct.length > 10 || LABELS.indexOf(ct) < 0) continue;
      hits++;
      var btn = (cands[j].closest && cands[j].closest('button, a, [role="button"]')) || cands[j];
      /* 새 탭으로 열리는 링크면 같은 탭에서 열리도록 바꾼다. 안 그러면 누를 때마다 탭이 늘어난다. */
      try { if (btn.getAttribute && btn.getAttribute("target")) btn.removeAttribute("target"); } catch (e) {}

      /* 진짜 주소를 가진 링크면 클릭 대신 그 주소로 바로 이동한다. 가장 확실하다. */
      var href = "";
      try { href = (btn.tagName === "A" && btn.getAttribute("href")) || ""; } catch (e) {}
      if (href && !/^javascript:|^#/i.test(href)) {
        try {
          location.assign(new URL(href, location.href).href);
          return { clicked: true, panels: panels, hits: hits, pressed: 1, how: "nav", url: location.href };
        } catch (e) { /* 이동이 막히면 눌러본다 */ }
      }

      /* 딱 한 번만 누르고 끝낸다 */
      var ok = pressHard(btn);
      return { clicked: ok, panels: panels, hits: hits, pressed: ok ? 1 : 0, how: "click", url: location.href };
    }
  }
  return { clicked: false, panels: panels, hits: hits, pressed: 0, url: location.href };
}

/* 검색창에 직접 입력해 검색한다. 주소로 검색어를 넘기면 1688이 옛 인코딩을 요구해 엉뚱한 결과가 나온다. */
function typeAndSearch(keyword) {
  function findBox() {
    var sels = [
      'input[name="keywords"]', "#alisearch-keywords", "#home-header-searchbox",
      'input[placeholder*="搜索"]', 'input[placeholder*="产品"]',
      'form[action*="search"] input[type="text"]',
      'input[type="search"]', 'input[type="text"]'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && el.offsetParent !== null) return el;
    }
    return document.querySelector('input[type="text"]');
  }
  return new Promise(function (resolve) {
    var box = findBox();
    if (!box) return resolve({ ok: false, error: "1688 검색창을 찾지 못했습니다." });
    try {
      box.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(box, keyword);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      box.value = keyword;
    }
    setTimeout(function () {
      var form = box.form || (box.closest ? box.closest("form") : null);
      var btn = document.querySelector('[class*="search-button"], [class*="searchButton"], button[type="submit"], [class*="btn-search"]');
      try {
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13, which: 13 }));
      } catch (e) {}
      if (btn && btn.click) { try { btn.click(); } catch (e) {} }
      else if (form) { try { form.submit(); } catch (e) {} }
      resolve({ ok: true });
    }, 400);
  });
}

async function imageSearchOnce(entryUrl, dataUrl, want, opts) {
  const o = opts || {};
  let tabId = null;
  let keepTab = false;

  /* 1688이 스스로 새 탭을 여는 경우가 있다. 그 탭을 따라가고 나머지는 바로 닫는다. */
  const spawned = [];
  const onCreated = (t) => {
    if (t && t.id !== tabId) {
      spawned.push(t.id);
      openedTabs.add(t.id);
      saveTracked();
    }
  };
  chrome.tabs.onCreated.addListener(onCreated);

  try {
    /* 1688 이미지 검색은 화면이 실제로 그려져야 돈다.
       배경 탭으로 열면 크롬이 일을 늦춰 업로드와 검색이 멈춘다.
       그렇다고 보던 탭을 갈아치우면 화면이 튄다. 그래서 옆에 창을 하나 띄운다.
       그 창은 초점을 받지 않으므로 소싱 프로 화면은 그대로 남는다. */
    const tab = await openSideTab(entryUrl);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "1688 페이지를 열지 못했습니다." };
    /* 이미지 검색 칸은 화면이 다 뜬 뒤에 붙는다. 너무 일찍 찾으면 없다. */
    await sleep(1800);

    /* 먼저 브라우저로 직접 확인한 순서를 그대로 밟는다. 본 화면에서만 한다. */
    let known = null;
    try {
      const rk = await chrome.scripting.executeScript({
        target: { tabId }, func: uploadTheKnownWay, args: [dataUrl]
      });
      known = rk && rk[0] ? rk[0].result : null;
    } catch (e) {
      known = { ok: false, step: "inject", error: String(e && e.message ? e.message : e) };
    }
    if (known && known.ok) {
      /* 눌렀으면 결과 탭이 뜬다. 아래 기다리는 자리로 바로 넘어간다. */
      await sleep(2000);
    }

    /* 이미지 검색 칸이 안쪽 프레임에 있는 경우가 있어 모든 프레임에서 시도한다 */
    let put = known && known.ok ? { ok: true, how: "clicked" } : null;
    if (!put) try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: putImageIntoSearch,
        args: [dataUrl, { helper: !!o.assist }]
      });
      const results = (r || []).map((x) => x && x.result).filter(Boolean);
      const good = ["clicked", "file", "file-late", "paste"];
      put = results.find((x) => x.ok && good.indexOf(x.how) >= 0) ||
            results.find((x) => x.ok) || results[0] || null;
    } catch (e) {
      return { ok: false, error: "이미지 검색을 시작하지 못했습니다: " + (e && e.message ? e.message : e) };
    }
    if (!put || !put.ok) {
      var why = (known && known.error ? known.error + " (" + known.step + ")" : "") ||
                (put && put.error) || "1688 이미지 검색 칸을 찾지 못했습니다.";
      return { ok: false, error: why };
    }
    /* 자동 업로드가 안 되어 안내만 띄운 경우, 탭을 남겨 직접 올리시게 한다 */
    if (o.assist && put.how === "manual") {
      keepTab = true;
      await setAssistedTab(tabId);
      return {
        ok: false, assisted: true, tabId: tabId,
        error: "1688 이미지 검색 칸이 자동으로 열리지 않았습니다. 1688 탭에 사진을 올려두었으니 그 탭에서 검색을 눌러주세요."
      };
    }

    /* 1688은 이미지 검색 버튼을 두 번 눌러야 결과가 나온다.
       결과가 빌 때마다 화면에 남아 있는 검색 버튼을 다시 눌러가며 기다린다. */
    const deadline = Date.now() + (o.budgetMs || IMG_BUDGET_MS);
    let clicks = 0;
    let diag = { panels: 0, hits: 0, pressed: 0, cards: 0 };
    let cur = tabId;

    /* 1688이 새 탭을 열었으면 가장 최근 것만 남기고 그리로 옮겨탄다 */
    const adopt = async () => {
      if (!spawned.length) return;
      const newest = spawned[spawned.length - 1];
      for (const id of spawned) { if (id !== newest) await closeWorkTab(id); }
      spawned.length = 0;
      if (newest !== cur) {
        const old = cur;
        cur = newest;
        tabId = cur;
        await closeWorkTab(old);
        await waitForLoad(cur);
      }
    };

    while (Date.now() < deadline) {
      await sleep(IMG_POLL_MS);
      await adopt();
      await waitForLoad(cur);

      /* 홈 화면의 추천 목록을 결과로 착각하지 않도록, 검색 결과 주소일 때만 읽는다 */
      let onResults = false;
      try {
        const t = await chrome.tabs.get(cur);
        const u = (t && t.url) || "";
        onResults = !/^https?:\/\/(www\.)?1688\.com\/?(\?|#|$)/i.test(u) &&
          /1688\.com/i.test(u);
      } catch (e) { onResults = false; }

      if (onResults) {
        const read = await readOffersEverywhere(cur, want);
        if (read.items.length) {
          tabId = cur;
          return { ok: true, items: read.items, clicks };
        }
        diag.cards = read.diag && read.diag.cards ? read.diag.cards : diag.cards;
      }
      /* 아직 비어 있으면 다음 단계 버튼을 한 번만 더 누른다.
         패널이 안쪽 프레임에 있을 수 있어 모든 프레임에서 찾되, 프레임마다 한 번만 누른다. */
      if (clicks < 3) {
        try {
          const r2 = await chrome.scripting.executeScript({
            target: { tabId: cur, allFrames: true }, func: clickPanelSearch
          });
          const infos = (r2 || []).map((x) => x && x.result).filter(Boolean);
          let did = false;
          for (const info of infos) {
            diag = {
              panels: diag.panels + (info.panels || 0),
              hits: diag.hits + (info.hits || 0),
              pressed: diag.pressed + (info.pressed || 0)
            };
            if (info.clicked) did = true;
          }
          if (did) {
        clicks++;
        /* 누른 뒤에는 결과 탭이 뜰 때까지 조금 더 기다린다 */
        await sleep(IMG_CLICK_WAIT_MS + 900);
      }
        } catch (e) { /* 이동 중이면 다음 회차에 */ }
      }
    }
    tabId = cur;
    if (o.assist) {
      keepTab = true;
      await setAssistedTab(tabId);
      return {
        ok: false, assisted: true, tabId: tabId,
        error: "1688 탭을 뒤에 열어두었습니다. 그 탭에서 이미지 검색을 눌러 상품 목록을 띄운 뒤 결과를 가져오세요. " +
          "(검색 패널 " + diag.panels + "곳, 버튼 후보 " + diag.hits + "개, 누름 " + diag.pressed + "회, 상품 카드 " + diag.cards + "개)"
      };
    }
    return {
      ok: false,
      error: "이미지 검색 결과가 나오지 않았습니다. (검색 패널 " + diag.panels +
        "곳, 버튼 후보 " + diag.hits + "개, 누름 " + diag.pressed + "회, 상품 카드 " + diag.cards + "개)"
    };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
    /* 곁가지로 열린 탭은 모두 닫는다 */
    for (const id of spawned) { if (id !== tabId) await closeWorkTab(id); }
    if (!keepTab) await closeWorkTab(tabId);
    else { openedTabs.delete(tabId); await saveTracked(); }
  }
}

/* 1688 결과 화면의 상품 카드를 읽는다. 페이지 안에서 실행된다.
   air.1688.com 한국어판은 카드가 링크가 아니라 일반 요소라서, 링크로 찾으면 하나도 못 읽는다.
   그래서 "그림과 ¥가격을 함께 가진 가장 안쪽 상자"를 카드로 본다. */
function collect1688Offers(want) {
  function deepAll(sel) {
    var out = [];
    (function walk(root, depth) {
      if (!root || depth > 5 || out.length > 12000) return;
      try {
        var f = root.querySelectorAll(sel);
        for (var i = 0; i < f.length; i++) out.push(f[i]);
        var all = root.querySelectorAll("*");
        for (var j = 0; j < all.length && j < 6000; j++) {
          if (all[j].shadowRoot) walk(all[j].shadowRoot, depth + 1);
        }
      } catch (e) {}
    })(document, 0);
    return out;
  }
  function txt(el) { return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : ""; }
  function toNum(s) {
    var m = String(s == null ? "" : s).replace(/,/g, "").match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return String(u || ""); } }
  function offerIdOf(h) {
    h = String(h || "");
    /* 상품 번호는 offer/ 뒤나 offerId= 뒤에만 있다.
       예전에는 주소 안의 아무 긴 숫자나 집어서 광고 추적 번호로 없는 주소를 만들었다. */
    var m = h.match(/\/offer\/(\d{6,})/) || h.match(/[?&]offer_?id=(\d{6,})/i);
    return m ? m[1] : "";
  }
  function expandAli(u) {
    return String(u)
      .replace(/\.(summ|search|preview)\.jpg$/i, "")
      .replace(/_\d{2,4}x\d{2,4}(xz)?(q\d+)?\.(jpg|jpeg|png|webp)$/i, "")
      .replace(/_\.webp$/i, "");
  }

  var PRICE = /[¥￥]\s*[0-9]/;
  var nodes = deepAll("div, li, a, section, article");
  var cands = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var t = txt(el);
    if (t.length < 4 || t.length > 400) continue;
    if (!PRICE.test(t)) continue;
    try { if (!el.querySelector("img")) continue; } catch (e) { continue; }
    cands.push(el);
  }
  /* 가장 안쪽 상자만 남긴다 */
  cands.sort(function (a, b) { return txt(a).length - txt(b).length; });
  var kept = [];
  for (var k = 0; k < cands.length && kept.length < 200; k++) {
    var c = cands[k];
    var wraps = false;
    for (var m2 = 0; m2 < kept.length; m2++) {
      if (c.contains(kept[m2])) { wraps = true; break; }
    }
    if (!wraps) kept.push(c);
  }
  /* 화면에 놓인 순서대로 되돌린다 */
  kept.sort(function (a, b) {
    var p = a.compareDocumentPosition(b);
    return (p & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  var out = [];
  var seen = [];
  for (var n = 0; n < kept.length && out.length < (want || 20); n++) {
    var card = kept[n];
    var ct = txt(card);

    var prices = (ct.match(/[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]+)?/g) || [])
      .map(function (s) { return toNum(s.replace(/[¥￥]/g, "")); })
      .filter(function (v) { return v > 0 && v < 1000000; });
    if (!prices.length) continue;
    var price = Math.min.apply(null, prices);

    var img = card.querySelector("img[alt]") || card.querySelector("img");
    var name = img ? String(img.getAttribute("alt") || "").trim() : "";
    if (name.length < 3) {
      var tn = card.querySelector('[class*="title"], [class*="Title"], [class*="name"], [class*="Name"], [class*="subject"]');
      name = txt(tn);
    }
    if (name.length < 3) name = ct.replace(/[¥￥][\d.,]+/g, " ").trim().slice(0, 60);

    /* 상품 번호를 링크나 속성 어디서든 찾아본다. 못 찾아도 버리지 않는다. */
    var id = "";
    var url = "";
    var a = card.querySelector("a[href]") || (card.closest ? card.closest("a[href]") : null);
    if (a) {
      var href = a.getAttribute("href") || "";
      id = offerIdOf(href);
      if (id) url = abs(href);
      else if (/1688\.com/i.test(abs(href))) url = abs(href);
    }
    if (!id) {
      /* 1688 검색 결과는 카드를 감싼 칸에 상품 번호를 심어둔다.
         예: data-offer-expose-id="1074029878506", data-renderkey="1_59_p4p_1074029878506"
         카드에서 위로 여덟 단계까지 훑는다. */
      var probe = [card];
      var up = card.parentElement;
      for (var g = 0; g < 8 && up; g++) { probe.push(up); up = up.parentElement; }
      probe = probe.concat(Array.prototype.slice.call(card.querySelectorAll("*")).slice(0, 200));
      for (var q = 0; q < probe.length && !id; q++) {
        var at = probe[q].attributes;
        if (!at) continue;
        for (var r = 0; r < at.length; r++) {
          var nm = at[r].name;
          if (nm === "class" || nm === "style" || nm === "src" || nm === "srcset" || nm === "alt") continue;
          var val = String(at[r].value || "");
          var got = offerIdOf(val);
          /* 아무 긴 숫자나 상품 번호로 쓰면 없는 주소가 만들어져 404 가 난다.
             이름이 상품 번호를 뜻하는 속성만 믿는다. */
          if (!got && /offer|renderkey|expose|itemid/i.test(nm)) {
            var dm = val.match(/(?:^|[^0-9])(\d{9,13})(?![0-9])/);
            if (dm) got = dm[1];
          }
          if (got) { id = got; break; }
        }
      }
    }
    var key = id || (name + "|" + price);
    if (seen.indexOf(key) >= 0) continue;
    seen.push(key);
    /* 1688 상품 번호는 9~13 자리다. 실제로 열어 확인했다.
       916184375338 은 상품 페이지가 열리고, 221938379856960 은 404 뒤 홈으로 튕긴다.
       그보다 긴 숫자는 광고 추적 번호이지 상품 번호가 아니다. */
    var realId = function (v) {
      return /^\d{9,13}$/.test(String(v || "")) ? String(v) : "";
    };

    /* 링크를 정하는 순서.
       1) 이미 표준 상품 주소면 그대로 쓴다. 가장 확실하다.
       2) 제대로 된 상품 번호를 캐낼 수 있으면 표준 주소로 만든다.
       3) 둘 다 안 되면 링크를 비운다. 404 로 보내는 것보다 낫다. */
    var standard = /^https?:\/\/(detail|m)\.1688\.com\/offer\/\d{9,13}\.html/i.test(url || "");
    if (!standard) {
      id = realId(id) || realId(url ? offerIdOf(url) : "");
      url = id ? "https://detail.1688.com/offer/" + id + ".html" : "";
    }

    var src = "";
    var imgs = card.querySelectorAll("img");
    for (var s = 0; s < imgs.length; s++) {
      var v = imgs[s].getAttribute("src") || imgs[s].getAttribute("data-src") ||
              imgs[s].getAttribute("data-lazy-src") || "";
      if (v && !/blank|placeholder|loading|spacer/i.test(v)) { src = abs(v); break; }
    }

    var moqm = ct.match(/(\d+)\s*[件个台双套箱条只支包]?\s*起(?:批|订)/) ||
               ct.match(/최소\s*(?:주문\s*)?수량\s*([\d,]+)/);
    var soldm = ct.match(/(?:成交|已售|销量)\s*([0-9.]+[万]?)/) ||
                ct.match(/([0-9][0-9.,]*\s*[만万]?\+?)\s*구매/);

    out.push({
      rank: out.length + 1,
      offerId: id || "",
      url: url || "",
      name: name,
      price: price,
      moq: moqm ? toNum(moqm[1]) + "개" : "",
      sold: soldm ? String(soldm[1]).trim() : "",
      image: src ? expandAli(src) : ""
    });
  }

  return {
    items: out,
    diag: { nodes: nodes.length, cards: kept.length, host: location.hostname, url: location.href }
  };
}

/* 결과가 안쪽 프레임에 그려지는 경우가 있어 모든 프레임에서 모은다 */
async function readOffersEverywhere(tabId, want) {
  let results = [];
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collect1688Offers,
      args: [want]
    });
    results = (r || []).map((x) => x && x.result).filter(Boolean);
  } catch (e) {
    return { items: [], diag: { error: String(e && e.message ? e.message : e) } };
  }
  /* 본 화면을 먼저 본다. insights 같은 곁다리 프레임은 뒤로 미룬다. */
  results.sort((a, b) => {
    const rank = (r) => (/insights|aiprice|log|stat/i.test((r.diag && r.diag.host) || "") ? 1 : 0);
    return rank(a) - rank(b);
  });

  const merged = [];
  const seen = new Set();
  let diag = { nodes: 0, cards: 0, host: "", url: "" };
  for (const res of results) {
    diag = {
      nodes: diag.nodes + (res.diag.nodes || 0),
      cards: diag.cards + (res.diag.cards || 0),
      host: diag.host || res.diag.host || "",
      url: diag.url || res.diag.url || ""
    };
    for (const it of res.items) {
      const key = it.offerId || (it.name + "|" + it.price);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  }
  merged.forEach((it, i) => { it.rank = i + 1; });
  return { items: merged.slice(0, want), diag };
}

/* 이번 검색을 위해 열어둔 그 탭에서만 읽는다.
   아무 1688 탭이나 읽으면 예전 검색 결과가 들어와 엉뚱한 상품이 채워진다. */
async function readTabOffers(tabId, want) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["scrape.js"] });
  } catch (e) { return null; }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "search1688", limit: want }, (r) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(r || null);
    });
  });
}

async function grab1688Tab(limit, withImages) {
  const want = Math.min(30, Math.max(1, limit || 20));
  await beginJob();
  try {
    const isHome = (u) => /^https?:\/\/(www\.)?1688\.com\/?(\?|#|$)/i.test(u || "");

    let id = await getAssistedTab();
    let source = "열어둔 탭";
    let title = "";

    if (id != null) {
      try { await chrome.tabs.get(id); } catch (e) { id = null; }
    }

    /* 열어둔 탭이 없으면, 열려 있는 1688 탭 중 홈 화면이 아닌 가장 최근에 본 탭을 읽는다.
       버튼은 앱 화면에서 누르므로 활성 탭 기준으로는 절대 찾을 수 없다. */
    if (id == null) {
      const tabs = (await chrome.tabs.query({ url: "*://*.1688.com/*" }))
        .filter((t) => !isHome(t.url));
      if (!tabs.length) {
        return {
          ok: false,
          error: "읽어올 1688 검색 결과 탭이 없습니다. 썸네일로 1688에서 찾기를 먼저 누르거나, 1688에서 이미지 검색을 해 상품 목록이 뜬 탭을 열어두세요."
        };
      }
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      id = tabs[0].id;
      title = tabs[0].title || "";
      source = "1688 탭";
    }

    const read = await readOffersEverywhere(id, want);
    if (!read.items.length) {
      const d = read.diag || {};
      return {
        ok: false,
        error: "그 탭에서 상품을 읽지 못했습니다. (요소 " + (d.nodes || 0) + "개 중 상품 카드 " +
          (d.cards || 0) + "개, 주소 " + (d.host || "?") + ")"
      };
    }

    const items = read.items;
    if (withImages) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 240);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    await dropAssistedTab(true);   /* 다 읽었으면 우리가 연 탭은 닫는다 */
    return { ok: true, data: { items, mode: source, url: res.data.url, title: title } };
  } catch (e) {
    return { ok: false, error: "1688 탭을 읽지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    releaseAwake();
  }
}

async function image1688(dataUrl, limit, withImages, assist) {
  const want = Math.min(30, Math.max(1, limit || 20));
  if (!dataUrl || String(dataUrl).indexOf("data:") !== 0) {
    return { ok: false, error: "검색에 쓸 썸네일이 없습니다. 쿠팡 상품을 먼저 수집해주세요." };
  }
  await beginJob();
  try {
    const finish = async (items, entry) => {
      if (withImages) {
        const thumbs = await thumbBatch(items.map((it) => it.image), 240);
        for (let k = 0; k < items.length; k++) items[k].image = thumbs[k] || "";
      }
      return { ok: true, data: { items, mode: "image", entry } };
    };

    /* 앞서 남겨둔 탭이 있으면 먼저 닫는다. 1688 탭은 항상 하나만 유지한다. */
    await dropAssistedTab(true);

    /* 탭 하나만 열어 끝까지 밀어붙인다. 안 되면 그 탭을 그대로 남겨 직접 마무리하시게 한다. */
    let r;
    try {
      const wantAssist = assist !== false;
      r = await imageSearchOnce(IMAGE_SEARCH_URL, dataUrl, want, {
        budgetMs: IMG_BUDGET_MS, assist: wantAssist
      });
    } catch (e) {
      r = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (r.ok && r.items && r.items.length) return finish(r.items, IMAGE_SEARCH_URL);
    if (r.assisted) {
      return { ok: false, assisted: true, error: r.error };
    }
    return { ok: false, error: r.error || "이미지 검색을 하지 못했습니다." };
  } catch (e) {
    return { ok: false, error: "이미지 검색에 실패했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    releaseAwake();
  }
}

/* 1688 검색으로 소싱 후보를 찾는다 */
async function search1688(keyword, limit, withImages) {
  const kw = String(keyword || "").trim();
  const want = Math.min(20, Math.max(1, limit || 5));
  if (!kw) return { ok: false, error: "중국어 검색어가 비어 있습니다." };
  await beginJob();
  let tabId = null;
  try {
    /* 검색창에 입력하는 방식은 1688 이 기획전 화면으로 튕길 때가 있어,
       그 화면의 상품을 엉뚱하게 긁어왔다.
       charset=utf8 을 붙이면 주소로 넘겨도 중국어가 깨지지 않는다. 그쪽이 확실하다. */
    const searchUrl = "https://s.1688.com/selloffer/offer_search.htm?keywords=" +
      encodeURIComponent(kw) + "&charset=utf8";
    const tab = await openSideTab(searchUrl);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "1688 검색 화면을 열지 못했습니다." };
    await sleep(1500);

    /* 검색 결과 화면이 맞는지 확인한다. 기획전이나 홈으로 튕겼으면 읽지 않는다. */
    let here = "";
    try { const t = await chrome.tabs.get(tabId); here = (t && t.url) || ""; } catch (e) { here = ""; }
    if (!/s\.1688\.com\/selloffer\/offer_search/i.test(here)) {
      return {
        ok: false,
        error: "1688 이 검색 결과 대신 다른 화면을 보여줬습니다. 잠시 뒤 다시 시도해주세요."
      };
    }

    /* 한국어판 1688 은 상품 카드가 링크가 아니라서 링크로 찾으면 하나도 못 읽는다.
       그래서 이미지 검색에 쓰던 방식, 곧 "그림과 ¥가격을 함께 가진 가장 안쪽 상자" 로 읽는다. */
    let items = [];
    let diag = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await waitForLoad(tabId);
      try {
        const t2 = await chrome.tabs.get(tabId);
        if (!/s\.1688\.com\/selloffer\/offer_search/i.test((t2 && t2.url) || "")) break;
      } catch (e) { break; }
      const read = await readOffersEverywhere(tabId, want);
      if (read.items && read.items.length) { items = read.items; break; }
      diag = read.diag || diag;
      await sleep(1200);
    }
    if (!items.length) {
      return {
        ok: false,
        error: "1688 검색 결과를 읽지 못했습니다. " +
          (diag && diag.cards ? "상품 카드 " + diag.cards + "개를 찾았으나 값을 읽지 못했습니다. "
                              : "상품 카드를 찾지 못했습니다. ") +
          "크롬에서 1688 에 먼저 로그인해보세요."
      };
    }
    if (withImages && items.length) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 240);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    return { ok: true, data: { keyword: kw, items } };
  } catch (e) {
    return { ok: false, error: "1688 검색에 실패했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    releaseAwake();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return;
  /* 어느 탭에서 온 요청인지 기억해 두었다가, 일이 끝나면 그 탭으로 되돌린다 */
  if (sender && sender.tab && sender.tab.id != null && sender.tab.id !== loginTabId &&
      !/coupang\.com|1688\.com|taobao\.com|tmall\.com|temu\.com|alibaba\.com/i.test(sender.tab.url || "")) {
    appTabId = sender.tab.id;
    rememberTabs();
  }
  if (msg.type === "backToApp") {
    backToApp(!!msg.closeLogin).then(respond);
    return true;
  }
  if (msg.type === "search1688") {
    search1688(msg.keyword, msg.limit, msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "close1688Tabs") {
    closeAll1688(!!msg.keepAssisted).then(respond);
    return true;
  }
  if (msg.type === "focus1688Tab") {
    focus1688Tab().then(respond);
    return true;
  }
  if (msg.type === "login1688Status") {
    login1688Status().then(respond);
    return true;
  }
  if (msg.type === "login1688Open") {
    login1688Open().then(respond);
    return true;
  }
  if (msg.type === "image1688") {
    image1688(msg.dataUrl, msg.limit, msg.withImages, msg.assist).then(respond);
    return true;
  }
  if (msg.type === "sweepTabs") {
    sweepTabs()
      .then(async (n) => { await closeSideWindow(); await closeWingTab(); return n; })
      .then((n) => respond({ ok: true, data: { closed: n } }));
    return true;
  }
  if (msg.type === "shopLogin") {
    shopLogin(msg.site).then(respond);
    return true;
  }
  if (msg.type === "shopLoginOpen") {
    shopLoginOpen(msg.site).then(respond);
    return true;
  }
  if (msg.type === "temuTop") {
    temuTop(msg.channel, msg.limit, msg.category, !!msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "temuOpen") {
    temuOpen(msg.channel).then(respond);
    return true;
  }
  if (msg.type === "taobaoTop") {
    taobaoTop(msg.keyword, msg.limit, !!msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "taobaoOpen") {
    taobaoOpen(msg.keyword).then(respond);
    return true;
  }
  if (msg.type === "wing28") {
    wing28(msg.productId).then(respond);
    return true;
  }
  if (msg.type === "wing28Batch") {
    wing28Batch(msg.ids).then(respond);
    return true;
  }
  if (msg.type === "wingStatus") {
    wingStatus().then(respond);
    return true;
  }
  if (msg.type === "wingOpen") {
    wingOpen().then(respond);
    return true;
  }
  if (msg.type === "overlayPref") {
    overlayPref(msg.on).then(respond);
    return true;
  }
  if (msg.type === "grab1688Tab") {
    grab1688Tab(msg.limit, msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "keyStatus") {
    creds().then((c) => respond({
      ok: true,
      data: {
        hasKey: !!(c && c.apiKey && c.secret && c.customer),
        customer: c && c.customer ? String(c.customer) : ""
      }
    }));
    return true;
  }
  if (msg.type === "openOptions") {
    try {
      chrome.runtime.openOptionsPage();
      respond({ ok: true });
    } catch (e) {
      respond({ ok: false, error: "설정 화면을 열지 못했습니다." });
    }
    return true;
  }
  if (msg.type === "keywords") {
    keywordTool(msg.seed, msg.debug).then(respond);
    return true;
  }
  if (msg.type === "partnerStatus") {
    partnerCreds().then((c) => respond({
      ok: true,
      data: {
        hasKey: !!(c && c.accessKey && c.secret),
        left: partnerRoom()
      }
    }));
    return true;
  }
  if (msg.type === "partnerSearch") {
    partnerSearch(msg.keyword, msg.limit).then(respond);
    return true;
  }
  if (msg.type === "searchCache") {
    (msg.clear ? clearSearchCache() : countSearchCache()).then(respond);
    return true;
  }
  if (msg.type === "readActiveCoupang") {
    readActiveCoupang(msg.limit).then(respond);
    return true;
  }
  if (msg.type === "offer1688Read") {
    offer1688Read(msg.tabId != null ? msg.tabId : (sender && sender.tab ? sender.tab.id : null)).then(respond);
    return true;
  }
  if (msg.type === "offer1688Download") {
    offer1688Download(msg.data, msg.kinds, msg.infoText, msg.optionCsv).then(respond);
    return true;
  }
  if (msg.type === "reviewInsightFromPage") {
    reviewInsightFromPage(msg.productId, msg.name, !!msg.force).then(respond);
    return true;
  }
  if (msg.type === "coupangReviews") {
    coupangReviews(msg.productId, msg.count).then(respond);
    return true;
  }
  if (msg.type === "catTree") {
    coupangCatTree(!!msg.force).then(respond);
    return true;
  }
  if (msg.type === "coupangOpenUrl") {
    coupangOpenUrl(msg.url).then(respond);
    return true;
  }
  if (msg.type === "coupangNextPage") {
    coupangNextPage().then(respond);
    return true;
  }
  if (msg.type === "openCoupangSearch") {
    (async () => {
      const kw = String(msg.keyword || "").trim();
      if (!kw) return respond({ ok: false, error: "키워드가 비어 있습니다." });
      try {
        const url = "https://www.coupang.com/np/search?q=" + encodeURIComponent(kw) +
          "&channel=user&listSize=36&sorter=scoreDesc";
        const tab = await chrome.tabs.create({ url, active: true });
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
        /* 이 탭을 기억해 두면, 나중에 읽기를 누를 때 곧바로 이 화면을 본다 */
        openedCoupangTab = tab.id;
        respond({ ok: true, data: { tabId: tab.id } });
      } catch (e) {
        respond({ ok: false, error: "쿠팡 검색 화면을 열지 못했습니다." });
      }
    })();
    return true;
  }
  if (msg.type === "coupangSession") {
    if (msg.open) {
      coupangSession = true;
      coupangHits = 0;
      respond({ ok: true });
    } else {
      endCoupangSession().then(respond);
    }
    return true;
  }
  if (msg.type === "coupangCooldown") {
    respond(msg.clear ? clearCoupangCooldown() : { ok: true, data: { left: coupangCooling() } });
    return true;
  }
  if (msg.type === "thumbs") {
    fetchThumbs(msg.urls, msg.size).then(respond);
    return true;
  }
  if (msg.type === "coupangTop") {
    coupangTop(msg.keyword, msg.limit, msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "fxRate") {
    fetchRate(!!msg.force).then(respond);
    return true;
  }
  if (msg.type === "collect") {
    collect(String(msg.url || "")).then(respond);
    return true;
  }
  if (msg.type === "collectActiveTab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) return respond({ ok: false, error: "현재 탭을 찾지 못했습니다." });
        if (!/(coupang\.com|1688\.com)/i.test(tab.url || "")) {
          return respond({ ok: false, error: "쿠팡 또는 1688 상품 페이지에서 눌러주세요." });
        }
        await ensureInjected(tab.id);
        let res = null;
        for (let i = 0; i < 6; i++) {
          res = await askTab(tab.id);
          if (res) break;
          await sleep(700);
        }
        if (!res || !res.ok) return respond(res || { ok: false, error: "페이지를 읽지 못했습니다." });
        res.data.url = tab.url;
        res.data.image = await makeThumbFrom(res.data.imageCandidates || [res.data.image]);
        delete res.data.imageCandidates;
        respond({ ok: true, data: res.data });
      } catch (e) {
        respond({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
});
