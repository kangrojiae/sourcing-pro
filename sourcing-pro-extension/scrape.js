/* Sourcing Pro 수집기 — 상품 페이지에서 값을 읽는 콘텐츠 스크립트.
   쿠팡과 1688 모두 마크업이 자주 바뀌므로, 선택자는 여러 겹으로 시도하고
   실패하면 JSON-LD → og 메타 → 본문 텍스트 순으로 내려간다. */
(function () {
  "use strict";
  /* 수집기를 새로고침해도 페이지에는 이전 버전의 표시가 남는다.
     표시만 보고 멈추면 새 버전이 아무 일도 안 하므로, 이전 것이 아직 살아 있을 때만 건너뛴다. */
  if (typeof window.__spScrapeReady === "function" && window.__spScrapeReady()) return;
  window.__spScrapeReady = function () { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };

  /* ---------- 공통 도우미 ---------- */
  function txt(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }
  function pick(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      var t = txt(el);
      if (t) return t;
    }
    return "";
  }
  function pickAttr(selectors, attr) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var v = el.getAttribute(attr) || el[attr];
        if (v) return String(v);
      }
    }
    return "";
  }
  function meta(prop) {
    var el = document.querySelector('meta[property="' + prop + '"], meta[name="' + prop + '"]');
    return el ? String(el.getAttribute("content") || "").trim() : "";
  }
  function absUrl(u) {
    if (!u) return "";
    u = String(u).trim();
    if (u.indexOf("//") === 0) return location.protocol + u;
    if (u.indexOf("http") === 0) return u;
    if (u.indexOf("/") === 0) return location.origin + u;
    return u;
  }
  function toNum(s) {
    var m = String(s == null ? "" : s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }
  /* 이미지는 늦게 채워지거나 배경으로 깔리는 경우가 많아, 후보를 여러 개 모아 큰 것부터 넘긴다 */
  function imageCandidates(hostPattern) {
    var seen = [];
    var scored = [];
    function add(url, score) {
      if (!url) return;
      url = absUrl(String(url).trim());
      if (!/^https?:/i.test(url)) return;
      if (/\.gif(\?|$)/i.test(url)) return;
      if (/(blank|placeholder|loading|spacer)/i.test(url)) return;
      if (hostPattern && !hostPattern.test(url)) return;
      if (seen.indexOf(url) >= 0) return;
      seen.push(url);
      scored.push({ url: url, score: score || 0 });
    }

    var imgs = document.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var w = Math.max(el.naturalWidth || 0, el.clientWidth || 0);
      var h = Math.max(el.naturalHeight || 0, el.clientHeight || 0);
      var area = w * h;
      if (w && w < 80) continue;
      var attrs = ["src", "data-src", "data-lazy-src", "data-original", "data-image", "data-ks-lazyload"];
      for (var a = 0; a < attrs.length; a++) add(el.getAttribute(attrs[a]), area);
    }

    var bgs = document.querySelectorAll('[style*="background-image"]');
    for (var j = 0; j < bgs.length; j++) {
      var m = (bgs[j].getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/);
      if (m) {
        var r = bgs[j].getBoundingClientRect();
        add(m[2], (r.width || 0) * (r.height || 0));
      }
    }

    add(meta("og:image"), 1);

    scored.sort(function (x, y) { return y.score - x.score; });
    return scored.slice(0, 6).map(function (s) { return s.url; });
  }

  /* 알리 이미지 주소 뒤에 붙는 축소판 표시를 떼어 원본을 먼저 시도한다 */
  function expandAli(url) {
    return String(url)
      .replace(/\.(summ|search|preview)\.jpg$/i, "")
      .replace(/_\d{2,4}x\d{2,4}(xz)?(q\d+)?\.(jpg|jpeg|png|webp)$/i, "")
      .replace(/_\.webp$/i, "");
  }

  function jsonLd() {
    var out = [];
    var nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < nodes.length; i++) {
      try {
        var v = JSON.parse(nodes[i].textContent);
        if (Array.isArray(v)) out = out.concat(v);
        else out.push(v);
      } catch (e) { /* 잘못된 JSON은 무시 */ }
    }
    return out;
  }
  function ldProduct() {
    var all = jsonLd();
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (!n || typeof n !== "object") continue;
      var t = n["@type"];
      if (t === "Product" || (Array.isArray(t) && t.indexOf("Product") >= 0)) return n;
      if (n["@graph"]) {
        for (var j = 0; j < n["@graph"].length; j++) {
          var g = n["@graph"][j];
          if (g && (g["@type"] === "Product")) return g;
        }
      }
    }
    return null;
  }

  /* 줄이 그어졌거나 정가 자리에 있는 값인지 본다 */
  function isStruckPrice(el) {
    var n = el;
    for (var i = 0; i < 5 && n; i++) {
      var tag = String(n.tagName || "").toLowerCase();
      if (tag === "del" || tag === "s") return true;
      var cls = n.className;
      if (cls && cls.baseVal !== undefined) cls = cls.baseVal;
      if (typeof cls !== "string") cls = "";
      if (/origin|base-price|strike|through|before|discount-rate/i.test(cls)) return true;
      try {
        var st = window.getComputedStyle(n);
        var td = st && (st.textDecorationLine || st.textDecoration || "");
        if (String(td).indexOf("line-through") >= 0) return true;
      } catch (e) {}
      n = n.parentElement;
    }
    return false;
  }

  /* 쿠팡 상품 화면의 금액 후보를 모은다.
     클래스 이름은 자주 바뀌므로 사람이 보는 방식으로 고른다.
     구매 영역에서 줄이 그어지지 않은 금액 중 글자가 가장 큰 것이 판매가다.
     정가는 늘 작게 표시된다. */
  function coupangPriceCandidates() {
    var scope = document.querySelector(".prod-atf, .prod-buy, #contents") || document.body;
    var nodes = scope.querySelectorAll("strong, em, b, span, div");
    var out = [];
    for (var i = 0; i < nodes.length && i < 4000; i++) {
      var el = nodes[i];
      if (el.children && el.children.length > 2) continue;   /* 묶음 상자는 건너뛴다 */
      var t = txt(el);
      if (!t || t.length > 24) continue;
      if (!/[0-9][0-9,]{2,}/.test(t)) continue;
      if (/쿠폰|적립|배송|리뷰|상품평|%|당\s*[\d,]+\s*원/.test(t)) continue;
      if (isStruckPrice(el)) continue;
      var v = toNum(t);
      if (v < 100 || v > 50000000) continue;
      var size = 0;
      try { size = parseFloat(window.getComputedStyle(el).fontSize) || 0; } catch (e) {}
      out.push({ value: v, size: size });
    }
    out.sort(function (a, b) {
      if (b.size !== a.size) return b.size - a.size;   /* 큰 글자 먼저 */
      return a.value - b.value;                        /* 같으면 싼 쪽 */
    });
    return out;
  }

  /* 예전 방식 — 클래스 이름으로 찾는다. 위 방식이 빈손일 때만 쓴다. */
  /* 화면 글에서 곧바로 읽는 규칙들. 마크업이 어떻든 글자만 맞으면 통한다.
     쿠팡 상세 화면은 "46% 39,600원  21,300원 (1개당 21,300원)" 처럼 적는다. */
  function coupangPriceFromText() {
    var box = document.querySelector(".prod-atf, .prod-buy, #contents") || document.body;
    var body = String(box.innerText || box.textContent || "").replace(/\s+/g, " ");

    /* 1) "21,300원 (1개당" — 괄호 앞의 값이 실제 결제 금액이다.
          할인이 있든 없든, 정가가 위에 있든 아래에 있든 이 자리는 늘 판매가다. */
    var m = body.match(/([0-9][0-9,]{2,})\s*원\s*[(\uFF08]\s*1\s*개당/);
    if (m) return toNum(m[1]);

    /* 2) 할인율 뒤 좁은 구간만 본다. 그 안에서 가장 싼 금액이 판매가다.
          쿠팡은 화면 너비에 따라 정가를 위에 두기도 하고 아래에 두기도 해서
          순서로 판단하면 틀린다. 판매가는 늘 정가보다 싸다는 점만 믿는다. */
    var i = body.search(/[0-9]{1,2}\s*%\s*[0-9]/);
    if (i < 0) return 0;
    var win = body.slice(i, i + 160).split(/적립|무료배송|배송비|다른 판매자|쿠폰/)[0];
    var vals = (win.match(/[0-9][0-9,]{2,}\s*원/g) || [])
      .map(function (t) { return toNum(t); })
      .filter(function (v) { return v >= 500 && v < 50000000; });
    return vals.length ? Math.min.apply(null, vals) : 0;
  }

  function coupangSalePrice() {
    var sels = [
      ".prod-sale-price .total-price strong",
      ".prod-sale-price .total-price",
      "span.total-price > strong",
      ".total-price strong",
      ".prod-price .total-price",
      ".price-amount.final-price-amount",
      '[class*="final-price"] [class*="amount"]',
      '[class*="prod-price"] strong'
    ];
    for (var i = 0; i < sels.length; i++) {
      var els = document.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (isStruckPrice(el)) continue;
        var t = txt(el);
        if (/쿠폰|적립|당\s*[\d,]+\s*원/.test(t)) continue;
        var v = toNum(t);
        if (v >= 100 && v < 50000000) return v;
      }
    }
    return 0;
  }

  /* ---------- 쿠팡 ---------- */
  function scrapeCoupang() {
    var ld = ldProduct() || {};
    var offer = ld.offers && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);

    var name = pick([
      "h1.prod-buy-header__title",
      "h2.prod-buy-header__title",
      ".prod-buy-header__title",
      "h1.product-title",
      ".product-buy-title",
      'h1[class*="title"]'
    ]) || ld.name || meta("og:title") || document.title.replace(/\s*[-|]\s*쿠팡.*$/, "").trim();

    /* 정가에 줄이 그어진 화면에서 정가를 읽어오면 안 된다.
       판매가는 정가를 넘지 않으므로, 얻은 값 중 가장 싼 것이 실제 결제 금액이다. */
    /* 글자에서 곧바로 읽히면 그게 가장 확실하다 */
    var textPrice = coupangPriceFromText();
    var cands = coupangPriceCandidates();
    var price = textPrice || (cands.length ? cands[0].value : 0);
    if (!price) price = coupangSalePrice();
    var ldPrice = offer ? toNum(offer.price) : 0;
    var metaPrice = toNum(meta("product:price:amount"));
    [ldPrice, metaPrice].forEach(function (v) {
      if (v >= 100 && v < 50000000 && (!price || v < price)) price = v;
    });
    /* 어느 숫자들이 보였는지 남겨 둔다. 값이 틀리면 이걸 보고 고친다. */
    var priceSeen = (textPrice ? "글자 " + textPrice + " · " : "") +
      cands.slice(0, 5).map(function (c) {
        return c.value + "(" + Math.round(c.size) + "px)";
      }).join(" ");

    /* 별점 — 구매 영역을 먼저 보고, 없으면 화면 전체에서 찾는다 */
    var ratingBox = document.querySelector(".prod-atf, .prod-buy, #contents") || document.body;
    var rating = ratingIn(ratingBox) || ratingIn(document.body);
    if (!rating && ld.aggregateRating) {
      var lv = Math.round(parseFloat(ld.aggregateRating.ratingValue) * 2) / 2;
      if (lv > 0 && lv <= 5) rating = lv.toFixed(1);
    }

    var reviews = toNum(pick([
      "#prodDetailReviewCount",
      ".product-rating .count",
      ".prod-buy-header__review-count",
      '[class*="review"] [class*="count"]'
    ]));
    if (!reviews && ld.aggregateRating) reviews = toNum(ld.aggregateRating.reviewCount || ld.aggregateRating.ratingCount);

    var crumbs = [];
    var nodes = document.querySelectorAll("#breadcrumb li a, .breadcrumb a, nav[class*=breadcrumb] a");
    for (var i = 0; i < nodes.length; i++) {
      var t = txt(nodes[i]);
      if (t && t !== "홈" && crumbs.indexOf(t) < 0) crumbs.push(t);
    }
    var category = crumbs.slice(0, 5).join(" › ");

    var picks = [];
    var main = pickAttr([
      "img.prod-image__detail",
      ".prod-image__detail",
      ".prod-image img",
      "#repImageContainer img",
      '[class*="product-image"] img'
    ], "src");
    if (main) picks.push(absUrl(main));
    var ldImg = ld.image && (Array.isArray(ld.image) ? ld.image[0] : ld.image);
    if (ldImg) picks.push(absUrl(ldImg));
    picks = picks.concat(imageCandidates(/(coupangcdn\.com|coupang\.com)/i));

    return {
      site: "coupang",
      name: name,
      price: price,
      priceSeen: priceSeen,
      rating: rating,
      reviews: reviews,
      category: category,
      image: picks[0] || "",
      imageCandidates: dedupe(picks)
    };
  }

  function dedupe(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && out.indexOf(list[i]) < 0) out.push(list[i]);
    }
    return out.slice(0, 6);
  }

  /* ---------- 1688 ---------- */
  function scrape1688() {
    var name = pick([
      ".title-text",
      ".d-title",
      ".offer-title",
      "h1.title",
      '[class*="offer-title"]',
      '[class*="title-first-column"]'
    ]) || meta("og:title") || document.title.replace(/[-_].*(阿里巴巴|1688).*$/, "").trim();

    /* 구간별 가격이 여러 개 노출되므로 가장 낮은 값을 기준가로 쓴다 */
    var priceNodes = document.querySelectorAll(
      ".price-text, .currency-num, .price-num, .od-pc-offer-price .price," +
      ' [class*="price-range"] [class*="price"], [class*="priceRange"] [class*="price"],' +
      ' [class*="offer-price"] [class*="value"], .price .value'
    );
    var prices = [];
    for (var i = 0; i < priceNodes.length; i++) {
      var v = toNum(txt(priceNodes[i]));
      if (v > 0 && v < 1000000) prices.push(v);
    }
    if (!prices.length) {
      var body = document.body ? document.body.innerText.slice(0, 20000) : "";
      var m = body.match(/¥\s*([\d,]+(\.\d+)?)/g) || [];
      for (var k = 0; k < m.length && k < 12; k++) {
        var pv = toNum(m[k]);
        if (pv > 0) prices.push(pv);
      }
    }
    var price = prices.length ? Math.min.apply(null, prices) : 0;

    var moqRaw = pick([
      ".quantity",
      '[class*="moq"]',
      '[class*="begin-amount"]',
      '[class*="minOrder"]'
    ]);
    if (!moqRaw && document.body) {
      var bm = document.body.innerText.match(/(\d+)\s*[件个台双套箱条只]?\s*起批/);
      if (bm) moqRaw = bm[1];
    }
    var moqNum = toNum(moqRaw);
    var moq = moqNum ? moqNum + "개" : "";

    var opts = [];
    var optNodes = document.querySelectorAll(
      '.sku-item-name, [class*="prop-name"], [class*="sku-item"] [class*="name"],' +
      ' .obj-content .table-sku td:first-child, [class*="specification"] [class*="name"]'
    );
    for (var j = 0; j < optNodes.length && opts.length < 8; j++) {
      var o = txt(optNodes[j]);
      if (o && o.length <= 24 && opts.indexOf(o) < 0) opts.push(o);
    }

    var picks = [];
    var gallery = pickAttr([
      ".detail-gallery-img",
      ".od-gallery-img",
      '[class*="gallery"] img',
      '[class*="main-image"] img',
      ".tab-trigger img"
    ], "src");
    if (gallery) picks.push(absUrl(gallery));
    picks = picks.concat(imageCandidates(/(alicdn\.com|1688\.com)/i));

    /* 원본 주소를 먼저, 실패하면 원래 축소판 주소를 쓰도록 둘 다 넘긴다 */
    var expanded = [];
    picks.forEach(function (u) {
      var big = expandAli(u);
      if (big !== u) expanded.push(big);
      expanded.push(u);
    });

    return {
      site: "1688",
      name: name,
      price: price,
      moq: moq,
      opt: opts.join(", "),
      image: expanded[0] || "",
      imageCandidates: dedupe(expanded)
    };
  }

  function scrapeOnce() {
    var host = location.hostname;
    if (/1688\.com$/.test(host) || /1688\.com$/.test(host.replace(/^.*?\./, ""))) return scrape1688();
    if (/coupang\.com$/.test(host) || host.indexOf("coupang.com") >= 0) return scrapeCoupang();
    return null;
  }

  /* 값이 스크립트로 늦게 채워지는 페이지가 있어, 핵심 필드가 찰 때까지 잠깐 기다린다 */
  /* 늦게 불러오는 이미지들이 실제로 로드되도록 한 번 흔들어 준다 */
  function nudgeLazyImages() {
    try {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
      var imgs = document.querySelectorAll("img[data-src], img[data-lazy-src], img[data-original]");
      for (var i = 0; i < imgs.length && i < 40; i++) {
        var el = imgs[i];
        var src = el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || el.getAttribute("data-original");
        if (src && !el.getAttribute("src")) el.setAttribute("src", src);
      }
    } catch (e) { /* 페이지가 막아 두었으면 그냥 넘어간다 */ }
  }

  function scrapeWhenReady(cb) {
    var start = Date.now();
    nudgeLazyImages();
    setTimeout(nudgeLazyImages, 1500);
    (function tick() {
      var d = null;
      try { d = scrapeOnce(); } catch (e) { d = null; }
      var enough = d && d.name && d.price > 0 &&
        d.imageCandidates && d.imageCandidates.length > 0;
      if (enough || Date.now() - start > 12000) {
        cb(d);
        return;
      }
      setTimeout(tick, 600);
    })();
  }

  /* 광고 노출인지 판단한다. 링크에 붙는 광고 표시가 가장 확실하고, 배지 글자를 함께 본다. */
  function isAd(host, href) {
    if (/sourceType=[^&]*ads?/i.test(href) || /isAddedCart|adsProductId|srp_product_ads/i.test(href)) return true;
    if (!host) return false;
    if (host.getAttribute && host.getAttribute("data-is-ad") === "true") return true;
    if (host.querySelector('[class*="ad-badge"], [class*="adMark"], [class*="AdMark"], [class*="AdBadge"]')) return true;
    var nodes = host.querySelectorAll("span, em, b, i, div");
    for (var i = 0; i < nodes.length && i < 60; i++) {
      var t = txt(nodes[i]);
      if (t.length <= 3 && (t === "광고" || t === "AD" || t === "Ad")) return true;
    }
    return false;
  }

  /* 상품 링크에서 위로 올라가며 그 상품 한 칸에 해당하는 영역을 찾는다.
     상품 링크가 둘 이상 들어오면 여러 상품이 섞인 것이므로 거기서 멈춘다. */
  function hostOf(a, countLinks, priceRe) {
    var el = a, fallback = null;
    for (var i = 0; i < 7 && el; i++) {
      if (countLinks(el) > 1) break;
      if (el.querySelector && el.querySelector("img")) {
        if (!fallback) fallback = el;
        if (priceRe.test(txt(el))) return el;
      }
      el = el.parentElement;
    }
    return fallback || a.parentElement || a;
  }

  /* 1688 상품 주소는 여러 형태다.
     detail.1688.com/offer/123.html 도 있고, air.1688.com 처럼 offerId=123 을 붙이기도 한다. */
  function offerIdOf(href) {
    var h = String(href || "");
    /* 상품 번호는 offer/ 뒤나 offerId= 뒤에만 있다. 주소 안의 다른 숫자는 믿지 않는다. */
    var m = h.match(/\/offer\/(\d{6,})/) ||
            h.match(/[?&]offerId=(\d{6,})/i) ||
            h.match(/[?&]offer_id=(\d{6,})/i);
    return m ? m[1] : "";
  }
  function offerAnchors(root) {
    var out = [];
    var all = (root || document).querySelectorAll("a[href]");
    for (var i = 0; i < all.length; i++) {
      if (offerIdOf(all[i].getAttribute("href"))) out.push(all[i]);
    }
    return out;
  }

  /* 붙어 있는 다른 숫자와 섞이지 않도록 "N원" 형태를 통째로 읽는다 */
  function wonIn(text) {
    var m = String(text || "").match(/([0-9][0-9,]*)\s*원/);
    if (m) return toNum(m[1]);
    var only = String(text || "").trim().match(/^([0-9][0-9,]*)$/);
    return only ? toNum(only[1]) : 0;
  }

  /* 금액으로 볼 수 없는 글자를 걸러낸다 */
  function notAPrice(t) {
    return /쿠폰|적립|할인|배송|리뷰|후기|상품평|별점|%|당\s*[\d,]+\s*원|^\s*[\d,]+\s*개\s*$/.test(t);
  }

  /* 카드 안의 판매가를 고른다.
     쿠팡은 판매가를 가장 크게 보여준다. 정가에는 줄을 긋는다.
     예전에는 카드 안에서 가장 작은 금액을 골랐는데, 그러면 적립금이나
     단위가격 같은 엉뚱한 숫자가 판매가로 들어왔다. */
  function priceIn(host) {
    var nodes = host.querySelectorAll("strong, em, b, span, div");
    var best = null;
    for (var i = 0; i < nodes.length && i < 600; i++) {
      var el = nodes[i];
      if (el.children && el.children.length > 2) continue;
      var t = txt(el);
      if (!t || t.length > 20) continue;
      if (!/[0-9]/.test(t)) continue;
      if (notAPrice(t)) continue;
      if (!/원/.test(t) && !/^[0-9][0-9,]*$/.test(t)) continue;
      var cls = el.className;
      if (cls && cls.baseVal !== undefined) cls = cls.baseVal;
      if (typeof cls !== "string") cls = "";
      if (/base|origin|Origin|Base|unit|Unit|coupon|Coupon|discount|Discount/.test(cls)) continue;
      if (el.closest && el.closest("del")) continue;
      if (isStruckPrice(el)) continue;
      var v = wonIn(t);
      if (v < 500 || v > 50000000) continue;
      var size = 0;
      try { size = parseFloat(window.getComputedStyle(el).fontSize) || 0; } catch (e) {}
      if (!best || size > best.size || (size === best.size && v < best.v)) {
        best = { v: v, size: size };
      }
    }
    if (best) return best.v;

    /* 그래도 못 찾으면 카드 글에서 첫 번째로 나오는 금액을 쓴다 */
    var body = txt(host)
      .replace(/\([^)]*당[^)]*\)/g, "")
      .replace(/[^\s]*쿠폰[^\s]*/g, "")
      .replace(/[^\s]*적립[^\s]*/g, "");
    var m = body.match(/([0-9][0-9,]{2,})\s*원/);
    var v2 = m ? toNum(m[1]) : 0;
    return (v2 >= 500 && v2 < 50000000) ? v2 : 0;
  }

  /* 별점은 별 그림의 너비로 표시되는 경우가 많다 */
  /* 별점을 읽는다. 쿠팡은 별 다섯 개를 그려놓고 채워진 정도로 점수를 보인다.
     화면마다 만드는 방식이 달라 여러 겹으로 시도한다.
     0.5점 단위이므로 마지막에 반올림해 맞춘다. */
  function ratingIn(host) {
    var half = function (n) {
      var v = Math.round(parseFloat(n) * 2) / 2;
      return (v > 0 && v <= 5) ? v.toFixed(1) : "";
    };
    var starish = function (el) {
      var c = el.className;
      if (c && c.baseVal !== undefined) c = c.baseVal;
      return /rating|star/i.test(String(c || ""));
    };

    /* 1) 채운 부분의 너비가 퍼센트로 적힌 경우 — 100% 가 5점 */
    var all = host.querySelectorAll("*");
    for (var i = 0; i < all.length && i < 1200; i++) {
      if (!starish(all[i])) continue;
      var st = all[i].getAttribute("style") || "";
      var wm = st.match(/width\s*:\s*([\d.]+)\s*%/);
      if (wm) {
        var r = half(parseFloat(wm[1]) / 20);
        if (r) return r;
      }
    }

    /* 2) 별 글자를 세는 경우 — ★★★★☆ */
    var body = txt(host);
    var full = (body.match(/★/g) || []).length;
    var empty = (body.match(/☆/g) || []).length;
    if (full && full + empty >= 4 && full + empty <= 6) {
      var r2 = half(full);
      if (r2) return r2;
    }

    /* 3) 별 하나하나가 따로 있고 채워진 것에 표시가 붙는 경우 */
    for (var j = 0; j < all.length && j < 1200; j++) {
      if (!starish(all[j])) continue;
      var kids = all[j].children || [];
      if (kids.length < 4 || kids.length > 6) continue;
      var score = 0;
      for (var k = 0; k < kids.length; k++) {
        var kc = String(kids[k].className || "") + " " +
                 (kids[k].getAttribute ? (kids[k].getAttribute("src") || "") : "");
        if (/half|반/i.test(kc)) score += 0.5;
        else if (/on\b|full|active|fill|selected/i.test(kc)) score += 1;
      }
      var r3 = half(score);
      if (r3) return r3;
    }

    /* 4) 숫자로 적힌 경우 */
    for (var m = 0; m < all.length && m < 1200; m++) {
      if (!starish(all[m])) continue;
      var t = txt(all[m]);
      var nm = t.match(/^([0-5](?:\.\d)?)$/) || t.match(/평점\s*([0-5](?:\.\d)?)/);
      if (nm) {
        var r4 = half(nm[1]);
        if (r4) return r4;
      }
    }

    /* 5) 그림 설명이나 제목에 적힌 경우 */
    var tagged = host.querySelectorAll("img[alt], [title], [aria-label]");
    for (var n = 0; n < tagged.length && n < 400; n++) {
      var s2 = (tagged[n].getAttribute("alt") || "") + " " +
               (tagged[n].getAttribute("title") || "") + " " +
               (tagged[n].getAttribute("aria-label") || "");
      var m2 = s2.match(/([0-5](?:\.\d)?)\s*점/) || s2.match(/별점\s*([0-5](?:\.\d)?)/) ||
               s2.match(/(?:rating|star)[^0-9]{0,6}([0-5](?:\.\d)?)/i);
      if (m2) {
        var r5 = half(m2[1]);
        if (r5) return r5;
      }
    }

    /* 6) "4.5 (1,402)" 처럼 리뷰 수 앞에 붙은 숫자 */
    var m3 = body.match(/\b([0-5](?:\.\d)?)\s*[(（]\s*[\d,]+\s*[)）]/);
    if (m3) {
      var r6 = half(m3[1]);
      if (r6) return r6;
    }
    return "";
  }

  function isRocket(host) {
    if (host.querySelector('img[alt*="로켓"], [class*="rocket"], [class*="Rocket"]')) return true;
    return /로켓/.test(txt(host));
  }

  function imageIn(host) {
    var imgs = host.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var src = el.getAttribute("src") || el.getAttribute("data-img-src") ||
                el.getAttribute("data-src") || el.getAttribute("data-original") || "";
      if (!src) continue;
      if (/blank|placeholder|loading|spacer/i.test(src)) continue;
      return absUrl(src);
    }
    return "";
  }

  function nameIn(host, a) {
    /* 상품 이미지의 대체 텍스트가 상품명인 경우가 많아 가장 먼저 본다 */
    var img = host.querySelector("img[alt]");
    var alt = img ? String(img.getAttribute("alt") || "").trim() : "";
    if (alt.length >= 4) return alt;

    var byClass = pickIn(host, [
      '[class*="productName"]', '[class*="ProductName"]', ".name",
      '[class*="descriptionArea"] div', '[class*="title"]'
    ]);
    if (byClass) return byClass;

    var t = txt(a);
    if (t.length >= 4) return t.replace(/[0-9][0-9,]{2,}\s*원.*$/, "").trim();
    return "";
  }
  function pickIn(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = root.querySelector(selectors[i]);
      var t = txt(el);
      if (t && t.length >= 3) return t;
    }
    return "";
  }

  /* 검색 결과 목록을 찾는다.
     쿠팡 화면에는 "함께 본 상품", "최근 본 상품" 같은 추천 목록이 여럿 붙어 있다.
     그쪽을 읽으면 검색어와 아무 상관 없는 물건이 나오므로, 본 목록만 골라야 한다. */
  function searchListRoot() {
    var named = ["#productList", "#product-list", "ul.search-product-list",
                 '[class*="search-product-list"]', '[class*="SearchProductList"]'];
    for (var i = 0; i < named.length; i++) {
      var el = document.querySelector(named[i]);
      if (el && el.querySelectorAll('a[href*="/vp/products/"]').length >= 3) return el;
    }
    /* 이름으로 못 찾으면 상품 링크가 가장 많은 목록을 본 목록으로 본다 */
    var best = null, bestN = 0;
    var lists = document.querySelectorAll("ul, ol");
    for (var j = 0; j < lists.length; j++) {
      var n = lists[j].querySelectorAll('a[href*="/vp/products/"]').length;
      if (n > bestN) { bestN = n; best = lists[j]; }
    }
    return bestN >= 5 ? best : null;
  }

  /* 추천 묶음 안에 있는 상품인지 본다 */
  function inSuggestBox(el) {
    var node = el;
    for (var i = 0; i < 7 && node; i++) {
      var cls = String(node.className || "");
      if (/recommend|related|similar|viewed|history|carousel|banner|ad-?list/i.test(cls)) return true;
      var head = node.querySelector ? node.querySelector("h2, h3, strong") : null;
      var ht = head ? (head.textContent || "") : "";
      if (/함께 본|최근 본|추천|이런 상품|같이 구매|인기 급상승/.test(ht)) return true;
      node = node.parentElement;
    }
    return false;
  }

  /* 다른 확장프로그램이 쿠팡 카드 위에 덧씌운 매출·판매량 딱지를 그대로 읽는다.
     클래스 이름이 아니라 글자를 보고 찾으므로, 그쪽이 모양을 바꿔도 계속 읽힌다.
     딱지에 적힌 ID 가 쿠팡 상품번호라서 그 번호로 상품과 짝을 맞춘다. */
  function overlayRoots() {
    var roots = [document];
    try {
      var all = document.querySelectorAll("*");
      for (var i = 0; i < all.length && roots.length < 40; i++) {
        if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
      }
    } catch (e) { /* 그림자 영역을 못 보면 본문만 본다 */ }
    return roots;
  }

  function overlayStats() {
    var map = {};
    var digits = function (v) { return toNum(String(v || "").replace(/[^0-9]/g, "")); };
    var roots = overlayRoots();

    for (var r = 0; r < roots.length; r++) {
      var walker;
      try {
        walker = document.createTreeWalker(roots[r], NodeFilter.SHOW_TEXT, null);
      } catch (e) { continue; }
      var node;
      while ((node = walker.nextNode())) {
        var raw = String(node.nodeValue || "");
        if (raw.indexOf("ID") < 0) continue;
        var idm = raw.match(/ID\s*[:\uFF1A]\s*(\d{6,})/);
        if (!idm) continue;

        /* 딱지 한 장을 통째로 담고 있는 가장 가까운 상자를 찾는다 */
        var box = node.parentElement;
        for (var up = 0; up < 6 && box; up++) {
          var t0 = box.textContent || "";
          if (t0.indexOf("\uD310\uB9E4\uB7C9") >= 0 || t0.indexOf("\uB9E4\uCD9C") >= 0) break;
          box = box.parentElement;
        }
        if (!box) continue;
        var t = String(box.textContent || "").slice(0, 400);
        if (t.indexOf("\uD310\uB9E4\uB7C9") < 0 && t.indexOf("\uB9E4\uCD9C") < 0) continue;

        var pid = idm[1];
        if (map[pid]) continue;

        var rev  = t.match(/\uB9E4\uCD9C\s*[:\uFF1A]\s*[^0-9\-]{0,3}([0-9][0-9,]*)/);
        var sold = t.match(/\uD310\uB9E4\uB7C9\s*[:\uFF1A]\s*[^0-9\-]{0,3}([0-9][0-9,]*)/);
        var view = t.match(/\uC870\uD68C\uC218\s*[:\uFF1A]\s*[^0-9\-]{0,3}([0-9][0-9,]*)/);
        var cvr  = t.match(/\uC804\uD658\uC728\s*[:\uFF1A]\s*[^0-9\-]{0,3}([0-9]+(?:\.[0-9]+)?)\s*%/);

        map[pid] = {
          sold: sold ? digits(sold[1]) : 0,
          revenue: rev ? digits(rev[1]) : 0,
          views: view ? digits(view[1]) : 0,
          cvr: cvr ? parseFloat(cvr[1]) : 0
        };
      }
    }
    return map;
  }

  /* 쿠팡 검색 결과에서 광고를 뺀 노출 순위를 뽑는다 */
  function searchTop(limit) {
    var want = limit || 5;
    var out = [];
    var seen = [];
    var root = searchListRoot();
    var anchors = root
      ? root.querySelectorAll('a[href*="/vp/products/"]')
      : document.querySelectorAll('ul li a[href*="/vp/products/"]');

    var stats = {};
    try { stats = overlayStats(); } catch (e) { stats = {}; }

    for (var i = 0; i < anchors.length && out.length < want; i++) {
      var a = anchors[i];
      var href = a.getAttribute("href") || "";
      var url = absUrl(href);
      var idm = url.match(/\/vp\/products\/(\d+)/);
      var pid = idm ? idm[1] : url;
      if (seen.indexOf(pid) >= 0) continue;

      var host = hostOf(a, function (el) {
        return el.querySelectorAll('a[href*="/vp/products/"]').length;
      }, /[0-9][0-9,]*\s*원/);
      if (isAd(host, url)) { seen.push(pid); continue; }
      if (!root && inSuggestBox(a)) { seen.push(pid); continue; }

      var name = nameIn(host, a);
      var price = priceIn(host);
      if (!name && !price) continue;
      seen.push(pid);

      var hostText = txt(host);
      var rvm = hostText.match(/\(\s*([\d,]+)\s*\)/);

      out.push({
        rank: out.length + 1,
        productId: pid,
        url: url,
        name: name,
        price: price,
        basePrice: 0,
        unitPrice: pickIn(host, ['[class*="unit-price"]', '[class*="unitPrice"]']),
        rating: ratingIn(host),
        reviews: rvm ? toNum(rvm[1]) : 0,
        rocket: isRocket(host),
        freeShip: /무료배송/.test(hostText),
        image: imageIn(host),
        sold: (stats[pid] && stats[pid].sold) || 0,
        revenue: (stats[pid] && stats[pid].revenue) || 0,
        views: (stats[pid] && stats[pid].views) || 0,
        cvr: (stats[pid] && stats[pid].cvr) || 0
      });
    }
    return out;
  }

  /* 쿠팡 첫 화면의 카테고리 차림표를 통째로 읽어 나무 모양으로 만든다.
     차림표는 마우스를 올려야 보이지만, 글자는 처음부터 문서에 들어 있다.
     번호를 우리가 외워 두면 쿠팡이 개편할 때 어긋난다. 그래서 그때그때 읽는다. */
  function coupangCatTree() {
    var root = document;
    var links = root.querySelectorAll('a[href*="/np/categories/"]');
    var idOf = function (h) {
      var m = String(h || "").match(/\/np\/categories\/(\d+)/);
      return m ? m[1] : "";
    };

    /* 각 링크가 몇 겹의 목록 안에 들어 있는지로 층을 가린다 */
    var rows = [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var id = idOf(a.getAttribute("href"));
      var name = txt(a).replace(/\s+/g, " ").trim();
      if (!id || !name || name.length > 24) continue;

      var chain = [];
      var el = a.parentElement;
      for (var d = 0; d < 12 && el && el !== document.body; d++) {
        if (el.tagName === "LI") chain.unshift(el);
        el = el.parentElement;
      }
      rows.push({ a: a, id: id, name: name, chain: chain });
    }

    /* 목록칸 하나가 어느 이름을 달고 있는지 정해 둔다 */
    var owner = [];
    var ownerOf = function (li) {
      for (var k = 0; k < owner.length; k++) if (owner[k].li === li) return owner[k].row;
      return null;
    };
    for (var j = 0; j < rows.length; j++) {
      var own = rows[j].chain[rows[j].chain.length - 1];
      if (own && !ownerOf(own)) owner.push({ li: own, row: rows[j] });
    }

    /* 위에서부터 붙여 나간다 */
    var tree = [];
    var seen = {};
    var find = function (list, id) {
      for (var k = 0; k < list.length; k++) if (list[k].id === id) return list[k];
      return null;
    };

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var lvl = row.chain.length;
      var url = row.a.href || ("https://www.coupang.com/np/categories/" + row.id);

      if (lvl <= 1) {
        if (!find(tree, row.id)) tree.push({ id: row.id, name: row.name, url: url, kids: [] });
        continue;
      }
      var p1 = ownerOf(row.chain[0]);
      if (!p1) continue;
      var top = find(tree, p1.id);
      if (!top) {
        top = { id: p1.id, name: p1.name,
                url: p1.a.href || ("https://www.coupang.com/np/categories/" + p1.id), kids: [] };
        tree.push(top);
      }
      if (lvl === 2) {
        if (!find(top.kids, row.id)) top.kids.push({ id: row.id, name: row.name, url: url, kids: [] });
        continue;
      }
      var p2 = ownerOf(row.chain[1]);
      if (!p2) continue;
      var mid = find(top.kids, p2.id);
      if (!mid) {
        mid = { id: p2.id, name: p2.name,
                url: p2.a.href || ("https://www.coupang.com/np/categories/" + p2.id), kids: [] };
        top.kids.push(mid);
      }
      if (!find(mid.kids, row.id)) mid.kids.push({ id: row.id, name: row.name, url: url, kids: [] });
      seen[row.id] = true;
    }

    /* 아무것도 못 만들면, 층을 못 가린 것이니 평평한 목록이라도 돌려준다 */
    if (!tree.length && rows.length) {
      for (var q = 0; q < rows.length && q < 200; q++) {
        if (!find(tree, rows[q].id)) {
          tree.push({ id: rows[q].id, name: rows[q].name,
                      url: rows[q].a.href || "", kids: [] });
        }
      }
    }

    var deep = 0;
    tree.forEach(function (t) {
      t.kids.forEach(function (m) { if (m.kids.length) deep += m.kids.length; });
    });
    return { tree: tree, links: links.length, tops: tree.length, leaves: deep };
  }

  /* 테무 채널 화면에서 상품을 뽑는다.
     테무는 클래스 이름이 뒤섞인 해시라 믿을 수 없다. 대신 화면에 보이는 한국어 글자를 읽는다.
     상품 주소는 .../<이름>-g-<상품번호>.html 꼴이라 여기서 상품번호를 얻는다. */
  function temuCards() {
    var all = document.querySelectorAll('a[href*="-g-"]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (/-g-\d{6,}\.html/.test(all[i].getAttribute("href") || "")) out.push(all[i]);
    }
    return out;
  }
  function temuHost(a) {
    var el = a;
    for (var i = 0; i < 8 && el; i++) {
      if (el.querySelector && el.querySelector("img")) {
        var b = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (b && b.width > 110 && b.height > 150) return el;
      }
      el = el.parentElement;
    }
    return a;
  }
  /* 카드 글자는 innerText 로 읽는다. textContent 는 칸 사이 공백이 없어 숫자가 붙어버린다. */
  function temuText(el) {
    return String((el && el.innerText) || "").replace(/\s+/g, " ").trim();
  }
  function temuBig(v, unit) {
    var n = parseFloat(String(v).replace(/,/g, "")) || 0;
    if (unit === "\uB9CC") n *= 10000;
    if (unit === "\uCC9C") n *= 1000;
    return Math.round(n);
  }

  /* 고른 갈래 딱지를 누른다. 테무는 주소가 바뀌지 않고 화면만 갈아끼운다. */
  function temuPickCategory(name) {
    var want = String(name || "").replace(/\s+/g, "");
    if (!want) return false;
    var lis = document.querySelectorAll("li");
    for (var i = 0; i < lis.length; i++) {
      var t = String(lis[i].innerText || "").replace(/\s+/g, "");
      /* 글자가 두 번 겹쳐 나오는 구조라 반으로 접힌 경우도 본다 */
      var half = t.length % 2 === 0 ? t.slice(0, t.length / 2) : "";
      if (t === want || half === want) {
        try { lis[i].click(); return true; } catch (e) { return false; }
      }
    }
    return false;
  }

  /* 왜 못 읽었는지 화면에 남길 말을 만든다. 짐작으로 고치지 않기 위해서다. */
  function temuDiag() {
    var body = String(document.body ? (document.body.innerText || "") : "");
    var anchors = document.querySelectorAll('a[href]').length;
    var goods = temuCards().length;
    var imgs = document.querySelectorAll("img").length;
    var lis = document.querySelectorAll("li").length;
    var why = [];
    why.push("주소 " + String(location.pathname));
    why.push("링크 " + anchors + "개");
    why.push("상품링크 " + goods + "개");
    why.push("그림 " + imgs + "개");
    why.push("딱지 " + lis + "개");
    why.push("글자 " + body.length + "자");
    if (/\uB85C\uADF8\uC778|sign in|log in/i.test(body.slice(0, 400))) why.push("로그인 화면으로 보임");
    if (document.visibilityState !== "visible") why.push("탭이 화면에 없음");
    return why.join(" · ");
  }

  function searchTemu(limit) {
    var want = limit || 20;
    var out = [];
    var seen = [];
    var cards = temuCards();

    for (var i = 0; i < cards.length && out.length < want; i++) {
      var a = cards[i];
      var href = String(a.getAttribute("href") || "");
      var idm = href.match(/-g-(\d{6,})\.html/);
      if (!idm || seen.indexOf(idm[1]) >= 0) continue;

      var host = temuHost(a);
      var t = temuText(host);
      if (!t) continue;

      var im = host.querySelector("img");
      var alt = im ? String(im.getAttribute("alt") || "") : "";
      /* alt 는 "품목 사진 <상품명>" 꼴이다 */
      var name = alt.replace(/^\s*\uD488\uBAA9\s*\uC0AC\uC9C4\s*/, "").trim();
      if (!name) {
        var nm = t.split(/\uC0C8 \uD0ED\uC5D0\uC11C \uC5F4\uAE30\./)[0] || "";
        name = nm.replace(/^(\uBE60\uB974\uAC8C \uBCF4\uAE30|\uC778\uAE30 \uCD94\uCC9C|\uAD6D\uB0B4\uBC1C\uC1A1|\uC120\uD0DD|\uD61C\uD0DD)\s*/g, "").trim();
      }

      /* 할인 상품은 판매가와 정가가 나란히 나온다. 실제로 내는 돈은 둘 중 싼 값이다. */
      var wons = (t.match(/[0-9][0-9,]{2,}\uC6D0/g) || [])
        .map(function (x) { return parseInt(String(x).replace(/[^0-9]/g, ""), 10) || 0; })
        .filter(function (v) { return v >= 100; });
      var price = wons.length ? Math.min.apply(null, wons) : 0;

      var sm = t.match(/([0-9][0-9,.]*)\s*([\uB9CC\uCC9C])?\s*\+?\s*\uD310\uB9E4\uB428/);
      var rt = t.match(/\uBCC4\uC810\s*5\uC810\s*\uC911\s*([0-9.]+)\uAC1C/);
      var rv = t.match(/\uB9AC\uBDF0\s*([0-9,]+)\uAC74/);
      var bd = t.match(/#(\d+)\s*(\uBCA0\uC2A4\uD2B8\uC140\uB7EC \uC0C1\uD488|\uCD5C\uACE0 \uD3C9\uC810)\s*-\s*([^#]{1,24}?)\s*(?=#|\uC138\uBD80|\uBCC4\uC810|\uBE0C\uB79C\uB4DC|$)/);
      var yr = t.match(/TEMU \uD310\uB9E4\s*(\d+)\uB144\uCC28/);

      if (!name && !price) continue;
      seen.push(idm[1]);

      out.push({
        rank: out.length + 1,
        productId: idm[1],
        url: a.href || ("https://www.temu.com" + href),
        name: name,
        price: price,                                  /* 원 */
        sold: sm ? temuBig(sm[1], sm[2]) : 0,
        rating: rt ? parseFloat(rt[1]) : 0,
        reviews: rv ? (parseInt(rv[1].replace(/,/g, ""), 10) || 0) : 0,
        boardRank: bd ? parseInt(bd[1], 10) : 0,
        boardKind: bd ? bd[2] : "",
        category: bd ? String(bd[3]).trim() : "",
        domestic: /\uAD6D\uB0B4\uBC1C\uC1A1/.test(t),
        topSeller: /\uC6B0\uC218 \uD310\uB9E4\uC790/.test(t),
        years: yr ? parseInt(yr[1], 10) : 0,
        image: im ? (im.getAttribute("src") || "") : ""
      });
    }
    return out;
  }

  /* 타오바오 판매량 순 검색 결과에서 인기 상품을 뽑는다.
     카드마다 a#item_id_<상품번호> 가 붙어 있어 상품번호를 그대로 얻는다.
     click.simba.taobao.com 으로 가는 카드는 광고라서 뺀다. */
  function tbPick(host, key) {
    var el = host.querySelector('[class*="' + key + '--"]');
    return el ? txt(el) : "";
  }
  /* 결제 인원은 반드시 전용 칸에서 읽는다.
     카드 전체 글자를 쓰면 "\u00A517.81000+\u4eba\u4ed8\u6b3e" 처럼 가격과 붙어 숫자가 섞인다. */
  function tbSold(host) {
    var el = host.querySelector('[class*="realSales--"]');
    var t = el ? txt(el) : "";
    if (!t) t = String(host.innerText || "").replace(/\s+/g, " ");
    var m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*([\u4e07\u5343])?\s*\+?\s*\u4eba\u4ed8\u6b3e/);
    if (!m) return 0;
    var v = parseFloat(m[1]) || 0;
    if (m[2] === "\u4e07") v *= 10000;
    if (m[2] === "\u5343") v *= 1000;
    return Math.round(v);
  }
  function tbPrice(host) {
    var i = tbPick(host, "priceInt");
    var f = tbPick(host, "priceFloat");
    if (i) return parseFloat(String(i).replace(/[^0-9.]/g, "") + (f ? String(f).replace(/[^0-9.]/g, "") : "")) || 0;
    var m = txt(host).match(/[\u00A5\uFFE5]\s*([0-9][0-9,]*)\s*(\.[0-9]{1,2})?/);
    if (!m) return 0;
    return parseFloat(String(m[1]).replace(/,/g, "") + (m[2] || "")) || 0;
  }

  function searchTaobao(limit) {
    var want = limit || 20;
    var out = [];
    var seen = [];
    var cards = document.querySelectorAll('a[id^="item_id_"]');

    for (var i = 0; i < cards.length && out.length < want; i++) {
      var a = cards[i];
      var href = String(a.getAttribute("href") || "");
      var ad = /click\.simba\.taobao\.com/i.test(href);
      if (ad) continue;

      var pid = String(a.id || "").replace(/^item_id_/, "");
      if (!/^\d{6,}$/.test(pid) || seen.indexOf(pid) >= 0) continue;
      seen.push(pid);

      var t = txt(a);
      var name = tbPick(a, "title") || String(a.getAttribute("title") || "");
      if (!name) {
        var im0 = a.querySelector("img[alt]");
        name = im0 ? String(im0.getAttribute("alt") || "").trim() : "";
      }
      var price = tbPrice(a);
      if (!name && !price) continue;

      var im = a.querySelector('img[class*="mainImg--"]') || a.querySelector("img");
      var src = im ? (im.getAttribute("src") || im.getAttribute("data-src") || "") : "";
      if (src.indexOf("//") === 0) src = "https:" + src;

      var bm = String(a.innerText || t).match(/\u699c\u00b7\u7b2c(\d+)\u540d/);

      out.push({
        rank: out.length + 1,
        productId: pid,
        url: "https://item.taobao.com/item.htm?id=" + pid,
        name: name,
        price: price,                       /* 위안 */
        sold: tbSold(a),                    /* 결제 인원 */
        shop: tbPick(a, "shopNameText"),
        area: tbPick(a, "procity"),
        boardRank: bm ? parseInt(bm[1], 10) : 0,
        tmall: /detail\.tmall\.com/i.test(href),
        image: src
      });
    }
    return out;
  }

  /* 1688 검색 결과에서 후보 상품을 뽑는다 */
  function search1688(limit) {
    var want = limit || 5;
    var out = [];
    var seen = [];
    var countLinks = function (el) { return offerAnchors(el).length; };
    var anchors = offerAnchors(document);

    for (var i = 0; i < anchors.length && out.length < want; i++) {
      var a = anchors[i];
      var raw = a.getAttribute("href") || "";
      var pid = offerIdOf(raw);
      if (!pid || seen.indexOf(pid) >= 0) continue;
      /* 상품 번호로 표준 주소를 만든다. 광고 추적 주소나 air 주소는 열면 404 가 난다. */
      var href = "https://detail.1688.com/offer/" + pid + ".html";

      var host = hostOf(a, countLinks, /[¥￥]\s*[0-9]/);
      var hostText = txt(host);

      var img = host.querySelector("img[alt]");
      var name = img ? String(img.getAttribute("alt") || "").trim() : "";
      if (name.length < 3) name = pickIn(host, ['[class*="title"]', '[class*="Title"]', '[class*="subject"]', '[class*="name"]']);
      if (name.length < 3) name = String(a.getAttribute("title") || txt(a) || "").trim();

      /* 구간 가격이 여러 개 나오므로 가장 낮은 값을 기준가로 쓴다 */
      var prices = (hostText.match(/[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]+)?/g) || [])
        .map(function (s) { return toNum(s.replace(/[¥￥]/g, "")); })
        .filter(function (v) { return v > 0 && v < 1000000; });
      var price = prices.length ? Math.min.apply(null, prices) : 0;

      /* 중국어판과 한국어판 표기를 모두 읽는다 */
      var moqm = hostText.match(/(\d+)\s*[件个台双套箱条只支包]?\s*起(?:批|订)/) ||
                 hostText.match(/최소\s*(?:주문\s*)?수량\s*([\d,]+)/);
      var moq = moqm ? toNum(moqm[1]) + "개" : "";

      var sold = "";
      var sm = hostText.match(/(?:成交|已售|销量)\s*([0-9.]+[万]?)/) ||
               hostText.match(/([0-9][0-9.,]*\s*[만万]?\+?)\s*구매/);
      if (sm) sold = String(sm[1]).trim();

      var image = imageIn(host);
      if (!name && !price) continue;
      seen.push(pid);

      out.push({
        rank: out.length + 1,
        offerId: pid,
        url: href.split("#")[0],
        name: name,
        price: price,
        moq: moq,
        sold: sold,
        image: image ? expandAli(image) : ""
      });
    }
    return out;
  }
  /* 지금 화면이 진짜 검색 결과인지 본다.
     1688 홈 화면에도 상품이 잔뜩 깔려 있어서, 이걸 구분하지 않으면 엉뚱한 추천 목록을 결과로 착각한다. */
  function is1688ResultPage() {
    var u = location.href;
    if (/^https?:\/\/(www\.)?1688\.com\/?(\?|#|$)/i.test(u)) return false;   // 홈 화면
    if (/s\.1688\.com|air\.1688\.com|image-search|imageSearch|image_search|youyuan|offer_search|offerlist|sourcing|\/page\//i.test(u)) return true;
    var body = document.body ? document.body.innerText.slice(0, 4000) : "";
    return /(공급원을\s*찾아|找到以下货源|为您找到|搜索结果|검색\s*결과)/.test(body);
  }

  function search1688Diag() {
    var body = document.body ? document.body.innerText.slice(0, 3000) : "";
    if (/登录|登陆|验证|滑动|安全验证/.test(body)) {
      return "1688이 로그인이나 보안 확인을 요구합니다. 크롬에서 1688에 먼저 로그인한 뒤 다시 시도해주세요.";
    }
    var n = offerAnchors(document).length;
    var links = document.querySelectorAll("a[href]").length;
    if (!n) return "1688 화면에서 상품 링크를 찾지 못했습니다. (링크 " + links + "개 중 상품 0개, 주소 " +
      location.hostname + ")";
    return "상품 링크는 " + n + "개 찾았지만 이름과 가격을 읽지 못했습니다.";
  }

  /* 결과가 비었을 때 왜 비었는지 알려준다 */
  function searchDiag() {
    var body = document.body ? document.body.innerText.slice(0, 3000) : "";
    var anchors = document.querySelectorAll('a[href*="/vp/products/"]').length;
    var blocked = /비정상적인|일시적으로 제한|robot|캡차|보안문자/i.test(body);
    if (blocked) return "쿠팡이 자동 접근을 막았습니다. 크롬에서 쿠팡을 한 번 직접 열어 확인한 뒤 다시 시도해주세요.";
    if (!anchors) return "검색 결과가 비어 있습니다. 다른 키워드로 시도하거나 크롬에서 쿠팡에 먼저 접속해주세요.";
    return "상품 링크는 " + anchors + "개 찾았지만 이름과 가격을 읽지 못했습니다. 쿠팡 화면 구조가 바뀐 것 같습니다.";
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (msg && msg.type === "search1688") {
      var want1688 = msg.limit || 5;
      var s1 = Date.now();
      nudgeLazyImages();
      (function tick() {
        var rows = [];
        try { rows = search1688(want1688); } catch (e) { rows = []; }
        var waited1 = Date.now() - s1;
        if (rows.length >= want1688 || waited1 > 12000 || (rows.length && waited1 > 6000)) {
          if (!rows.length) respond({ ok: false, error: search1688Diag() });
          else respond({ ok: true, data: { items: rows, resultPage: is1688ResultPage(), url: location.href } });
          return;
        }
        if (waited1 > 2500) nudgeLazyImages();
        setTimeout(tick, 700);
      })();
      return true;
    }
    if (msg && msg.type === "catTree") {
      var t0c = Date.now();
      (function tick() {
        var got = null;
        try { got = coupangCatTree(); } catch (e) { got = null; }
        var waited = Date.now() - t0c;
        if ((got && got.tops) || waited > 9000) {
          if (!got || !got.tops) {
            respond({ ok: false, error: "쿠팡 카테고리 차림표를 찾지 못했습니다." });
          } else {
            respond({ ok: true, data: got });
          }
          return;
        }
        setTimeout(tick, 700);
      })();
      return true;
    }
    if (msg && msg.type === "temuTop") {
      var wantTm = msg.limit || 20;
      var picked = false;
      try { picked = temuPickCategory(msg.category); } catch (e) { picked = false; }
      var m0 = Date.now();
      var settle = picked ? 2600 : 0;   /* 갈래를 눌렀으면 화면이 갈릴 때까지 기다린다 */
      setTimeout(function () {
        (function tick() {
          var rows = [];
          try { rows = searchTemu(wantTm); } catch (e) { rows = []; }
          var waited = Date.now() - m0;
          if (rows.length >= wantTm || waited > 20000 || (rows.length && waited > 9000)) {
            if (!rows.length) {
              var d = "";
              try { d = temuDiag(); } catch (e) { d = "진단 실패"; }
              respond({ ok: false, error: "테무 화면에서 상품을 찾지 못했습니다. (" + d + ")" });
            } else {
              respond({ ok: true, data: { items: rows, picked: picked } });
            }
            return;
          }
          try { window.scrollBy(0, 1000); } catch (e) {}
          setTimeout(tick, 800);
        })();
      }, settle);
      return true;
    }
    if (msg && msg.type === "taobaoTop") {
      var wantTb = msg.limit || 20;
      var t0 = Date.now();
      (function tick() {
        var rows = [];
        try { rows = searchTaobao(wantTb); } catch (e) { rows = []; }
        var waited = Date.now() - t0;
        if (rows.length >= wantTb || waited > 14000 || (rows.length && waited > 7000)) {
          if (!rows.length) respond({ ok: false, error: "타오바오 상품을 찾지 못했습니다. 로그인이 풀렸을 수 있습니다." });
          else respond({ ok: true, data: { items: rows } });
          return;
        }
        try { window.scrollBy(0, 900); } catch (e) {}
        setTimeout(tick, 800);
      })();
      return true;
    }
    if (msg && msg.type === "searchTop") {
      var want = msg.limit || 5;
      var start = Date.now();
      nudgeLazyImages();
      (function tick() {
        var rows = [];
        try { rows = searchTop(want); } catch (e) { rows = []; }
        /* 원하는 개수가 다 찰 때까지 잠깐 기다린다. 목록이 나눠 그려지는 경우가 있다. */
        var waited = Date.now() - start;
        if (rows.length >= want || waited > 12000 || (rows.length && waited > 6000)) {
          if (!rows.length) respond({ ok: false, error: searchDiag() });
          else respond({ ok: true, data: { items: rows } });
          return;
        }
        if (waited > 2500) nudgeLazyImages();
        setTimeout(tick, 700);
      })();
      return true;
    }
    if (!msg || msg.type !== "scrape") return;
    scrapeWhenReady(function (data) {
      if (!data || (!data.name && !data.price)) {
        respond({ ok: false, error: "이 페이지에서 상품 정보를 찾지 못했습니다." });
      } else {
        respond({ ok: true, data: data });
      }
    });
    return true;
  });
})();
