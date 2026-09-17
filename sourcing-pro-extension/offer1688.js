/* Sourcing Pro 수집기 — 1688 상품 상세 화면에서 사진, 상품 정보, 옵션을 한 번에 가져온다.

   오른쪽 아래 단추를 누르면 창이 뜬다. 값은 페이지 안 데이터에서 읽으므로 화면 모양이 바뀌어도 버틴다.
   사진과 정보 파일은 크롬 다운로드 폴더 아래 1688/<상품번호_상품명> 폴더에 모인다. */
(function () {
  "use strict";
  /* 수집기를 새로고침해도 페이지에는 이전 버전의 표시가 남는다.
     표시만 보고 멈추면 새 버전이 아무 일도 안 하므로, 이전 것이 아직 살아 있을 때만 건너뛴다. */
  if (typeof window.__spOffer1688Ready === "function" && window.__spOffer1688Ready()) return;
  window.__spOffer1688Ready = function () { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  /* 이전 버전이 남긴 단추는 눌러도 동작하지 않으므로 치운다 */
  Array.prototype.forEach.call(document.querySelectorAll("#sp-of-float, #sp-of-style"), function (el) { el.remove(); });
  if (!/\/offer\/\d+\.html/i.test(location.pathname)) return;

  var last = null;

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function nf(n) {
    var v = Number(n);
    return isFinite(v) ? v.toLocaleString("ko-KR") : "-";
  }

  var PACK_LABEL = { length: "길이(cm)", width: "너비(cm)", height: "높이(cm)", volume: "부피(cm³)", weight: "무게(g)" };

  /* ---------- 글로 옮기기 ---------- */
  function infoText(d) {
    var out = [];
    out.push("[1688 상품 정보]");
    out.push("상품명: " + d.title);
    out.push("상품번호: " + d.offerId);
    out.push("주소: " + d.url);
    if (d.category) out.push("카테고리: " + d.category);
    if (d.shop) out.push("판매처: " + d.shop);
    out.push("가격: ¥" + d.minPrice + (d.maxPrice && d.maxPrice !== d.minPrice ? " ~ ¥" + d.maxPrice : ""));
    if ((d.tiers || []).length) {
      out.push("구간 가격: " + d.tiers.map(function (t) { return t.from + d.unit + " 이상 ¥" + t.price; }).join(" / "));
    }
    if (d.moq != null) out.push("최소 주문: " + d.moq + d.unit);
    if (d.saleCount != null) out.push("판매량: " + d.saleCount);

    if ((d.options || []).length) {
      out.push("\n[옵션]");
      d.options.forEach(function (p) {
        out.push(p.prop + ": " + p.values.map(function (v) { return v.name; }).join(" | "));
      });
    }
    if ((d.skus || []).length) {
      out.push("\n[옵션별 가격·재고]");
      d.skus.forEach(function (k) {
        var size = k.length != null ? " · " + k.length + "×" + k.width + "×" + k.height + "cm" : "";
        var w = k.weight != null ? " · " + k.weight + "g" : "";
        out.push("- " + k.spec + " · ¥" + k.price + " · 재고 " + (k.stock != null ? k.stock : "-") + size + w);
      });
    }
    if ((d.attrs || []).length) {
      out.push("\n[상품 속성]");
      d.attrs.forEach(function (a) { out.push(a.name + ": " + a.value); });
    }
    if (d.descText) out.push("\n[상세 설명 글]\n" + d.descText);
    out.push("\n[사진] 대표 " + d.mainImages.length + "장 · 옵션 " + optionImageCount(d) + "장 · 상세 " + d.descImages.length + "장" +
      (d.video ? " · 영상 1개" : ""));
    return out.join("\n");
  }

  function csvCell(v) {
    var t = String(v == null ? "" : v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function optionCsv(d) {
    var rows = [["옵션", "가격(위안)", "재고", "판매량", "길이(cm)", "너비(cm)", "높이(cm)", "무게(g)", "skuId"]];
    (d.skus || []).forEach(function (k) {
      rows.push([k.spec, k.price, k.stock, k.sold, k.length, k.width, k.height, k.weight, k.skuId]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
  }
  function optionImageCount(d) {
    var n = 0;
    (d.options || []).forEach(function (p) { (p.values || []).forEach(function (v) { if (v.image) n++; }); });
    return n;
  }

  /* ---------- 모양 ---------- */
  function styleOnce() {
    if (document.getElementById("sp-of-style")) return;
    var st = document.createElement("style");
    st.id = "sp-of-style";
    st.textContent =
      "#sp-of,#sp-of *{box-sizing:border-box;font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;letter-spacing:-.2px;}" +
      "#sp-of{position:fixed;inset:0;z-index:2147483600;background:rgba(15,23,32,.45);display:flex;align-items:center;justify-content:center;padding:20px;}" +
      "#sp-of .c{background:#fff;width:100%;max-width:760px;max-height:90vh;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;color:#1f2937;}" +
      "#sp-of .h{padding:15px 18px;border-bottom:1px solid #eef1f4;display:flex;gap:10px;align-items:flex-start;}" +
      "#sp-of .h h3{margin:0;font-size:15px;font-weight:800;color:#b3470f;}" +
      "#sp-of .h p{margin:3px 0 0;font-size:12px;color:#6b7480;line-height:1.5;}" +
      "#sp-of .x{margin-left:auto;border:none;background:#f1f3f6;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px;color:#5b6472;flex-shrink:0;}" +
      "#sp-of .b{padding:14px 18px;overflow:auto;font-size:12.5px;line-height:1.6;}" +
      "#sp-of .w{display:flex;align-items:center;gap:10px;padding:30px 4px;color:#6b7480;}" +
      "#sp-of .sp{width:18px;height:18px;border:2.5px solid #fde2c3;border-top-color:#ff6a00;border-radius:50%;animation:spofspin .8s linear infinite;}" +
      "@keyframes spofspin{to{transform:rotate(360deg)}}" +
      "#sp-of .k{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;}" +
      "#sp-of .k div{background:#fff8f2;border:1px solid #fde6d3;border-radius:10px;padding:8px 9px;}" +
      "#sp-of .k b{display:block;font-size:15px;font-weight:800;color:#1b222c;}" +
      "#sp-of .k span{font-size:10.5px;color:#8a93a0;}" +
      "#sp-of h4{margin:14px 0 6px;font-size:12.5px;font-weight:800;color:#3f4753;}" +
      "#sp-of .tw{overflow-x:auto;border:1px solid #eef1f4;border-radius:10px;}" +
      "#sp-of table{width:100%;border-collapse:collapse;font-size:11.5px;}" +
      "#sp-of th{background:#fafbfc;color:#8a93a0;font-weight:700;text-align:left;padding:6px 8px;white-space:nowrap;border-bottom:1px solid #eef1f4;}" +
      "#sp-of td{padding:6px 8px;border-bottom:1px solid #f3f5f7;color:#3f4753;vertical-align:middle;}" +
      "#sp-of td.r,#sp-of th.r{text-align:right;white-space:nowrap;}" +
      "#sp-of .th{display:flex;gap:6px;flex-wrap:wrap;}" +
      "#sp-of .th img{width:58px;height:58px;object-fit:cover;border-radius:8px;border:1px solid #eef1f4;background:#f5f6f8;}" +
      "#sp-of .ov{display:flex;align-items:center;gap:7px;}" +
      "#sp-of .ov img{width:30px;height:30px;object-fit:cover;border-radius:6px;border:1px solid #eef1f4;flex-shrink:0;}" +
      "#sp-of .at{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 14px;font-size:11.5px;}" +
      "#sp-of .at div{display:flex;gap:6px;border-bottom:1px dashed #eef1f4;padding:3px 0;}" +
      "#sp-of .at b{color:#8a93a0;font-weight:600;flex-shrink:0;min-width:74px;}" +
      "#sp-of .n{margin-top:10px;background:#fff7ed;border:1px solid #fde2c3;border-radius:10px;padding:9px 12px;color:#9a4d0f;font-size:12px;}" +
      "#sp-of .ok{background:#e9f9f4;border-color:#c7ece1;color:#0e7a66;}" +
      "#sp-of .f{padding:11px 18px;border-top:1px solid #eef1f4;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}" +
      "#sp-of .ck{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:#5b6472;margin-right:auto;}" +
      "#sp-of .ck label{display:flex;align-items:center;gap:4px;cursor:pointer;}" +
      "#sp-of .ck input{accent-color:#ff6a00;}" +
      "#sp-of .bt{border:1px solid #e8ebee;background:#fff;border-radius:9px;padding:8px 13px;font-size:12px;font-weight:700;color:#5b6472;cursor:pointer;}" +
      "#sp-of .bt.p{background:#ff6a00;border-color:#ff6a00;color:#fff;}" +
      "#sp-of .bt:disabled{opacity:.55;cursor:default;}" +
      "#sp-of-float{position:fixed;right:22px;bottom:22px;z-index:2147483000;border:none;border-radius:24px;padding:12px 18px;cursor:pointer;" +
      "background:#ff6a00;color:#fff;font:800 13px/1 'Pretendard','Apple SD Gothic Neo',sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.25);}" +
      "#sp-of-float:hover{background:#e25d00;}" +
      "@media (max-width:620px){#sp-of .k{grid-template-columns:repeat(2,1fr);} #sp-of .at{grid-template-columns:1fr;}}";
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 창 ---------- */
  function render(body, d) {
    var skuHasSize = (d.skus || []).some(function (k) { return k.length != null || k.weight != null; });
    var optImg = {};
    (d.options || []).forEach(function (p) {
      (p.values || []).forEach(function (v) { if (v.image) optImg[v.name] = v.image; });
    });
    var imgFor = function (spec) {
      for (var name in optImg) if (spec.indexOf(name) >= 0) return optImg[name];
      return "";
    };

    var html =
      '<div class="k">' +
        "<div><b>¥" + esc(d.minPrice) + (d.maxPrice && d.maxPrice !== d.minPrice ? " ~ " + esc(d.maxPrice) : "") + "</b><span>가격</span></div>" +
        "<div><b>" + (d.moq != null ? esc(d.moq) + esc(d.unit) : "-") + "</b><span>최소 주문</span></div>" +
        "<div><b>" + nf((d.skus || []).length) + "</b><span>옵션 수</span></div>" +
        "<div><b>" + (d.saleCount != null ? nf(d.saleCount) : "-") + "</b><span>판매량</span></div>" +
      "</div>";

    if ((d.tiers || []).length > 1) {
      html += "<h4>구간 가격</h4><div>" + d.tiers.map(function (t) {
        return esc(t.from) + esc(d.unit) + " 이상 <b>¥" + esc(t.price) + "</b>";
      }).join(" · ") + "</div>";
    }

    html += "<h4>대표 사진 " + d.mainImages.length + "장</h4><div class=\"th\">" +
      d.mainImages.slice(0, 12).map(function (u) { return '<img src="' + esc(u) + '" alt="">'; }).join("") + "</div>";

    if ((d.skus || []).length) {
      html += "<h4>옵션 " + d.skus.length + "개</h4><div class=\"tw\"><table><thead><tr>" +
        "<th>옵션</th><th class=\"r\">가격</th><th class=\"r\">재고</th>" +
        (skuHasSize ? "<th class=\"r\">크기(cm)</th><th class=\"r\">무게(g)</th>" : "") +
        "</tr></thead><tbody>" +
        d.skus.map(function (k) {
          var im = imgFor(k.spec);
          return "<tr><td><div class=\"ov\">" + (im ? '<img src="' + esc(im) + '" alt="">' : "") + esc(k.spec) + "</div></td>" +
            "<td class=\"r\">¥" + esc(k.price) + "</td>" +
            "<td class=\"r\">" + (k.stock != null ? nf(k.stock) : "-") + "</td>" +
            (skuHasSize
              ? "<td class=\"r\">" + (k.length != null ? esc(k.length + "×" + k.width + "×" + k.height) : "-") + "</td>" +
                "<td class=\"r\">" + (k.weight != null ? nf(k.weight) : "-") + "</td>"
              : "") +
            "</tr>";
        }).join("") + "</tbody></table></div>";
    } else if ((d.options || []).length) {
      html += "<h4>옵션</h4>" + d.options.map(function (p) {
        return "<div><b>" + esc(p.prop) + "</b> " + p.values.map(function (v) { return esc(v.name); }).join(" · ") + "</div>";
      }).join("");
    }

    if ((d.attrs || []).length) {
      html += "<h4>상품 속성 " + d.attrs.length + "개</h4><div class=\"at\">" +
        d.attrs.map(function (a) { return "<div><b>" + esc(a.name) + "</b><span>" + esc(a.value) + "</span></div>"; }).join("") +
        "</div>";
    }

    html += "<h4>상세 사진 " + d.descImages.length + "장" + (d.video ? " · 영상 1개" : "") + "</h4>";
    if (!d.descImages.length) html += '<div class="n">상세 사진을 찾지 못했습니다. 화면을 아래까지 한 번 내린 뒤 다시 열어보세요.</div>';

    body.innerHTML = html;
  }

  function open() {
    styleOnce();
    var old = document.getElementById("sp-of");
    if (old) old.remove();
    var wrap = document.createElement("div");
    wrap.id = "sp-of";
    wrap.innerHTML =
      '<div class="c" role="dialog" aria-modal="true">' +
        '<div class="h"><div><h3>1688 상품 담기</h3><p id="spOfTitle">상품 정보를 읽는 중입니다</p></div>' +
          '<button class="x" data-x="1">✕</button></div>' +
        '<div class="b"><div class="w"><span class="sp"></span>사진, 상품 정보, 옵션을 읽는 중입니다.</div></div>' +
        '<div class="f">' +
          '<div class="ck">' +
            '<label><input type="checkbox" data-k="main" checked>대표 사진</label>' +
            '<label><input type="checkbox" data-k="option" checked>옵션 사진</label>' +
            '<label><input type="checkbox" data-k="desc" checked>상세 사진</label>' +
            '<label><input type="checkbox" data-k="video">영상</label>' +
            '<label><input type="checkbox" data-k="info" checked>정보 파일</label>' +
          "</div>" +
          '<button class="bt" data-copy="1" disabled>정보 복사</button>' +
          '<button class="bt p" data-dl="1" disabled>선택한 것 받기</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    var body = wrap.querySelector(".b");
    var copyBtn = wrap.querySelector("[data-copy]");
    var dlBtn = wrap.querySelector("[data-dl]");
    var note = function (text, ok) {
      var n = document.createElement("div");
      n.className = "n" + (ok ? " ok" : "");
      n.innerHTML = text;
      body.appendChild(n);
      n.scrollIntoView({ block: "nearest" });
    };

    wrap.addEventListener("click", function (e) {
      var t = e.target;
      if (t === wrap || (t.getAttribute && t.getAttribute("data-x"))) { wrap.remove(); return; }
      if (!last) return;
      if (t.getAttribute && t.getAttribute("data-copy")) {
        navigator.clipboard.writeText(infoText(last)).then(
          function () { t.textContent = "복사했습니다"; setTimeout(function () { t.textContent = "정보 복사"; }, 1500); },
          function () { note("복사하지 못했습니다."); }
        );
      }
      if (t.getAttribute && t.getAttribute("data-dl")) {
        var kinds = {};
        Array.prototype.forEach.call(wrap.querySelectorAll("[data-k]"), function (c) { kinds[c.getAttribute("data-k")] = c.checked; });
        dlBtn.disabled = true;
        dlBtn.textContent = "받는 중";
        chrome.runtime.sendMessage({
          type: "offer1688Download", data: last, kinds: kinds,
          infoText: infoText(last), optionCsv: optionCsv(last)
        }, function (res) {
          dlBtn.disabled = false;
          dlBtn.textContent = "선택한 것 받기";
          if (chrome.runtime.lastError || !res) { note("수집기와 통신하지 못했습니다. 화면을 새로고침한 뒤 다시 눌러주세요."); return; }
          if (!res.ok) { note(esc(res.error || "받지 못했습니다.")); return; }
          var r = res.data;
          note("<b>" + r.ok + "개 파일</b>을 받았습니다" + (r.fail ? " (실패 " + r.fail + "개)" : "") +
            ". 다운로드 폴더의 <b>" + esc(r.folder) + "</b> 에 있습니다.", true);
        });
      }
    });

    chrome.runtime.sendMessage({ type: "offer1688Read" }, function (res) {
      if (!document.body.contains(wrap)) return;
      if (chrome.runtime.lastError || !res) {
        body.innerHTML = '<div class="n">수집기와 통신하지 못했습니다. 화면을 새로고침한 뒤 다시 눌러주세요.</div>';
        return;
      }
      if (!res.ok) {
        body.innerHTML = '<div class="n">' + esc(res.error || "읽지 못했습니다.") + "</div>";
        return;
      }
      last = res.data;
      wrap.querySelector("#spOfTitle").textContent = (last.title || "").slice(0, 90);
      render(body, last);
      copyBtn.disabled = false;
      dlBtn.disabled = false;
      var vid = wrap.querySelector('[data-k="video"]');
      if (vid && !last.video) { vid.checked = false; vid.disabled = true; vid.parentNode.style.opacity = ".45"; }
    });
  }

  function floatButton() {
    if (document.getElementById("sp-of-float")) return;
    styleOnce();
    var b = document.createElement("button");
    b.id = "sp-of-float";
    b.textContent = "사진·정보 담기";
    b.onclick = function (e) { e.preventDefault(); open(); };
    document.body.appendChild(b);
  }

  /* 수집기 아이콘 창에서 부르면 여기서 창을 연다 */
  try {
    chrome.runtime.onMessage.addListener(function (m, sender, respond) {
      if (!m || m.type !== "spOfferOpen") return;
      open();
      respond({ ok: true });
    });
  } catch (e) { /* 확장프로그램이 갱신되어 끊긴 경우 */ }

  if (document.body) floatButton();
  else document.addEventListener("DOMContentLoaded", floatButton);
})();
