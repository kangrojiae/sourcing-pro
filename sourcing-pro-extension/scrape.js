/* Sourcing Pro 수집기 — 상품 페이지에서 값을 읽는 콘텐츠 스크립트.
   쿠팡과 1688 모두 마크업이 자주 바뀌므로, 선택자는 여러 겹으로 시도하고
   실패하면 JSON-LD → og 메타 → 본문 텍스트 순으로 내려간다. */
(function () {
  "use strict";
  if (window.__spScrapeReady) return;
  window.__spScrapeReady = true;

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

    var priceText = pick([
      ".prod-sale-price .total-price strong",
      ".total-price strong",
      "span.total-price > strong",
      ".prod-price .total-price",
      ".price-amount.final-price-amount",
      '[class*="final-price"] [class*="amount"]',
      ".prod-coupon-price .total-price strong"
    ]);
    var price = toNum(priceText);
    if (!price && offer) price = toNum(offer.price);
    if (!price) price = toNum(meta("product:price:amount"));

    var rating = "";
    var starEl = document.querySelector(".rating-star-num, .product-rating .rating-star-num");
    if (starEl) {
      var w = toNum(starEl.style && starEl.style.width);
      if (w) rating = (w / 20).toFixed(1);
    }
    if (!rating) rating = pick([".rating-star-num-text", '[class*="rating"] [class*="num"]']);
    if (!rating && ld.aggregateRating) rating = String(ld.aggregateRating.ratingValue || "");
    rating = rating ? String(toNum(rating).toFixed(1)) : "";

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
    var m = h.match(/\/offer\/(\d{6,})/) ||
            h.match(/[?&]offerId=(\d{6,})/i) ||
            h.match(/[?&]offer_id=(\d{6,})/i) ||
            h.match(/[?&]id=(\d{9,})/i);
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

  /* 판매가를 고른다. 취소선이 그어진 정가, 단위가격, 쿠폰 금액은 뺀다. */
  function priceIn(host) {
    var nodes = host.querySelectorAll('[class*="price"], [class*="Price"], strong, em');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var cls = el.className;
      if (cls && cls.baseVal !== undefined) cls = cls.baseVal;
      if (typeof cls !== "string") cls = "";
      if (/base|origin|Origin|Base|unit|Unit|coupon|Coupon|discount|Discount/.test(cls)) continue;
      if (el.closest && el.closest("del")) continue;
      var t = txt(el);
      if (/당\s*[\d,]+\s*원/.test(t)) continue;   // 100g당 같은 단위가격
      if (/쿠폰|할인|적립/.test(t)) continue;
      var v = wonIn(t);
      if (v >= 100 && v < 50000000) return v;
    }
    /* 클래스로 못 찾으면 카드 안의 원 표시 금액 중 가장 작은 값을 판매가로 본다 */
    var body = txt(host)
      .replace(/\([^)]*당[^)]*\)/g, "")
      .replace(/[^\s]*쿠폰[^\s]*/g, "");
    var all = body.match(/[0-9][0-9,]*\s*원/g) || [];
    var vals = all.map(function (s) { return wonIn(s); })
                  .filter(function (v) { return v >= 100 && v < 50000000; });
    return vals.length ? Math.min.apply(null, vals) : 0;
  }

  /* 별점은 별 그림의 너비로 표시되는 경우가 많다 */
  function ratingIn(host) {
    var els = host.querySelectorAll('[class*="rating"], [class*="Rating"], [class*="star"], [class*="Star"]');
    for (var i = 0; i < els.length; i++) {
      var w = els[i].style && els[i].style.width ? parseFloat(els[i].style.width) : 0;
      if (w > 0 && w <= 100) return (w / 20).toFixed(1);
      var t = txt(els[i]);
      var m = t.match(/^(\d(?:\.\d)?)$/);
      if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) <= 5) return parseFloat(m[1]).toFixed(1);
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

  /* 쿠팡 검색 결과에서 광고를 뺀 노출 순위를 뽑는다 */
  function searchTop(limit) {
    var want = limit || 5;
    var out = [];
    var seen = [];
    /* 본 목록은 리스트 안에 있다. 그쪽을 먼저 보고, 없으면 전체에서 찾는다. */
    var anchors = document.querySelectorAll('ul li a[href*="/vp/products/"]');
    if (anchors.length < 3) anchors = document.querySelectorAll('a[href*="/vp/products/"]');

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
        image: imageIn(host)
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
      var href = absUrl(raw);

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
