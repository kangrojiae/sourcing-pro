/* Sourcing Pro 수집기 설정 — 네이버 검색광고 API 자격 정보를 이 브라우저에만 저장한다. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var msg = $("msg");
  var raw = $("raw");

  function say(text, kind) {
    msg.textContent = text || "";
    msg.className = "msg" + (kind ? " " + kind : "");
  }

  chrome.storage.local.get("sp.searchad", function (o) {
    var c = o["sp.searchad"] || {};
    $("apiKey").value = c.apiKey || "";
    $("customer").value = c.customer || "";
    if (c.secret) $("secret").placeholder = "저장되어 있습니다. 바꿀 때만 입력하세요.";
  });

  $("save").addEventListener("click", function () {
    chrome.storage.local.get("sp.searchad", function (o) {
      var prev = o["sp.searchad"] || {};
      var next = {
        apiKey: $("apiKey").value.trim(),
        customer: $("customer").value.trim(),
        secret: $("secret").value.trim() || prev.secret || ""
      };
      if (!next.apiKey || !next.customer || !next.secret) {
        say("세 칸을 모두 채워주세요. 비밀키는 처음 한 번은 반드시 입력해야 합니다.", "err");
        return;
      }
      chrome.storage.local.set({ "sp.searchad": next }, function () {
        $("secret").value = "";
        $("secret").placeholder = "저장되어 있습니다. 바꿀 때만 입력하세요.";
        say("저장했습니다. 연결 테스트로 확인해보세요.", "ok");
      });
    });
  });

  $("clear").addEventListener("click", function () {
    chrome.storage.local.remove("sp.searchad", function () {
      $("apiKey").value = "";
      $("customer").value = "";
      $("secret").value = "";
      $("secret").placeholder = "AQAAAAA...";
      raw.hidden = true;
      say("저장된 키를 지웠습니다.");
    });
  });

  $("test").addEventListener("click", function () {
    var btn = $("test");
    btn.disabled = true;
    raw.hidden = true;
    say("네이버 검색광고에 요청 중입니다.");
    chrome.runtime.sendMessage({ type: "keywords", seed: "블루투스이어폰", debug: true }, function (res) {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res) {
        say("확장프로그램과 통신하지 못했습니다.", "err");
        return;
      }
      if (!res.ok) {
        say(res.error || "요청이 실패했습니다.", "err");
        if (res.raw) { raw.hidden = false; raw.textContent = String(res.raw).slice(0, 4000); }
        return;
      }
      var list = (res.data && res.data.list) || [];
      say("연결되었습니다. 연관 키워드 " + list.length + "개를 받았습니다.", "ok");
      raw.hidden = false;
      raw.textContent = list.slice(0, 8).map(function (k) {
        return k.keyword + "  검색량 " + (k.total || 0).toLocaleString("ko-KR") +
          " (PC " + (k.pc || 0) + " / 모바일 " + (k.mobile || 0) + ")  경쟁 " + (k.comp || "-");
      }).join("\n");
    });
  });
})();
