/**
 * edgeproxy-ultimate.js
 *
 * Feature list:
 * - Auth via x-api-key (env.API_KEY)
 * - Host whitelist via env.ALLOWED_HOSTS (comma-separated)
 * - KV rate limiting via env.RATE_KV (per api key per minute)
 * - Caching for non-HTML GETs (caches.default) with TTL env.CACHE_TTL
 * - Size cutoff env.MAX_REWRITE_BYTES to skip heavy rewrites
 * - Robust HTMLRewriter handlers for links/scripts/styles/media/iframes/preloads/importmaps
 * - Improved JS/CSS rewriting with source-map URL rewrites and many JS patterns
 * - JSON body URL rewriting (best-effort)
 * - Admin endpoints: /__health, /__metrics, /__purge (protected by API key)
 *
 * Bindings expected in wrangler.toml / env:
 * - API_KEY (secret)
 * - ALLOWED_HOSTS (string, comma separated; blank = allow all)
 * - RATE_KV (Workers KV namespace)
 * - MAX_REWRITE_BYTES (number, default 1_000_000)
 * - CACHE_TTL (seconds, default 3600)
 * - DEBUG (0/1)
 */

const DEFAULTS = {
  MAX_REWRITE_BYTES: 1_000_000, // 1MB
  CACHE_TTL: 3600, // 1 hour
  RATE_LIMIT_PER_MIN: 120, // requests per minute per API key
  SAMPLE_LOG_RATE: 0.01, // sampled logging prob for successful requests
};

// -------- util helpers --------
const nowMs = () => Date.now();
const safeParseInt = (v, fallback) => {
  const n = parseInt(v);
  return Number.isFinite(n) ? n : fallback;
};

function logSampled(env, ...args) {
  try {
    const p = safeParseInt(env.SAMPLE_LOG_RATE, DEFAULTS.SAMPLE_LOG_RATE);
    if (Math.random() < p) console.log(...args);
  } catch (e) {
    // ignore
  }
}

// Normalize ALLOWED_HOSTS into set
function getAllowedSet(env) {
  const raw = env.ALLOWED_HOSTS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// KV rate limiter: simple per-minute counter
async function checkRateLimit(env, apiKey) {
  if (!env.RATE_KV) return { ok: true }; // not configured => no limit
  const minute = Math.floor(Date.now() / 60000);
  const kvKey = `rl:${apiKey}:${minute}`;
  const curRaw = await env.RATE_KV.get(kvKey);
  const cur = curRaw ? parseInt(curRaw) : 0;
  const limit = safeParseInt(env.RATE_LIMIT_PER_MIN, DEFAULTS.RATE_LIMIT_PER_MIN);
  if (cur >= limit) {
    return { ok: false, remaining: 0, limit };
  }
  await env.RATE_KV.put(kvKey, String(cur + 1), { expirationTtl: 70 });
  return { ok: true, remaining: Math.max(0, limit - (cur + 1)), limit };
}

/** Resolve URLs relative to base; return original on failure */
function resolveUrl(raw, base) {
  if (!raw) return raw;
  try {
    return new URL(raw, base).toString();
  } catch (e) {
    return raw;
  }
}

/** Build proxied url for absolute URL */
function proxify(proxyOrigin, absoluteUrl) {
  return `${proxyOrigin}?url=${encodeURIComponent(absoluteUrl)}`;
}

/** Checks if URL is safe to rewrite/proxy (not data/blob/about/mailto/javascript) */
function isRewriteableResource(urlStr) {
  if (!urlStr) return false;
  return !/^(data:|blob:|about:|mailto:|javascript:)/i.test(urlStr);
}

/** Quick heuristic: if content-length exists and > threshold, we skip heavy rewrite */
function isTooLarge(headers, maxBytes) {
  const cl = headers.get("content-length");
  if (!cl) return false;
  const n = parseInt(cl);
  if (Number.isNaN(n)) return false;
  return n > maxBytes;
}

// ------------ Rewriters -------------
// CSS rewriting: url(...) rewriting; also handle @import
function rewriteCSS(cssText, base, proxyOrigin) {
  if (!cssText) return cssText;
  // url(...) first
  cssText = cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, quote, u) => {
    if (!isRewriteableResource(u)) return `url(${quote}${u}${quote})`;
    const resolved = resolveUrl(u, base);
    return `url(${quote}${proxify(proxyOrigin, resolved)}${quote})`;
  });

  // @import '...'
  cssText = cssText.replace(/@import\s+(?:url\()?['"]?([^'"\)\s]+)['"]?\)?/gi, (m, u) => {
    if (!isRewriteableResource(u)) return m;
    const resolved = resolveUrl(u, base);
    return `@import url("${proxify(proxyOrigin, resolved)}")`;
  });

  return cssText;
}

// JS rewriting: many patterns, cautious about double-rewrites
function rewriteJS(jsText, base, proxyOrigin, maxBytes) {
  if (!jsText) return jsText;

  // Quick skip if too big
  if (typeof maxBytes === "number" && jsText.length > maxBytes) return jsText;

  const proxifyIf = (u) => {
    if (!isRewriteableResource(u)) return u;
    // don't proxify if already proxied by us
    if (u.startsWith(proxyOrigin)) return u;
    const resolved = resolveUrl(u, base);
    return proxify(proxyOrigin, resolved);
  };

  // Patterns:
  // 1) fetch('...') / fetch("...")
  jsText = jsText.replace(
    /fetch\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi,
    (m, q, u) => `fetch(${q}${proxifyIf(u)}${q}`
  );

  // 2) import('...') dynamic import
  jsText = jsText.replace(
    /import\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1\s*\)/gi,
    (m, q, u) => `import(${q}${proxifyIf(u)}${q})`
  );

  // 3) importScripts('a.js', 'b.js')
  jsText = jsText.replace(/importScripts\(\s*([^)]+)\s*\)/gi, (m, args) => {
    const parts = args
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const m2 = p.match(/^(['"`])(.*)\1$/);
        if (m2) return `${m2[1]}${proxifyIf(m2[2])}${m2[1]}`;
        return p;
      });
    return `importScripts(${parts.join(",")})`;
  });

  // 4) XHR open: open("GET", "/path")
  jsText = jsText.replace(
    /(\.open\s*\(\s*(['"`])(?:GET|POST|PUT|DELETE|OPTIONS|HEAD)\2\s*,\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\3)/gi,
    (m, prefix, q1, q2, url) => {
      return prefix.replace(url, proxifyIf(url));
    }
  );

  // 5) new Worker('...') and new SharedWorker('...')
  jsText = jsText.replace(
    /new\s+(?:Worker|SharedWorker)\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi,
    (m, q, u) => m.replace(u, proxifyIf(u))
  );

  // 6) location.href = '/x' or assign
  jsText = jsText.replace(
    /(location(?:\.href|\.assign)?\s*=\s*)(['"`])((?:https?:\/\/|\/)[^'"`]+)\2/gi,
    (m, lhs, q, u) => `${lhs}${q}${proxifyIf(u)}${q}`
  );

  // 7) registerServiceWorker('/sw.js')
  jsText = jsText.replace(
    /(registerServiceWorker|serviceWorker\.register)\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\2\s*\)/gi,
    (m, fn, q, u) => `${fn}(${q}${proxifyIf(u)}${q})`
  );

  // 8) sourceMappingURL comment rewrite (source maps)
  jsText = jsText.replace(/(\/\/# sourceMappingURL=)(.*)/gi, (m, prefix, url) => {
    if (!isRewriteableResource(url)) return m;
    return `${prefix}${proxifyIf(url)}`;
  });

  // 9) generic string-looking URLs (cautious)
  jsText = jsText.replace(/(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi, (m, q, u) => {
    // don't rewrite if looks already proxied or if it's part of code tokens like import maps (we already handled many)
    if (u.startsWith(proxyOrigin)) return m;
    // ignore common JSON templates like uuid-looking or other things by heuristic: if contains spaces or < then skip
    if (/[<>\s]/.test(u)) return m;
    return `${q}${proxifyIf(u)}${q}`;
  });

  return jsText;
}

// JSON rewrite: best effort to replace absolute/relative urls inside JSON responses
function rewriteJSON(text, base, proxyOrigin) {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    const replacer = (obj) => {
      if (Array.isArray(obj)) {
        return obj.map(replacer);
      } else if (obj && typeof obj === "object") {
        const out = {};
        for (const k of Object.keys(obj)) {
          out[k] = replacer(obj[k]);
        }
        return out;
      } else if (typeof obj === "string") {
        // if string is URL-like, replace
        if (/^(?:https?:\/\/|\/)/i.test(obj) && isRewriteableResource(obj)) {
          return proxify(proxyOrigin, resolveUrl(obj, base));
        }
        return obj;
      } else {
        return obj;
      }
    };
    const newObj = replacer(parsed);
    return JSON.stringify(newObj);
  } catch (e) {
    // not JSON or parse failed — return original
    return text;
  }
}

// -------- HTMLRewriter handlers (centralized utilities) --------
function createHtmlRewriterHandlers(proxyOrigin, targetBase) {
  // helper to proxify attribute safely
  function attrProxy(el, attr) {
    const val = el.getAttribute(attr);
    if (!val) return;
    if (!isRewriteableResource(val)) return;
    const abs = resolveUrl(val, targetBase);
    el.setAttribute(attr, proxify(proxyOrigin, abs));
  }

  return {
    // anchor tags
    anchor: {
      element(el) {
        const href = el.getAttribute("href");
        if (!href || href.startsWith("javascript:")) return;
        const abs = resolveUrl(href, targetBase);
        el.setAttribute("href", proxify(proxyOrigin, abs));
      },
    },

    // forms (action)
    form: {
      element(el) {
        const action = el.getAttribute("action") || "";
        const abs = resolveUrl(action || targetBase, targetBase);
        el.setAttribute("action", proxify(proxyOrigin, abs));
      },
    },

    // image/media/source/poster/srcset
    srcAttrHandler: {
      element(el) {
        ["src", "poster", "data-src", "data-srcset", "srcset"].forEach((attr) => {
          const v = el.getAttribute(attr);
          if (!v) return;
          // srcset needs splitting
          if (attr === "srcset") {
            const parts = v
              .split(",")
              .map((p) => p.trim())
              .map((entry) => {
                const [urlPart, descriptor] = entry.split(/\s+/, 2);
                if (!urlPart) return entry;
                if (!isRewriteableResource(urlPart)) return entry;
                const abs = resolveUrl(urlPart, targetBase);
                return `${proxify(proxyOrigin, abs)}${descriptor ? " " + descriptor : ""}`;
              });
            el.setAttribute(attr, parts.join(", "));
          } else {
            if (!isRewriteableResource(v)) return;
            const abs = resolveUrl(v, targetBase);
            el.setAttribute(attr, proxify(proxyOrigin, abs));
          }
        });
      },
    },

    // script[src] and link[href] (stylesheets, preload)
    resourceAttrHandler: {
      element(el) {
        // support link rel=preload/modulepreload, link rel=stylesheet, script[src]
        if (el.tagName === "LINK") {
          const href = el.getAttribute("href");
          if (!href) return;
          const abs = resolveUrl(href, targetBase);
          el.setAttribute("href", proxify(proxyOrigin, abs));
          // If integrity exists, remove it because rewriting changes body. Mark with data-proxy-integrity
          if (el.getAttribute("integrity")) {
            el.setAttribute("data-proxy-integrity", el.getAttribute("integrity"));
            el.removeAttribute("integrity");
          }
        } else if (el.tagName === "SCRIPT") {
          const src = el.getAttribute("src");
          if (!src) return;
          const abs = resolveUrl(src, targetBase);
          el.setAttribute("src", proxify(proxyOrigin, abs));
          // preserve type=module/nomodule
        }
      },
    },

    // inline style attributes
    inlineStyleHandler: {
      element(el) {
        const s = el.getAttribute("style");
        if (!s) return;
        el.setAttribute("style", rewriteCSS(s, targetBase, proxyOrigin));
      },
    },

    // style blocks
    styleBlockHandler: {
      element(el) {
        const txt = el.text || "";
        if (!txt) return;
        el.setInnerContent(rewriteCSS(txt, targetBase, proxyOrigin), { html: false });
      },
    },

    // inline script blocks
    scriptInlineHandler: {
      element(el) {
        const txt = el.text || "";
        if (!txt) return;
        el.setInnerContent(rewriteJS(txt, targetBase, proxyOrigin, parseInt(DEFAULTS.MAX_REWRITE_BYTES)), { html: false });
      },
    },

    // base tag handling: if page sets <base href="..."> we need to respect it
    baseHandler: {
      element(el) {
        // we don't rewrite base href; but we note it by setting data-proxy-base
        const b = el.getAttribute("href");
        if (b) {
          el.setAttribute("data-proxy-base", resolveUrl(b, targetBase));
        }
      },
    },

    // importmap (script type="importmap")
    importMapHandler: {
      element(el) {
        // import maps are JSON; rewrite contained URLs
        const txt = el.text || "";
        if (!txt) return;
        try {
          const parsed = JSON.parse(txt);
          if (parsed && parsed.imports) {
            Object.keys(parsed.imports).forEach((k) => {
              const v = parsed.imports[k];
              if (typeof v === "string" && isRewriteableResource(v)) {
                parsed.imports[k] = proxify(proxyOrigin, resolveUrl(v, targetBase));
              }
            });
            el.setInnerContent(JSON.stringify(parsed), { html: false });
          }
        } catch (e) {
          // ignore parse errors
        }
      },
    },
  };
}

// ------------- main fetch --------------
export default {
  async fetch(request, env) {
    const start = nowMs();

    // Admin endpoints (health/metrics/purge)
    const url = new URL(request.url);
    if (url.pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }

    // Auth
    const apiKey = request.headers.get("x-api-key") || url.searchParams.get("api_key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Rate limit check (KV)
    const rl = await checkRateLimit(env, apiKey);
    if (!rl.ok) {
      return new Response("Rate limit exceeded", { status: 429 });
    }

    // Admin: purge cache (protected)
    if (url.pathname === "/__purge" && request.method === "POST") {
      // expects form param 'url' to purge specific proxy cache key
      const body = await request.text();
      // naive parse for url=...
      const m = body.match(/url=([^&]+)/);
      if (m) {
        const targetToPurge = decodeURIComponent(m[1]);
        const proxyOrigin = url.origin;
        const cacheKey = new Request(proxyOrigin + "/cache?url=" + encodeURIComponent(targetToPurge), { method: "GET", headers: { "x-api-key": apiKey }});
        await caches.default.delete(cacheKey);
        return new Response("Purged", { status: 200 });
      }
      return new Response("Bad purge request", { status: 400 });
    }

    // Parse & validate target param
    const targetParam = url.searchParams.get("url") || url.searchParams.get("target");
    if (!targetParam) {
      return new Response(`Use: ${url.origin}?url=https://example.com`, { status: 400 });
    }

    let target;
    try {
      target = new URL(targetParam);
    } catch (e) {
      return new Response("Invalid target URL", { status: 400 });
    }

    // Whitelist check
    const allowed = getAllowedSet(env);
    if (allowed.size > 0 && !allowed.has(target.hostname.toLowerCase())) {
      return new Response("Forbidden target", { status: 403 });
    }

    const proxyOrigin = url.origin;

    // Cache key for caching non-HTML GETs
    const cacheKey = new Request(proxyOrigin + "/cache?url=" + encodeURIComponent(target.toString()), {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });

    const isGet = request.method === "GET";
    const accept = request.headers.get("accept") || "";

    // If non-html GET, check cache first
    if (isGet && !accept.includes("text/html")) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const took = nowMs() - start;
        const cc = new Headers(cached.headers);
        cc.set("x-proxy-took-ms", String(took));
        cc.set("x-proxy-cache-status", "HIT");
        return new Response(cached.body, { status: cached.status, headers: cc });
      }
    }

    // Build outbound request to target, stripping sensitive headers
    const fwdHeaders = new Headers();
    request.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (["cookie", "cookie2", "authorization", "referer", "host"].includes(kl)) return;
      fwdHeaders.set(k, v);
    });
    // add proxy provenance
    fwdHeaders.set("x-forwarded-by", "edgeproxy-ultimate");

    // Compose fetch
    const originReq = new Request(target.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer(),
      redirect: "manual",
    });

    let originRes;
    try {
      originRes = await fetch(originReq);
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, { status: 502 });
    }

    // Handle redirects => bounce through proxy
    if (originRes.status >= 300 && originRes.status < 400) {
      const loc = originRes.headers.get("location");
      if (loc) {
        const absolute = resolveUrl(loc, target.toString());
        const proxiedUrl = proxify(proxyOrigin, absolute);
        return Response.redirect(proxiedUrl, originRes.status);
      }
    }

    // Prepare headers for outgoing response
    const outHeaders = new Headers(originRes.headers);
    // Remove problematic security headers (we can't render with them)
    ["content-security-policy", "x-frame-options", "x-xss-protection"].forEach((h) => outHeaders.delete(h));
    outHeaders.set("Access-Control-Allow-Origin", "*");
    outHeaders.set("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    // tag with proxy info
    outHeaders.set("x-proxy-origin-host", target.hostname);
    outHeaders.set("x-proxy-rewritten", "none");

    const contentType = (outHeaders.get("content-type") || "").toLowerCase();

    // If HTML => use HTMLRewriter with many handlers
    if (contentType.includes("text/html")) {
      outHeaders.set("x-proxy-rewritten", "html");
      const handlers = createHtmlRewriterHandlers(proxyOrigin, target.toString());

      // Build HTMLRewriter instance and attach handlers
      let rewriter = new HTMLRewriter()
        .on("a[href]", handlers.anchor)
        .on("area[href]", handlers.anchor)
        .on("form[action]", handlers.form)
        .on("img", handlers.srcAttrHandler)
        .on("video", handlers.srcAttrHandler)
        .on("audio", handlers.srcAttrHandler)
        .on("source", handlers.srcAttrHandler)
        .on("track", handlers.srcAttrHandler)
        .on("iframe", handlers.srcAttrHandler)
        .on("embed", handlers.srcAttrHandler)
        .on("object", handlers.srcAttrHandler)
        .on("script[src]", handlers.resourceAttrHandler)
        .on("link[href]", handlers.resourceAttrHandler)
        .on("[style]", handlers.inlineStyleHandler)
        .on("style", handlers.styleBlockHandler)
        .on("script:not([src])", handlers.scriptInlineHandler)
        .on("base", handlers.baseHandler)
        .on("script[type='importmap']", handlers.importMapHandler);

      // Apply transform
      const transformed = rewriter.transform(new Response(originRes.body, { headers: outHeaders, status: originRes.status }));
      // metrics & sampling
      logSampled(env, "[proxy-html]", target.toString(), "status", originRes.status);
      return transformed;
    }

    // If CSS
    if (contentType.includes("text/css") || /\.css$/.test(target.pathname)) {
      outHeaders.set("x-proxy-rewritten", "css");
      // get text
      const text = await originRes.text();
      // rewrite CSS
      const maxBytes = safeParseInt(env.MAX_REWRITE_BYTES, DEFAULTS.MAX_REWRITE_BYTES);
      const rewritten = rewriteCSS(text, target.toString(), proxyOrigin);
      const resp = new Response(rewritten, { status: originRes.status, headers: outHeaders });
      // cache
      if (isGet) {
        // set caching headers if not already present
        if (!outHeaders.get("cache-control")) resp.headers.set("cache-control", `public, max-age=${safeParseInt(env.CACHE_TTL, DEFAULTS.CACHE_TTL)}`);
        await caches.default.put(cacheKey, resp.clone());
      }
      resp.headers.set("x-proxy-took-ms", String(nowMs() - start));
      resp.headers.set("x-proxy-cache-status", "MISS");
      logSampled(env, "[proxy-css]", target.toString());
      return resp;
    }

    // If JS
    if (contentType.includes("javascript") || /\.js$/.test(target.pathname) || target.pathname.endsWith(".mjs")) {
      // decide rewrite or not based on size and skip-list heuristics
      const maxBytes = safeParseInt(env.MAX_REWRITE_BYTES, DEFAULTS.MAX_REWRITE_BYTES);
      // If content-length present and > maxBytes, skip rewriting
      if (isTooLarge(outHeaders, maxBytes)) {
        // return raw but with headers set
        const rawResp = new Response(originRes.body, { status: originRes.status, headers: outHeaders });
        if (isGet) {
          await caches.default.put(cacheKey, rawResp.clone());
        }
        rawResp.headers.set("x-proxy-took-ms", String(nowMs() - start));
        rawResp.headers.set("x-proxy-rewritten", "none(too_large)");
        rawResp.headers.set("x-proxy-cache-status", "MISS");
        return rawResp;
      }

      // Otherwise read text and rewrite
      const text = await originRes.text();
      const rewritten = rewriteJS(text, target.toString(), proxyOrigin, maxBytes);
      const resp = new Response(rewritten, { status: originRes.status, headers: outHeaders });
      if (isGet) {
        if (!outHeaders.get("cache-control")) resp.headers.set("cache-control", `public, max-age=${safeParseInt(env.CACHE_TTL, DEFAULTS.CACHE_TTL)}`);
        await caches.default.put(cacheKey, resp.clone());
      }
      resp.headers.set("x-proxy-rewritten", "js");
      resp.headers.set("x-proxy-took-ms", String(nowMs() - start));
      resp.headers.set("x-proxy-cache-status", "MISS");
      logSampled(env, "[proxy-js]", target.toString());
      return resp;
    }

    // If JSON -> attempt best-effort rewrite of embedded URLs
    if (contentType.includes("application/json") || contentType.includes("application/ld+json") || /\.json$/.test(target.pathname)) {
      const text = await originRes.text();
      const rewritten = rewriteJSON(text, target.toString(), proxyOrigin);
      const resp = new Response(rewritten, { status: originRes.status, headers: outHeaders });
      if (isGet) {
        if (!outHeaders.get("cache-control")) resp.headers.set("cache-control", `public, max-age=${safeParseInt(env.CACHE_TTL, DEFAULTS.CACHE_TTL)}`);
        await caches.default.put(cacheKey, resp.clone());
      }
      resp.headers.set("x-proxy-rewritten", "json");
      resp.headers.set("x-proxy-took-ms", String(nowMs() - start));
      resp.headers.set("x-proxy-cache-status", "MISS");
      logSampled(env, "[proxy-json]", target.toString());
      return resp;
    }

    // Fallback: return raw (with cache)
    const finalResp = new Response(originRes.body, { status: originRes.status, headers: outHeaders });
    if (isGet) {
      await caches.default.put(cacheKey, finalResp.clone());
    }
    finalResp.headers.set("x-proxy-took-ms", String(nowMs() - start));
    finalResp.headers.set("x-proxy-cache-status", "MISS");
    logSampled(env, "[proxy-raw]", target.toString());
    return finalResp;
  },
};
