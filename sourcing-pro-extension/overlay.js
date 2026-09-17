/* Sourcing Pro 수집기 — 쿠팡 화면에 최근 28일 판매량을 덧씌운다.

   값은 쿠팡 윙에서 가져온다. 추정이 아니라 쿠팡이 주는 실제 숫자다.
   윙에 로그인한 탭이 하나 열려 있어야 하고, 그 탭 안에서 부른다.

   쿠팡은 목록을 수시로 다시 그린다. 그때 우리가 붙인 딱지도 같이 지워진다.
   그래서 받은 값을 상품번호별로 들고 있다가, 딱지가 사라지면 곧바로 다시 붙인다.
   다시 붙일 때는 윙에 다시 묻지 않는다. */
(function () {
  "use strict";
  /* 수집기를 새로고침해도 페이지에는 이전 버전의 표시가 남는다.
     표시만 보고 멈추면 새 버전이 아무 일도 안 하므로, 이전 것이 아직 살아 있을 때만 건너뛴다. */
  if (typeof window.__spOverlayReady === "function" && window.__spOverlayReady()) return;
  window.__spOverlayReady = function () { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  /* 이전 버전이 남긴 딱지와 단추는 눌러도 동작하지 않으므로 치운다 */
  Array.prototype.forEach.call(document.querySelectorAll(".sp-ov, #sp-rv-float, #sp-ov-style, #sp-rm-style"), function (el) { el.remove(); });
  if (/^wing\./i.test(location.hostname)) return;

  var ON = true;
  var cornerPref = { list: "tl", detail: "tl" };
  var MAX_FETCH = 60;        /* 한 화면에서 윙에 물어볼 최대 개수 */
  var known = {};            /* pid -> {sold, views} 또는 {none:true} */
  var asked = {};            /* pid -> true. 이미 물어본 것 */
  var queue = [];
  var working = false;
  var painting = false;      /* 우리가 화면을 고치는 중 */
  var scanTimer = null;
  var stopped = false;       /* 윙이 없어 더 묻지 않는 상태 */

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nf(n) {
    var v = Number(n);
    return isFinite(v) ? Math.round(v).toLocaleString("ko-KR") : "-";
  }
  function toNum(s) {
    var v = String(s == null ? "" : s).replace(/[^0-9]/g, "");
    return v ? parseInt(v, 10) : 0;
  }
  function askedCount() { return Object.keys(asked).length; }

  /* ---------- 카드와 상품번호 찾기 ---------- */
  function pidOf(href) {
    var m = String(href || "").match(/\/vp\/products\/(\d+)/);
    return m ? m[1] : "";
  }
  /* 상품 한 칸 전체를 잡는다. 사진 칸만 잡으면 가격을 못 읽고 딱지 자리도 칸마다 달라진다.
     위로 올라가다가 다른 상품 링크까지 품게 되면, 그 바로 전 단계가 한 칸이다. */
  function cardOf(a) {
    var el = a, best = null;
    for (var i = 0; i < 9 && el && el !== document.body; i++) {
      var links = el.querySelectorAll ? el.querySelectorAll('a[href*="/vp/products/"]').length : 0;
      if (links > 1 && best) break;
      if (el.querySelector && el.querySelector("img")) {
        var box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (box && box.width > 90 && box.height > 90) {
          best = el;
          if (/[0-9][0-9,]{2,}\s*원/.test(String(el.innerText || ""))) return el;
        }
      }
      el = el.parentElement;
    }
    return best || a.parentElement || a;
  }

  /* ---------- 판매가 읽기 ---------- */
  function priceOf(card) {
    var t = String(card.textContent || "");
    var m = t.match(/([0-9][0-9,]{2,})\s*원\s*[(（]\s*1\s*개당/);
    if (m) return toNum(m[1]);
    var els = card.querySelectorAll('[class*="price"],[class*="Price"],strong,em,b');
    var best = 0, bestSize = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest(".sp-ov")) continue;
      var s = String(el.textContent || "").trim();
      if (!/^[0-9][0-9,]*\s*원?$/.test(s)) continue;
      var st = null;
      try { st = getComputedStyle(el); } catch (e) { st = null; }
      if (st && (st.textDecorationLine || "").indexOf("line-through") >= 0) continue;
      var size = st ? parseFloat(st.fontSize) || 0 : 0;
      if (size >= bestSize) { bestSize = size; best = toNum(s); }
    }
    return best;
  }

  /* ---------- 딱지 ---------- */
  function styleOnce() {
    if (document.getElementById("sp-ov-style")) return;
    var st = document.createElement("style");
    st.id = "sp-ov-style";
    st.textContent =
      ".sp-ov{position:absolute!important;z-index:9999;left:6px;top:6px;" +
      "background:rgba(12,60,52,.42);color:#fff;border-radius:9px;padding:7px 9px;" +
      "-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);text-shadow:0 1px 2px rgba(0,0,0,.55);" +
      "transition:background .15s ease;" +
      "font:600 11px/1.55 'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;" +
      "letter-spacing:-.2px;box-shadow:0 2px 8px rgba(0,0,0,.12);min-width:126px;" +
      "white-space:nowrap;text-align:left;}" +
      ".sp-ov b{font-weight:800;color:#8ff0d8;}" +
      ".sp-ov .sp-t{font-size:9.5px;font-weight:800;color:#7fd8c4;letter-spacing:.3px;margin-bottom:3px;cursor:move;user-select:none;}" +
      ".sp-ov .sp-mv{float:right;margin-left:8px;font-weight:600;color:#5fb7a4;}" +
      ".sp-ov:hover{background:rgba(12,60,52,.94);text-shadow:none;}" +
      ".sp-ov.sp-wait{background:rgba(60,66,72,.4);}" +
      ".sp-ov.sp-none{background:rgba(70,74,80,.4);color:#eef0f2;}" +
      ".sp-ov.sp-none:hover,.sp-ov.sp-wait:hover{background:rgba(60,66,72,.9);}" +
      ".sp-ov .sp-rv{display:block;width:100%;margin-top:6px;border:none;border-radius:6px;cursor:pointer;" +
      "background:#8ff0d8;color:#0c3c34;font:800 10.5px/1.9 'Pretendard','Apple SD Gothic Neo',sans-serif;}" +
      ".sp-ov .sp-rv:hover{background:#b8f7e7;}";
    (document.head || document.documentElement).appendChild(st);
  }

  function makeBadge(card, pid) {
    try {
      var pos = getComputedStyle(card).position;
      if (pos === "static") card.style.position = "relative";
    } catch (e) {}
    var b = document.createElement("div");
    b.className = "sp-ov sp-wait";
    b.setAttribute("data-sp-pid", pid);
    b.textContent = "불러오는 중";
    placeBadge(b);
    card.appendChild(b);
    return b;
  }

  function paint(b, pid, d, price) {
    if (!d || d.none || d.sold == null) {
      b.className = "sp-ov sp-none";
      b.innerHTML = '<div class="sp-t">SOURCING PRO</div>ID: ' + pid + "<br/>28일 자료 없음" +
        '<button class="sp-rv" data-sp-rv="' + pid + '">리뷰 분석</button>';
      return;
    }
    var sold = Number(d.sold) || 0;
    var views = d.views == null ? 0 : Number(d.views) || 0;
    var rev = price ? sold * price : 0;
    var cvr = views ? Math.round(sold / views * 1000) / 10 : 0;
    b.className = "sp-ov";
    b.innerHTML =
      '<div class="sp-t" title="끌어서 모서리로 옮기기 · 두 번 누르면 왼쪽 위">최근 28일<span class="sp-mv">⠿ 이동</span></div>' +
      "ID: " + pid + "<br/>" +
      "매출: <b>₩" + nf(rev) + "</b><br/>" +
      "판매가: " + (price ? "₩" + nf(price) : "-") + "<br/>" +
      "판매량: <b>" + nf(sold) + "</b><br/>" +
      "조회수: " + nf(views) + "<br/>" +
      "전환율: " + (cvr ? cvr + "%" : "-") +
      '<button class="sp-rv" data-sp-rv="' + pid + '">리뷰 분석</button>';
  }

  /* ---------- 윙에 차례로 묻기 ---------- */
  function pump() {
    if (working || stopped) return;
    var job = queue.shift();
    if (!job) return;
    working = true;
    chrome.runtime.sendMessage({ type: "wing28", productId: job.pid }, function (res) {
      working = false;
      var err = chrome.runtime.lastError;
      if (err || !res) {
        delete asked[job.pid];
      } else if (res.ok) {
        known[job.pid] = (res.data && res.data.sold != null) ? res.data : { none: true };
      } else if (res.needsWing || res.needsLogin) {
        stopped = true;
        queue.length = 0;
        notice(res.needsLogin
          ? "쿠팡 윙에 한 번 로그인하면 최근 28일 판매량이 표시됩니다."
          : "쿠팡 윙에서 28일 실적을 받지 못했습니다. 윙에 로그인했는지 확인해주세요.");
        sweep();
        return;
      } else {
        known[job.pid] = { none: true };
      }
      apply();
      setTimeout(pump, 240);
    });
  }

  /* 아직 값이 없는 딱지를 지운다 */
  function sweep() {
    painting = true;
    var all = document.querySelectorAll(".sp-ov.sp-wait");
    for (var i = 0; i < all.length; i++) all[i].remove();
    painting = false;
  }

  /* ---------- 화면 훑기 ---------- */
  /* 카드마다 딱지가 붙어 있는지 보고, 없으면 붙인다.
     이미 받아둔 값이 있으면 그 자리에서 바로 채운다. */
  function apply() {
    if (!ON) return;
    styleOnce();
    painting = true;

    var anchors = document.querySelectorAll('a[href*="/vp/products/"]');
    var fresh = 0;

    for (var i = 0; i < anchors.length; i++) {
      var pid = pidOf(anchors[i].getAttribute("href"));
      if (!pid) continue;
      var card = cardOf(anchors[i]);
      if (!card || !card.getBoundingClientRect) continue;

      var have = card.querySelector(".sp-ov");
      var data = known[pid];

      if (!have) {
        if (!data) {
          /* 아직 받지 못한 것은, 화면 가까이 왔고 더 물어볼 여유가 있을 때만 붙인다 */
          if (stopped || asked[pid] || askedCount() >= MAX_FETCH) continue;
          var box = card.getBoundingClientRect();
          if (box.top > window.innerHeight * 2.5) continue;
          asked[pid] = true;
          queue.push({ pid: pid, card: card });
          makeBadge(card, pid);
          fresh++;
          continue;
        }
        have = makeBadge(card, pid);
      }
      if (data) paint(have, pid, data, priceOf(card));
    }

    painting = false;
    if (fresh) pump();
  }

  function schedule(ms) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(apply, ms || 400);
  }

  function clearAll() {
    painting = true;
    var all = document.querySelectorAll(".sp-ov");
    for (var i = 0; i < all.length; i++) all[i].remove();
    painting = false;
    queue.length = 0;
  }

  /* ---------- 안내줄 ---------- */
  function notice(text) {
    var old = document.getElementById("sp-ov-note");
    if (old) old.remove();
    var n = document.createElement("div");
    n.id = "sp-ov-note";
    n.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483000;" +
      "background:#12a58c;color:#fff;border-radius:11px;padding:11px 16px;" +
      "font:700 12.5px/1.5 'Pretendard','Apple SD Gothic Neo',sans-serif;letter-spacing:-.2px;" +
      "box-shadow:0 10px 26px rgba(16,24,40,.28);display:flex;align-items:center;gap:12px;";
    n.innerHTML = "<span>" + text + "</span>" +
      '<button id="sp-ov-open" style="border:none;border-radius:8px;padding:6px 11px;' +
      "font:700 11.5px sans-serif;background:#fff;color:#0e8f79;cursor:pointer;\">윙 열기</button>" +
      '<span id="sp-ov-close" style="cursor:pointer;opacity:.8;">✕</span>';
    document.body.appendChild(n);
    var open = n.querySelector("#sp-ov-open");
    if (open) open.onclick = function () {
      chrome.runtime.sendMessage({ type: "wingOpen" }, function () {
        stopped = false;
        asked = {};
        n.remove();
        schedule(1200);
      });
    };
    var close = n.querySelector("#sp-ov-close");
    if (close) close.onclick = function () { n.remove(); };
  }

  /* ---------- 화면이 다시 그려지는지 지켜본다 ---------- */
  function watch() {
    var obs = new MutationObserver(function (list) {
      if (painting || !ON) return;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.target && m.target.closest && m.target.closest(".sp-ov")) continue;
        schedule(350);
        return;
      }
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 못 지켜보면 주기 훑기로 버틴다 */ }
  }

  /* ---------- 켜고 끄기 ---------- */
  chrome.storage.local.get(["spOverlay", "spBadgeCorner"], function (got) {
    ON = !(got && got.spOverlay === false);
    if (got && got.spBadgeCorner) {
      ["list", "detail"].forEach(function (k) {
        var v = got.spBadgeCorner[k];
        if (/^(tl|tr|bl|br)$/.test(String(v || ""))) cornerPref[k] = v;
      });
    }
    /* 예전에 거리로 기억해 둔 자리는 칸 크기가 달라 어긋나므로 버린다 */
    try { chrome.storage.local.remove("spBadgePos"); } catch (x) {}
    if (!ON) return;
    apply();
    watch();
    detailButton();
    /* 처음 30초는 주기적으로도 확인한다. 쿠팡이 목록을 늦게 채우는 경우가 있다. */
    var beat = setInterval(apply, 2000);
    setTimeout(function () { clearInterval(beat); }, 30000);
  });
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== "local" || !ch.spOverlay) return;
      ON = ch.spOverlay.newValue !== false;
      if (ON) { apply(); watch(); } else clearAll();
    });
  } catch (e) { /* 저장소 변화를 못 들으면 새로고침 때 반영된다 */ }

  /* ---------- 리뷰 분석 창 ----------
     상품 상세 화면에는 오른쪽 아래에 단추를 띄우고, 목록 딱지에는 단추를 붙인다.
     누르면 쿠팡 화면 위에 창이 뜬다. 리뷰를 받고 정리하는 일은 수집기가 뒤에서 한다. */
  function cardName(pid) {
    var b = document.querySelector('.sp-ov[data-sp-pid="' + pid + '"]');
    var card = b ? b.parentElement : null;
    if (card) {
      var im = card.querySelector("img[alt]");
      var alt = im ? String(im.getAttribute("alt") || "").trim() : "";
      if (alt.length > 3) return alt;
      var t = String(card.innerText || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 80);
    }
    return "";
  }
  function pageName() {
    var h = document.querySelector("h1");
    var t = h ? String(h.innerText || "").trim() : "";
    if (t) return t;
    var og = document.querySelector('meta[property="og:title"]');
    return og ? String(og.getAttribute("content") || "").trim() : String(document.title || "");
  }

  function reviewStyleOnce() {
    if (document.getElementById("sp-rm-style")) return;
    var st = document.createElement("style");
    st.id = "sp-rm-style";
    st.textContent =
      "#sp-rm,#sp-rm *{box-sizing:border-box;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;letter-spacing:-.2px;}" +
      "#sp-rm{position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,32,.45);display:flex;align-items:center;justify-content:center;padding:20px;}" +
      "#sp-rm .sp-rm-card{background:#fff;width:100%;max-width:600px;max-height:88vh;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;color:#1f2937;}" +
      "#sp-rm .sp-rm-head{padding:15px 18px;border-bottom:1px solid #eef1f4;display:flex;gap:10px;align-items:flex-start;}" +
      "#sp-rm .sp-rm-head h3{margin:0;font-size:15px;font-weight:800;color:#0c3c34;}" +
      "#sp-rm .sp-rm-head p{margin:3px 0 0;font-size:11.5px;color:#8a93a0;line-height:1.5;}" +
      "#sp-rm .sp-rm-x{margin-left:auto;border:none;background:#f1f3f6;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px;color:#5b6472;flex-shrink:0;}" +
      "#sp-rm .sp-rm-body{padding:14px 18px 18px;overflow:auto;font-size:12.5px;line-height:1.6;}" +
      "#sp-rm .sp-rm-wait{display:flex;align-items:center;gap:10px;padding:30px 4px;color:#6b7480;}" +
      "#sp-rm .sp-rm-spin{width:18px;height:18px;border:2.5px solid #d5eee6;border-top-color:#12a58c;border-radius:50%;animation:sprmspin .8s linear infinite;}" +
      "@keyframes sprmspin{to{transform:rotate(360deg)}}" +
      "#sp-rm .sp-rm-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;}" +
      "#sp-rm .sp-rm-k{background:#f7f9fa;border:1px solid #eef1f4;border-radius:10px;padding:8px 9px;}" +
      "#sp-rm .sp-rm-k b{display:block;font-size:16px;font-weight:800;color:#1b222c;}" +
      "#sp-rm .sp-rm-k span{font-size:10.5px;color:#8a93a0;}" +
      "#sp-rm .sp-rm-dist{margin-top:8px;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;}" +
      "#sp-rm .sp-rm-bar{font-size:10px;color:#8a93a0;}" +
      "#sp-rm .sp-rm-bar i{display:block;height:6px;border-radius:4px;background:#eef1f4;overflow:hidden;margin:2px 0;}" +
      "#sp-rm .sp-rm-bar i b{display:block;height:100%;background:#f5a524;}" +
      "#sp-rm .sp-rm-sum{margin-top:11px;background:#f4faf8;border:1px solid #d5eee6;border-radius:10px;padding:10px 12px;color:#1f4f45;}" +
      "#sp-rm .sp-rm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:11px;}" +
      "#sp-rm h4{margin:0 0 6px;font-size:12.5px;font-weight:800;}" +
      "#sp-rm h4.g{color:#12805f;} #sp-rm h4.b{color:#c53236;} #sp-rm h4.c{color:#7a5d1a;}" +
      "#sp-rm .sp-rm-it{border:1px solid #eef1f4;border-radius:9px;padding:7px 9px;margin-bottom:5px;}" +
      "#sp-rm .sp-rm-it.g{border-left:3px solid #16a34a;} #sp-rm .sp-rm-it.b{border-left:3px solid #e5484d;}" +
      "#sp-rm .sp-rm-pt{font-weight:700;display:flex;justify-content:space-between;gap:6px;}" +
      "#sp-rm .sp-rm-cnt{flex-shrink:0;font-size:10px;color:#6b7480;background:#f1f3f6;border-radius:9px;padding:0 6px;}" +
      "#sp-rm .sp-rm-q{font-size:11.5px;color:#6b7480;margin-top:2px;}" +
      "#sp-rm .sp-rm-ch{margin-top:10px;background:#fffaeb;border:1px solid #f4e7c4;border-radius:10px;padding:9px 12px;}" +
      "#sp-rm .sp-rm-ch ul{margin:0;padding-left:17px;color:#5e4a1c;}" +
      "#sp-rm .sp-rm-note{margin-top:11px;background:#fff7ed;border:1px solid #fde2c3;border-radius:10px;padding:9px 12px;color:#9a4d0f;font-size:12px;}" +
      "#sp-rm .sp-rm-rv{border-bottom:1px dashed #eef1f4;padding:6px 0;font-size:12px;color:#3f4753;}" +
      "#sp-rm .sp-rm-rv em{font-style:normal;font-weight:800;color:#f5a524;margin-right:5px;}" +
      "#sp-rm .sp-rm-foot{padding:11px 18px;border-top:1px solid #eef1f4;display:flex;gap:8px;justify-content:flex-end;}" +
      "#sp-rm .sp-rm-btn{border:1px solid #e8ebee;background:#fff;border-radius:9px;padding:8px 13px;font-size:12px;font-weight:700;color:#5b6472;cursor:pointer;}" +
      "#sp-rm .sp-rm-btn.p{background:#12a58c;border-color:#12a58c;color:#fff;}" +
      "#sp-rv-float{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:none;border-radius:24px;padding:12px 18px;cursor:pointer;" +
      "background:#0c3c34;color:#8ff0d8;font:800 13px/1 'Pretendard','Apple SD Gothic Neo',sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.28);}" +
      "#sp-rv-float:hover{background:#12574b;}" +
      "@media (max-width:560px){#sp-rm .sp-rm-kpis{grid-template-columns:repeat(2,1fr);} #sp-rm .sp-rm-grid{grid-template-columns:1fr;}}";
    (document.head || document.documentElement).appendChild(st);
  }

  function reviewText(name, d) {
    var ins = d.insight;
    var out = ["[리뷰 분석] " + name, "최근 리뷰 " + d.read + "개" + (d.average != null ? " · 평균 " + d.average : "")];
    if (ins) {
      if (ins.summary) out.push("\n총평: " + ins.summary);
      if ((ins.good || []).length) { out.push("\n좋은 점"); ins.good.forEach(function (g) { out.push("- " + g.point + " (" + g.count + "건) " + g.quote); }); }
      if ((ins.bad || []).length) { out.push("\n나쁜 점"); ins.bad.forEach(function (g) { out.push("- " + g.point + " (" + g.count + "건) " + g.quote); }); }
      if ((ins.chance || []).length) { out.push("\n수입해서 팔 때 노릴 점"); ins.chance.forEach(function (c) { out.push("- " + c); }); }
    } else {
      (d.lows || []).forEach(function (r) { out.push("- [" + r.stars + "점] " + r.text); });
    }
    return out.join("\n");
  }

  function renderReview(body, name, d) {
    var kpi = function (v, l) { return '<div class="sp-rm-k"><b>' + v + "</b><span>" + l + "</span></div>"; };
    var dist = [5, 4, 3, 2, 1].map(function (n) {
      var pct = Number((d.distribution || {})[n]) || 0;
      return '<div class="sp-rm-bar">' + n + '점 ' + pct + '%<i><b style="width:' + Math.min(100, pct) + '%"></b></i></div>';
    }).join("");
    var html =
      '<div class="sp-rm-kpis">' +
        kpi(nf(d.read), "읽은 최근 리뷰") +
        kpi(d.average != null ? d.average : "-", "평균 별점") +
        kpi(nf(d.lowCount), "3점 이하") +
        kpi(nf(d.photoCount), "사진 리뷰") +
      "</div>" +
      '<div class="sp-rm-dist">' + dist + "</div>";

    var ins = d.insight;
    if (ins) {
      var item = function (g, k) {
        return '<div class="sp-rm-it ' + k + '"><div class="sp-rm-pt">' + esc(g.point) +
          (g.count ? '<span class="sp-rm-cnt">' + nf(g.count) + "건</span>" : "") + "</div>" +
          (g.quote ? '<div class="sp-rm-q">“' + esc(g.quote) + "”</div>" : "") + "</div>";
      };
      if (ins.summary) html += '<div class="sp-rm-sum">' + esc(ins.summary) + "</div>";
      html += '<div class="sp-rm-grid">' +
        '<div><h4 class="g">좋은 점</h4>' + ((ins.good || []).length ? ins.good.map(function (g) { return item(g, "g"); }).join("") : '<div class="sp-rm-q">뚜렷한 칭찬이 없습니다</div>') + "</div>" +
        '<div><h4 class="b">나쁜 점</h4>' + ((ins.bad || []).length ? ins.bad.map(function (g) { return item(g, "b"); }).join("") : '<div class="sp-rm-q">뚜렷한 불만이 없습니다</div>') + "</div>" +
      "</div>";
      if ((ins.chance || []).length) {
        html += '<div class="sp-rm-ch"><h4 class="c">수입해서 팔 때 노릴 점</h4><ul>' +
          ins.chance.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul></div>";
      }
      if (ins.buyers || ins.options) {
        html += '<div class="sp-rm-q" style="margin-top:9px;">' +
          (ins.buyers ? "<b>구매자</b> " + esc(ins.buyers) + "<br/>" : "") +
          (ins.options ? "<b>옵션</b> " + esc(ins.options) : "") + "</div>";
      }
    } else {
      html += '<div class="sp-rm-note">' + (d.noApp
        ? "<b>소싱 프로 화면을 열어두면</b> 좋은 점과 나쁜 점을 문장으로 정리해 드립니다. 지금은 리뷰 원문만 보여드립니다."
        : "문장 정리를 하지 못했습니다. " + esc(d.appError || "") + " 리뷰 원문만 보여드립니다.") + "</div>";
      if ((d.lows || []).length) {
        html += '<h4 class="b" style="margin-top:12px;">최근 불만 리뷰</h4>' +
          d.lows.map(function (r) { return '<div class="sp-rm-rv"><em>' + r.stars + "점</em>" + esc(r.text) + "</div>"; }).join("");
      }
      if ((d.highs || []).length) {
        html += '<h4 class="g" style="margin-top:12px;">칭찬 리뷰</h4>' +
          d.highs.map(function (r) { return '<div class="sp-rm-rv"><em>' + r.stars + "점</em>" + esc(r.text) + "</div>"; }).join("");
      }
    }
    body.innerHTML = html;
  }

  function openReviewModal(pid, name, force) {
    reviewStyleOnce();
    var old = document.getElementById("sp-rm");
    if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.id = "sp-rm";
    wrap.innerHTML =
      '<div class="sp-rm-card" role="dialog" aria-modal="true">' +
        '<div class="sp-rm-head"><div><h3>리뷰 분석 · 최근 100개</h3><p>' + esc(String(name || "").slice(0, 70)) + "</p></div>" +
          '<button class="sp-rm-x" data-x="1">✕</button></div>' +
        '<div class="sp-rm-body"><div class="sp-rm-wait"><span class="sp-rm-spin"></span>' +
          "최근 리뷰를 읽고 좋은 점과 나쁜 점을 정리하는 중입니다. 20초쯤 걸립니다.</div></div>" +
        '<div class="sp-rm-foot">' +
          '<button class="sp-rm-btn" data-again="1" hidden>다시 분석</button>' +
          '<button class="sp-rm-btn p" data-copy="1" hidden>결과 복사</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    var body = wrap.querySelector(".sp-rm-body");
    var last = null;

    wrap.addEventListener("click", function (e) {
      var t = e.target;
      if (t === wrap || (t.getAttribute && t.getAttribute("data-x"))) { wrap.remove(); return; }
      if (t.getAttribute && t.getAttribute("data-again")) { openReviewModal(pid, name, true); return; }
      if (t.getAttribute && t.getAttribute("data-copy") && last) {
        try { navigator.clipboard.writeText(reviewText(name, last)); t.textContent = "복사했습니다"; } catch (x) {}
      }
    });

    chrome.runtime.sendMessage({ type: "reviewInsightFromPage", productId: pid, name: name, force: !!force }, function (res) {
      if (!document.body.contains(wrap)) return;
      var err = chrome.runtime.lastError;
      if (err || !res) {
        body.innerHTML = '<div class="sp-rm-note">수집기와 통신하지 못했습니다. 이 화면을 새로고침한 뒤 다시 눌러주세요.</div>';
        return;
      }
      if (!res.ok) {
        body.innerHTML = '<div class="sp-rm-note">' + esc(res.error || "리뷰를 받지 못했습니다.") + "</div>";
        wrap.querySelector("[data-again]").hidden = false;
        return;
      }
      last = res.data;
      renderReview(body, name, res.data);
      wrap.querySelector("[data-again]").hidden = false;
      wrap.querySelector("[data-copy]").hidden = false;
    });
  }

  /* ---------- 딱지 옮기기 ----------
     딱지가 상품명이나 가격을 가리면 윗줄을 잡고 끌어서 옮긴다.
     놓은 자리에서 가장 가까운 모서리(왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래)에 붙는다.
     거리로 기억하면 칸 크기가 다른 곳에서 딱지가 상품 밖으로 나가므로, 모서리로만 기억한다.
     목록 화면과 상세 화면은 따로 기억한다. 윗줄을 두 번 누르면 왼쪽 위로 돌아간다. */
  function badgeMode() { return /\/vp\/products\/\d+/.test(location.pathname) ? "detail" : "list"; }
  function placeBadge(b) {
    var c = cornerPref[badgeMode()] || "tl";
    var gap = "6px";
    b.style.transform = "";
    b.style.left = c.charAt(1) === "l" ? gap : "auto";
    b.style.right = c.charAt(1) === "r" ? gap : "auto";
    b.style.top = c.charAt(0) === "t" ? gap : "auto";
    b.style.bottom = c.charAt(0) === "b" ? gap : "auto";
  }
  function placeAll() {
    var all = document.querySelectorAll(".sp-ov");
    for (var i = 0; i < all.length; i++) placeBadge(all[i]);
  }
  function savePos() {
    try { chrome.storage.local.set({ spBadgeCorner: cornerPref }); } catch (x) { /* 저장 못 해도 이번 화면에는 적용된다 */ }
  }
  var drag = null;
  var justDragged = 0;
  document.addEventListener("mousedown", function (e) {
    var head = e.target && e.target.closest ? e.target.closest(".sp-ov .sp-t") : null;
    if (!head) return;
    var b = head.closest(".sp-ov");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { b: b, sx: e.clientX, sy: e.clientY, moved: false };
  }, true);
  document.addEventListener("mousemove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.b.style.transform = "translate(" + dx + "px," + dy + "px)";
  }, true);
  document.addEventListener("mouseup", function (e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (!d.moved) { d.b.style.transform = ""; return; }
    e.preventDefault();
    e.stopPropagation();
    justDragged = Date.now();
    var card = d.b.parentElement;
    var cr = card && card.getBoundingClientRect ? card.getBoundingClientRect() : null;
    var br = d.b.getBoundingClientRect();
    if (cr && cr.width && cr.height) {
      var cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      var v = cy < cr.top + cr.height / 2 ? "t" : "b";
      var h = cx < cr.left + cr.width / 2 ? "l" : "r";
      cornerPref[badgeMode()] = v + h;
    }
    placeAll();
    savePos();
  }, true);
  document.addEventListener("click", function (e) {
    if (Date.now() - justDragged < 400 && e.target && e.target.closest && e.target.closest(".sp-ov")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  document.addEventListener("dblclick", function (e) {
    var head = e.target && e.target.closest ? e.target.closest(".sp-ov .sp-t") : null;
    if (!head) return;
    e.preventDefault();
    e.stopPropagation();
    cornerPref[badgeMode()] = "tl";
    placeAll();
    savePos();
  }, true);

  /* 목록 딱지 안의 단추. 상품 링크 안에 들어 있어서 누르면 상품으로 넘어가 버리므로 먼저 막는다. */
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-sp-rv]") : null;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    var pid = t.getAttribute("data-sp-rv");
    openReviewModal(pid, cardName(pid) || ("상품 " + pid));
  }, true);

  function detailButton() {
    var m = String(location.pathname || "").match(/\/vp\/products\/(\d+)/);
    if (!m || document.getElementById("sp-rv-float")) return;
    reviewStyleOnce();
    var b = document.createElement("button");
    b.id = "sp-rv-float";
    b.textContent = "리뷰 분석";
    b.onclick = function (e) {
      e.preventDefault();
      openReviewModal(m[1], pageName());
    };
    document.body.appendChild(b);
  }

  window.addEventListener("scroll", function () { schedule(500); }, { passive: true });
  window.addEventListener("load", function () { schedule(600); });
})();
