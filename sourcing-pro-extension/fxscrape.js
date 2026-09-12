/* Sourcing Pro 수집기 — 네이버 환율 페이지에서 위안화 환율을 읽는다.
   HTML 구조를 추측해 정규식으로 긁지 않고, 표의 한글 라벨을 기준으로 옆 칸의 숫자를 찾는다. */
(function () {
  "use strict";
  if (window.__spFxReady) return;
  window.__spFxReady = true;

  function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }
  function toNum(s) {
    var m = String(s || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }
  /* 환율로 볼 수 있는 범위인지 — 페이지의 다른 숫자를 잘못 집는 것을 막는다 */
  function plausible(v) {
    return v > 50 && v < 1000;
  }

  /* 라벨이 든 칸을 찾고, 같은 줄에서 그 뒤에 오는 첫 숫자를 값으로 본다 */
  function fromTables(labelRe) {
    var rows = document.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].cells ? Array.prototype.slice.call(rows[i].cells) : [];
      if (!cells.length) continue;
      var texts = cells.map(function (c) { return clean(c.textContent); });
      var at = -1;
      for (var j = 0; j < texts.length; j++) {
        if (labelRe.test(texts[j])) { at = j; break; }
      }
      if (at < 0) continue;
      /* 라벨과 숫자가 같은 칸에 있는 경우 */
      var inline = toNum(texts[at].replace(labelRe, ""));
      if (plausible(inline)) return inline;
      for (var k = at + 1; k < texts.length; k++) {
        var v = toNum(texts[k]);
        if (plausible(v)) return v;
      }
    }
    return 0;
  }

  /* 표에서 못 찾으면 본문 전체에서 라벨 바로 뒤의 숫자를 찾는다 */
  function fromText(labelRe) {
    var body = clean(document.body ? document.body.innerText : "");
    var m = body.match(new RegExp(labelRe.source + "[^0-9]{0,40}([0-9,]+(?:\\.[0-9]+)?)"));
    if (!m) return 0;
    var v = toNum(m[1]);
    return plausible(v) ? v : 0;
  }

  function find(labelRe) {
    return fromTables(labelRe) || fromText(labelRe);
  }

  function read() {
    var send = find(/송금[^0-9]{0,10}(보낼|보내실)\s*때/);
    var base = find(/매매\s*기준율/);
    var today = 0;
    var el = document.querySelector(".no_today, .head_info .value, #exchangeList .value");
    if (el) {
      var v = toNum(clean(el.textContent));
      if (plausible(v)) today = v;
    }

    var rate = send || base || today;
    if (!rate) return null;

    var label = send ? "송금 보낼 때" : (base ? "매매기준율" : "고시 환율");
    var stamp = "";
    var timeEl = document.querySelector(".exchange_info .standard, .date, .time, .no_today + .exchange_info");
    if (timeEl) stamp = clean(timeEl.textContent).slice(0, 40);

    return {
      rate: rate,
      label: label,
      base: base || 0,
      send: send || 0,
      stamp: stamp,
      source: "네이버 금융",
      url: location.href
    };
  }

  function readWhenReady(cb) {
    var start = Date.now();
    (function tick() {
      var d = null;
      try { d = read(); } catch (e) { d = null; }
      if (d || Date.now() - start > 8000) { cb(d); return; }
      setTimeout(tick, 500);
    })();
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== "readFx") return;
    readWhenReady(function (data) {
      if (!data) respond({ ok: false, error: "네이버 환율 페이지에서 값을 찾지 못했습니다." });
      else respond({ ok: true, data: data });
    });
    return true;
  });
})();
