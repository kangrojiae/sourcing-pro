/* Sourcing Pro 수집기 팝업.
   위쪽: 지금 열려 있는 Sourcing Pro 페이지를 클릭 한 번으로 연결한다.
         주소가 무엇이든 현재 탭에서 직접 읽으므로 manifest 를 고칠 필요가 없다.
   아래쪽: 지금 보고 있는 상품 페이지를 직접 수집해 값을 확인한다. */
(function () {
  "use strict";

  var APP_URL = "https://claude.ai/code/artifact/f7a928bd-52ca-4a1d-a03a-dc272f1b365e";

  /* manifest 에 이미 들어 있어 설치만으로 붙는 주소들 */
  var AUTO = [
    /^https:\/\/([a-z0-9-]+\.)?claude\.ai$/i,
    /^https:\/\/[a-z0-9-]+\.claudeusercontent\.com$/i,
    /^https:\/\/[a-z0-9-]+\.claude\.site$/i,
    /^https:\/\/[a-z0-9-]+\.artifacts\.claude\.com$/i,
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i
  ];
  function isAuto(origin) {
    return AUTO.some(function (re) { return re.test(origin); });
  }

  var connectArea = document.getElementById("connectArea");
  var connMsg = document.getElementById("connMsg");
  var dot = document.getElementById("dot");
  var siteEl = document.getElementById("site");
  var grab = document.getElementById("grab");
  var copy = document.getElementById("copy");
  var msg = document.getElementById("msg");
  var out = document.getElementById("out");

  var currentTab = null;
  var lastData = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function say(el, text, kind) {
    el.textContent = text || "";
    el.className = "msg" + (kind ? " " + kind : "");
  }
  function originOf(url) {
    try {
      var u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch (e) {
      return null;
    }
  }
  function idFor(origin) {
    return "sp-bridge-" + origin.replace(/[^a-zA-Z0-9]/g, "-");
  }
  function shortName(origin) {
    return origin.replace(/^https?:\/\//, "");
  }

  /* ---------- 연결 상태 ---------- */
  async function registeredOrigins() {
    try {
      var list = await chrome.scripting.getRegisteredContentScripts();
      return list
        .filter(function (s) { return s.id.indexOf("sp-bridge-") === 0; })
        .map(function (s) { return (s.matches && s.matches[0] || "").replace(/\/\*$/, ""); })
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  async function tabOrigins(tab) {
    var found = [];
    var push = function (o) {
      if (o && found.indexOf(o) < 0 && !/(coupang\.com|1688\.com)$/i.test(o)) found.push(o);
    };
    push(originOf(tab.url));
    try {
      var frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      (frames || []).forEach(function (f) { push(originOf(f.url)); });
    } catch (e) { /* 프레임 목록을 못 읽으면 최상위 주소만 쓴다 */ }
    return found;
  }

  async function connect(origin) {
    var pattern = origin + "/*";
    var granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (e) {
      say(connMsg, "권한 요청에 실패했습니다: " + e.message, "err");
      return;
    }
    if (!granted) {
      say(connMsg, "권한이 허용되지 않아 연결하지 못했습니다.", "err");
      return;
    }
    var id = idFor(origin);
    try {
      try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) { /* 처음 등록 */ }
      await chrome.scripting.registerContentScripts([{
        id: id,
        matches: [pattern],
        js: ["bridge.js"],
        runAt: "document_start",
        allFrames: true,
        persistAcrossSessions: true
      }]);
      /* 새로고침 없이 바로 붙도록 지금 열려 있는 프레임에도 주입한다 */
      if (currentTab) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: currentTab.id, allFrames: true },
            files: ["bridge.js"]
          });
        } catch (e) { /* 주입이 막힌 프레임은 새로고침 후 붙는다 */ }
      }
      say(connMsg, shortName(origin) + " 연결됨. 앱 화면에서 링크로 수집할 수 있습니다.", "ok");
      await renderConnect();
    } catch (e) {
      say(connMsg, "연결에 실패했습니다: " + e.message, "err");
    }
  }

  async function disconnect(origin) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [idFor(origin)] });
    } catch (e) { /* 이미 해제됨 */ }
    try {
      await chrome.permissions.remove({ origins: [origin + "/*"] });
    } catch (e) { /* 권한 회수 실패는 무시 */ }
    say(connMsg, shortName(origin) + " 연결을 해제했습니다.", "");
    await renderConnect();
  }

  async function renderConnect() {
    var reg = await registeredOrigins();
    var here = currentTab ? await tabOrigins(currentTab) : [];
    var rows = [];

    here.forEach(function (o) {
      if (isAuto(o)) {
        rows.push(
          '<div class="site">' +
            '<span class="u" title="' + esc(o) + '">' + esc(shortName(o)) + "</span>" +
            '<span class="badge">자동 연결됨</span>' +
          "</div>"
        );
        return;
      }
      var on = reg.indexOf(o) >= 0;
      rows.push(
        '<div class="site">' +
          '<span class="u" title="' + esc(o) + '">' + esc(shortName(o)) + "</span>" +
          (on ? '<span class="badge">연결됨</span>' : "") +
          '<button class="' + (on ? "ghost" : "dark") + '" data-' + (on ? "off" : "on") + '="' + esc(o) + '">' +
            (on ? "해제" : "연결") +
          "</button>" +
        "</div>"
      );
    });

    reg.forEach(function (o) {
      if (here.indexOf(o) >= 0) return;
      rows.push(
        '<div class="site">' +
          '<span class="u" title="' + esc(o) + '">' + esc(shortName(o)) + "</span>" +
          '<span class="badge">연결됨</span>' +
          '<button class="ghost" data-off="' + esc(o) + '">해제</button>' +
        "</div>"
      );
    });

    connectArea.innerHTML = rows.length
      ? rows.join("")
      : '<div class="none">Sourcing Pro 페이지를 연 탭에서 이 아이콘을 눌러주세요. 그 페이지 주소가 여기에 나타나고, 연결을 누르면 끝납니다.</div>';

    Array.prototype.forEach.call(connectArea.querySelectorAll("[data-on]"), function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        b.textContent = "연결 중";
        connect(b.getAttribute("data-on"));
      });
    });
    Array.prototype.forEach.call(connectArea.querySelectorAll("[data-off]"), function (b) {
      b.addEventListener("click", function () { disconnect(b.getAttribute("data-off")); });
    });
  }

  /* ---------- 현재 탭 수집 ---------- */
  function renderGrabState() {
    var url = (currentTab && currentTab.url) || "";
    var isCoupang = /coupang\.com/i.test(url);
    var is1688 = /1688\.com/i.test(url);
    if (isCoupang || is1688) {
      dot.className = "dot on";
      siteEl.textContent = isCoupang ? "쿠팡 상품 페이지" : "1688 상품 페이지";
      grab.disabled = false;
      say(msg, "이 페이지의 상품 정보를 읽어옵니다.");
    } else {
      siteEl.textContent = "지원하지 않는 페이지";
      say(msg, "쿠팡 또는 1688 상품 페이지에서 눌러주세요.");
    }
  }

  grab.addEventListener("click", function () {
    grab.disabled = true;
    grab.textContent = "수집 중...";
    say(msg, "페이지를 읽는 중입니다.");
    chrome.runtime.sendMessage({ type: "collectActiveTab" }, function (res) {
      grab.disabled = false;
      grab.textContent = "이 페이지 수집하기";
      if (chrome.runtime.lastError || !res) {
        say(msg, "확장프로그램과 통신하지 못했습니다.", "err");
        return;
      }
      if (!res.ok) {
        say(msg, res.error || "수집에 실패했습니다.", "err");
        return;
      }
      lastData = res.data;
      var d = res.data;
      out.hidden = false;
      copy.hidden = false;
      out.innerHTML =
        "<div><b>상품명</b> " + esc(d.name || "-") + "</div>" +
        "<div><b>가격</b> " + (d.price ? (d.site === "1688" ? "¥" + d.price : Number(d.price).toLocaleString("ko-KR") + "원") : "-") + "</div>" +
        (d.rating ? "<div><b>별점</b> " + esc(d.rating) + " (" + (d.reviews || 0) + ")</div>" : "") +
        (d.category ? "<div><b>카테고리</b> " + esc(d.category) + "</div>" : "") +
        (d.moq ? "<div><b>MOQ</b> " + esc(d.moq) + "</div>" : "") +
        (d.opt ? "<div><b>옵션</b> " + esc(d.opt) + "</div>" : "") +
        "<div><b>썸네일</b> " + (d.image ? "수집됨" : "없음") + "</div>";
      say(msg, "수집을 마쳤습니다.", "ok");
    });
  });

  copy.addEventListener("click", function () {
    if (!lastData) return;
    navigator.clipboard.writeText(JSON.stringify(lastData, null, 2)).then(
      function () { say(msg, "JSON을 클립보드에 복사했습니다.", "ok"); },
      function () { say(msg, "복사하지 못했습니다.", "err"); }
    );
  });

  document.getElementById("openApp").addEventListener("click", function () {
    chrome.tabs.create({ url: APP_URL });
    window.close();
  });
  document.getElementById("sweepTabs").addEventListener("click", function () {
    var b = document.getElementById("sweepTabs");
    b.disabled = true;
    chrome.runtime.sendMessage({ type: "sweepTabs" }, function (res) {
      b.disabled = false;
      var n = res && res.data ? res.data.closed : 0;
      say(connMsg, n ? n + "개 탭을 닫았습니다." : "정리할 탭이 없습니다.", n ? "ok" : "");
    });
  });
  document.getElementById("openOptions").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  /* ---------- 시작 ---------- */
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    currentTab = tabs && tabs[0] ? tabs[0] : null;
    renderGrabState();
    renderConnect();
  });
})();
