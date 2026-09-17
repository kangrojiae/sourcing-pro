/* Sourcing Pro 수집기 — 웹 페이지와 확장프로그램을 잇는 다리.
   Sourcing Pro 화면에서만 동작하도록, 정해진 표식이 붙은 메시지만 받는다. */
(function () {
  "use strict";

  /* 이 창에 소싱 프로 화면이 떠 있는지. 한 번이라도 말을 걸어오면 떠 있는 것이다. */
  var appSeen = false;
  var pendingAnalyze = {};

  /* 쿠팡 화면에서 리뷰 정리를 부탁하면, 소싱 프로 화면에 넘기고 답을 기다린다.
     소싱 프로가 없는 창에서는 대답하지 않는다. 그래야 다른 창이 대신 답할 수 있다. */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== "spAnalyze") return;
      if (!appSeen) return;
      var reqId = "a" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var done = false;
      pendingAnalyze[reqId] = function (d) {
        if (done) return;
        done = true;
        sendResponse({ ok: !!d.ok, data: d.data, error: d.error });
      };
      window.postMessage({ __sp: "ext", type: "analyze", reqId: reqId, name: msg.name, reviews: msg.reviews }, "*");
      setTimeout(function () {
        if (done) return;
        done = true;
        delete pendingAnalyze[reqId];
        sendResponse({ ok: false, error: "분석이 시간 초과되었습니다." });
      }, 95000);
      return true;
    });
  } catch (e) { /* 확장프로그램이 갱신되어 끊긴 경우 */ }

  function hello() {
    try {
      window.postMessage(
        { __sp: "ext", type: "hello", version: chrome.runtime.getManifest().version },
        "*"
      );
    } catch (e) { /* 확장프로그램이 갱신되어 컨텍스트가 끊긴 경우 */ }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__sp !== "page") return;
    appSeen = true;

    if (d.type === "analyzeResult") {
      var cb = pendingAnalyze[d.reqId];
      if (cb) { delete pendingAnalyze[d.reqId]; cb(d); }
      return;
    }

    if (d.type === "ping") {
      hello();
      return;
    }

    /* 페이지가 보낼 수 있는 요청만 통과시킨다 */
    var ROUTES = {
      collect:    function (m) { return { type: "collect", url: m.url }; },
      fx:         function (m) { return { type: "fxRate", force: !!m.force }; },
      keywords:   function (m) { return { type: "keywords", seed: m.seed }; },
      partnerStatus: function () { return { type: "partnerStatus" }; },
      searchCache: function (m) { return { type: "searchCache", clear: !!m.clear }; },
      readActiveCoupang: function (m) { return { type: "readActiveCoupang", limit: m.limit }; },
      openCoupangSearch: function (m) { return { type: "openCoupangSearch", keyword: m.keyword }; },
      coupangSession: function (m) { return { type: "coupangSession", open: !!m.open }; },
      coupangCooldown: function (m) { return { type: "coupangCooldown", clear: !!m.clear }; },
      thumbs: function (m) { return { type: "thumbs", urls: m.urls, size: m.size }; },
      coupangTop: function (m) {
        return { type: "coupangTop", keyword: m.keyword, limit: m.limit, withImages: !!m.withImages };
      },
      search1688: function (m) {
        return { type: "search1688", keyword: m.keyword, limit: m.limit, withImages: !!m.withImages };
      },
      backToApp: function (m) { return { type: "backToApp", closeLogin: !!m.closeLogin }; },
      close1688Tabs: function (m) { return { type: "close1688Tabs", keepAssisted: !!m.keepAssisted }; },
      focus1688Tab: function () { return { type: "focus1688Tab" }; },
      login1688Status: function () { return { type: "login1688Status" }; },
      login1688Open: function () { return { type: "login1688Open" }; },
      image1688: function (m) {
        return { type: "image1688", dataUrl: m.dataUrl, limit: m.limit,
                 withImages: !!m.withImages, assist: m.assist !== false };
      },
      grab1688Tab: function (m) {
        return { type: "grab1688Tab", limit: m.limit, withImages: !!m.withImages };
      },
      reviewInsightFromPage: function (m) {
        return { type: "reviewInsightFromPage", productId: m.productId, name: m.name, force: !!m.force };
      },
      coupangReviews:  function (m) { return { type: "coupangReviews", productId: m.productId, count: m.count }; },
      catTree:         function (m) { return { type: "catTree", force: !!m.force }; },
      coupangOpenUrl:  function (m) { return { type: "coupangOpenUrl", url: m.url }; },
      coupangNextPage: function () { return { type: "coupangNextPage" }; },
      shopLogin:     function (m) { return { type: "shopLogin", site: m.site }; },
      shopLoginOpen: function (m) { return { type: "shopLoginOpen", site: m.site }; },
      temuTop:     function (m) {
        return { type: "temuTop", channel: m.channel, limit: m.limit,
                 category: m.category, withImages: !!m.withImages };
      },
      temuOpen:    function (m) { return { type: "temuOpen", channel: m.channel }; },
      taobaoTop:   function (m) {
        return { type: "taobaoTop", keyword: m.keyword, limit: m.limit, withImages: !!m.withImages };
      },
      taobaoOpen:  function (m) { return { type: "taobaoOpen", keyword: m.keyword }; },
      wing28:      function (m) { return { type: "wing28", productId: m.productId }; },
      wing28Batch: function (m) { return { type: "wing28Batch", ids: m.ids }; },
      wingStatus:  function () { return { type: "wingStatus" }; },
      wingOpen:    function () { return { type: "wingOpen" }; },
      overlayPref: function (m) { return { type: "overlayPref", on: m.on }; },
      keyStatus:   function () { return { type: "keyStatus" }; },
      openOptions: function () { return { type: "openOptions" }; }
    };

    if (ROUTES[d.type]) {
      var reqId = d.reqId;
      var payload = ROUTES[d.type](d);
      try {
        chrome.runtime.sendMessage(payload, function (res) {
          var err = chrome.runtime.lastError;
          window.postMessage({
            __sp: "ext",
            type: "result",
            reqId: reqId,
            ok: !err && res && res.ok,
            data: res && res.data,
            needsKey: !!(res && res.needsKey),
            needsWing: !!(res && res.needsWing),
            needsLogin: !!(res && res.needsLogin),
            assisted: !!(res && res.assisted),
            blocked: !!(res && res.blocked),
            error: err ? "확장프로그램과 통신하지 못했습니다. 페이지를 새로고침해주세요." : (res && res.error)
          }, "*");
        });
      } catch (e) {
        window.postMessage({
          __sp: "ext", type: "result", reqId: reqId, ok: false,
          error: "확장프로그램이 다시 로드되었습니다. 페이지를 새로고침해주세요."
        }, "*");
      }
    }
  });

  hello();
  document.addEventListener("DOMContentLoaded", hello);
  window.addEventListener("load", hello);
  setTimeout(hello, 1200);
})();
