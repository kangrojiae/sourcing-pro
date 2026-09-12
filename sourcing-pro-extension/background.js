/* Sourcing Pro 수집기 — 백그라운드 서비스 워커.
   웹 페이지에서 온 수집 요청을 받아 대상 상품 페이지를 보이지 않는 탭으로 열고,
   콘텐츠 스크립트가 읽은 값과 축소한 썸네일을 돌려준 뒤 탭을 닫는다. */

const LOAD_TIMEOUT_MS = 30000;
const SCRAPE_RETRIES = 12;
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
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return "";
    const blob = await res.blob();
    if (blob.size < 500) return "";
    const bmp = await createImageBitmap(blob);
    /* 1x1 투명 이미지 같은 자리표시자는 버린다 */
    if (bmp.width < 60 || bmp.height < 60) return "";
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
    return "data:image/jpeg;base64," + btoa(bin);
  } catch (e) {
    return "";
  }
}

async function collect(url) {
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
    if (!res) {
      return { ok: false, error: "페이지를 읽지 못했습니다. 로그인이나 보안 확인이 필요한지 확인해주세요." };
    }
    if (!res.ok) return res;

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
   경쟁 강도 — 네이버쇼핑 검색 결과의 전체 상품 수
   ===================================================================== */
async function shopCount(keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return { ok: false, error: "키워드가 비어 있습니다." };
  await beginJob();
  let tabId = null;
  try {
    const url = "https://search.shopping.naver.com/search/all?query=" + encodeURIComponent(kw);
    const tab = await openWorkTab(url, false);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "네이버쇼핑 페이지를 열지 못했습니다." };
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shopcount.js"] });
    } catch (e) { /* 이미 붙어 있으면 무시 */ }

    let res = null;
    for (let i = 0; i < 8; i++) {
      res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "readShopCount" }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res) break;
      await sleep(800);
    }
    if (!res) return { ok: false, error: "네이버쇼핑 결과를 읽지 못했습니다. 잠시 후 다시 시도해주세요." };
    return res;
  } catch (e) {
    return { ok: false, error: "상품 수를 확인하지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    releaseAwake();
  }
}

/* =====================================================================
   쿠팡 검색 1위 상품 → 그대로 비교 분석으로 넘긴다
   ===================================================================== */
/* 여러 이미지를 한꺼번에 받되 동시에 너무 많이 열지 않는다 */
async function thumbBatch(urls, size) {
  const out = new Array(urls.length).fill("");
  const CHUNK = 5;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const slice = urls.slice(i, i + CHUNK);
    const done = await Promise.all(slice.map((u) => makeThumb(u, size)));
    for (let j = 0; j < done.length; j++) out[i + j] = done[j];
  }
  return out;
}

async function coupangTop(keyword, limit, withImages) {
  const kw = String(keyword || "").trim();
  const want = Math.min(40, Math.max(1, limit || 5));
  if (!kw) return { ok: false, error: "키워드가 비어 있습니다." };
  await beginJob();
  let tabId = null;
  try {
    const url = "https://www.coupang.com/np/search?q=" + encodeURIComponent(kw) +
      "&channel=user&listSize=36&sorter=scoreDesc";
    const tab = await openWorkTab(url, false);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "쿠팡 검색 페이지를 열지 못했습니다." };
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
    if (!res) return { ok: false, error: "쿠팡 검색 결과를 읽지 못했습니다." };
    if (!res.ok) return res;

    const items = (res.data && res.data.items) || [];
    if (withImages && items.length) {
      const thumbs = await thumbBatch(items.map((it) => it.image), 160);
      for (let i = 0; i < items.length; i++) items[i].image = thumbs[i] || "";
    }
    return { ok: true, data: { keyword: kw, items: items } };
  } catch (e) {
    return { ok: false, error: "쿠팡 상위 상품을 찾지 못했습니다: " + (e && e.message ? e.message : e) };
  } finally {
    await closeWorkTab(tabId);
    releaseAwake();
  }
}

/* =====================================================================
   1688 이미지 검색 — 쿠팡 썸네일을 그대로 넣어 같은 물건을 찾는다
   ===================================================================== */
/* 1688 첫 화면의 검색창에 이미지 검색 버튼이 있고, 붙여넣기로도 검색이 된다.
   탭은 항상 하나만 연다. 여러 개를 열면 예전 검색 결과를 읽어 엉뚱한 상품이 들어온다. */
const IMAGE_SEARCH_URL = "https://www.1688.com/";

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
    return Array.prototype.filter.call(
      document.querySelectorAll('input[type="file"]'),
      function (el) { return !el.disabled; }
    );
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
    const tab = await openWorkTab(entryUrl, !!o.visible);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "1688 페이지를 열지 못했습니다." };
    await sleep(1200);

    /* 이미지 검색 칸이 안쪽 프레임에 있는 경우가 있어 모든 프레임에서 시도한다 */
    let put = null;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: putImageIntoSearch,
        args: [dataUrl, { helper: !!o.visible }]
      });
      const results = (r || []).map((x) => x && x.result).filter(Boolean);
      const good = ["clicked", "file", "file-late", "paste"];
      put = results.find((x) => x.ok && good.indexOf(x.how) >= 0) ||
            results.find((x) => x.ok) || results[0] || null;
    } catch (e) {
      return { ok: false, error: "이미지 검색을 시작하지 못했습니다: " + (e && e.message ? e.message : e) };
    }
    if (!put || !put.ok) {
      return { ok: false, error: (put && put.error) || "1688 이미지 검색 칸을 찾지 못했습니다." };
    }
    /* 자동 업로드가 안 되어 안내만 띄운 경우, 탭을 남겨 직접 올리시게 한다 */
    if (o.visible && put.how === "manual") {
      keepTab = true;
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      await setAssistedTab(tabId);
      return {
        ok: false, assisted: true, tabId: tabId,
        error: "1688 이미지 검색 칸이 자동으로 열리지 않아, 탭을 띄우고 사진을 올려두었습니다."
      };
    }

    /* 1688은 이미지 검색 버튼을 두 번 눌러야 결과가 나온다.
       결과가 빌 때마다 화면에 남아 있는 검색 버튼을 다시 눌러가며 기다린다. */
    const deadline = Date.now() + (o.budgetMs || 45000);
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
      await sleep(1500);
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
          if (did) { clicks++; await sleep(3000); }
        } catch (e) { /* 이동 중이면 다음 회차에 */ }
      }
    }
    tabId = cur;
    if (o.visible) {
      keepTab = true;
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
      await setAssistedTab(tabId);
      return {
        ok: false, assisted: true, tabId: tabId,
        error: "1688 탭을 열어두었습니다. 그 탭에서 이미지 검색을 눌러 상품 목록을 띄운 뒤 결과를 가져오세요. " +
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
    var m = h.match(/\/offer\/(\d{6,})/) || h.match(/[?&]offer_?id=(\d{6,})/i) ||
            h.match(/[?&]id=(\d{9,})/i) || h.match(/(\d{11,})/);
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
      var probe = [card];
      var up = card.parentElement;
      for (var g = 0; g < 4 && up; g++) { probe.push(up); up = up.parentElement; }
      probe = probe.concat(Array.prototype.slice.call(card.querySelectorAll("*")).slice(0, 200));
      for (var q = 0; q < probe.length && !id; q++) {
        var at = probe[q].attributes;
        if (!at) continue;
        for (var r = 0; r < at.length; r++) {
          var nm = at[r].name;
          if (nm === "class" || nm === "style" || nm === "src" || nm === "srcset" || nm === "alt") continue;
          var val = String(at[r].value || "");
          var got = offerIdOf(val);
          if (!got && /^data-|^id$|^href$/i.test(nm)) {
            var dm = val.match(/(\d{9,})/);
            if (dm) got = dm[1];
          }
          if (got) { id = got; break; }
        }
      }
    }
    var key = id || (name + "|" + price);
    if (seen.indexOf(key) >= 0) continue;
    seen.push(key);
    if (!url && id) url = "https://detail.1688.com/offer/" + id + ".html";

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

async function image1688(dataUrl, limit, withImages) {
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
      r = await imageSearchOnce(IMAGE_SEARCH_URL, dataUrl, want, { budgetMs: 60000, visible: true });
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
    const tab = await openWorkTab("https://www.1688.com/", false);
    tabId = tab.id;
    const loaded = await waitForLoad(tabId);
    if (!loaded) return { ok: false, error: "1688 을 열지 못했습니다." };

    /* 주소로 검색어를 넘기면 1688 이 옛 인코딩을 요구해 엉뚱한 목록이 나온다.
       그래서 검색창에 직접 입력해 검색한다. */
    let typed = null;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId }, func: typeAndSearch, args: [kw]
      });
      typed = r && r[0] ? r[0].result : null;
    } catch (e) { typed = null; }
    if (!typed || !typed.ok) {
      return { ok: false, error: (typed && typed.error) || "1688 검색창에 입력하지 못했습니다." };
    }
    await sleep(2500);
    await waitForLoad(tabId);

    let items = [];
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["scrape.js"] });
      } catch (e) { /* 이동 중이면 다음 회차에 */ }
      const res = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "search1688", limit: want }, (r) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(r || null);
        });
      });
      if (res && res.ok && res.data && res.data.items && res.data.items.length) {
        items = res.data.items;
        break;
      }
      await sleep(1500);
    }
    if (!items.length) {
      return { ok: false, error: "1688 검색 결과를 읽지 못했습니다. 크롬에서 1688 에 먼저 로그인해보세요." };
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
  if (msg.type === "search1688") {
    search1688(msg.keyword, msg.limit, msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "image1688") {
    image1688(msg.dataUrl, msg.limit, msg.withImages).then(respond);
    return true;
  }
  if (msg.type === "sweepTabs") {
    sweepTabs().then((n) => respond({ ok: true, data: { closed: n } }));
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
  if (msg.type === "shopCount") {
    shopCount(msg.keyword).then(respond);
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
