/* Sourcing Pro 수집기 — 웹 페이지와 확장프로그램을 잇는 다리.
   Sourcing Pro 화면에서만 동작하도록, 정해진 표식이 붙은 메시지만 받는다. */
(function () {
  "use strict";

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

    if (d.type === "ping") {
      hello();
      return;
    }

    /* 페이지가 보낼 수 있는 요청만 통과시킨다 */
    var ROUTES = {
      collect:    function (m) { return { type: "collect", url: m.url }; },
      fx:         function (m) { return { type: "fxRate", force: !!m.force }; },
      keywords:   function (m) { return { type: "keywords", seed: m.seed }; },
      shopCount:  function (m) { return { type: "shopCount", keyword: m.keyword }; },
      coupangTop: function (m) {
        return { type: "coupangTop", keyword: m.keyword, limit: m.limit, withImages: !!m.withImages };
      },
      search1688: function (m) {
        return { type: "search1688", keyword: m.keyword, limit: m.limit, withImages: !!m.withImages };
      },
      image1688: function (m) {
        return { type: "image1688", dataUrl: m.dataUrl, limit: m.limit, withImages: !!m.withImages };
      },
      grab1688Tab: function (m) {
        return { type: "grab1688Tab", limit: m.limit, withImages: !!m.withImages };
      },
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
            assisted: !!(res && res.assisted),
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
