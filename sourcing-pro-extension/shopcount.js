/* Sourcing Pro 수집기 — 네이버쇼핑 검색 결과의 전체 상품 수를 읽는다.
   페이지가 심어 두는 JSON 을 먼저 보고, 없으면 화면의 "전체 N" 표시를 읽는다. */
(function () {
  "use strict";
  if (window.__spShopReady) return;
  window.__spShopReady = true;

  function toNum(s) {
    var m = String(s || "").replace(/,/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  /* 페이지가 심어 둔 상태 객체 안에서 total 로 보이는 값을 찾는다 */
  function fromEmbedded() {
    var el = document.getElementById("__NEXT_DATA__");
    if (!el) return 0;
    var json;
    try { json = JSON.parse(el.textContent); } catch (e) { return 0; }

    var best = 0;
    var seen = 0;
    (function walk(node) {
      if (!node || typeof node !== "object" || seen > 20000) return;
      seen++;
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = node[k];
        if ((k === "total" || k === "totalCount" || k === "productCount") && typeof v === "number") {
          if (v > best) best = v;
        } else if (v && typeof v === "object") {
          walk(v);
        }
      }
    })(json);
    return best;
  }

  function fromScreen() {
    var el = document.querySelector('[class*="subFilter_num"], [class*="filter_num"], [class*="_total"]');
    if (el) {
      var v = toNum(el.textContent);
      if (v) return v;
    }
    var body = document.body ? document.body.innerText : "";
    var m = body.match(/전체\s*([\d,]+)/);
    if (m) return toNum(m[1]);
    m = body.match(/([\d,]+)\s*개의\s*상품/);
    if (m) return toNum(m[1]);
    return 0;
  }

  function read() {
    var count = fromEmbedded() || fromScreen();
    if (!count) return null;
    return { count: count, url: location.href };
  }

  function readWhenReady(cb) {
    var start = Date.now();
    (function tick() {
      var d = null;
      try { d = read(); } catch (e) { d = null; }
      if (d || Date.now() - start > 9000) { cb(d); return; }
      setTimeout(tick, 600);
    })();
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== "readShopCount") return;
    readWhenReady(function (data) {
      if (!data) respond({ ok: false, error: "네이버쇼핑에서 상품 수를 찾지 못했습니다." });
      else respond({ ok: true, data: data });
    });
    return true;
  });
})();
