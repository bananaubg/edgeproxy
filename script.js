// wrangler.toml (example)
// name = "edge-rewriter"
// main = "src/worker.js"
// compatibility_date = "2024-11-01"

const PARAM = "u"; // query param carrying the target URL

export default {
  async fetch(request, env, ctx) {
    try {
      const reqUrl = new URL(request.url);
      const targetRaw = reqUrl.searchParams.get(PARAM);

      // Landing page
      if (!targetRaw) {
        return new Response(htmlIndex(), { headers: { "content-type": "text/html; charset=utf-8" }});
      }

      // Resolve absolute target
      let target;
      try {
        target = new URL(targetRaw);
      } catch {
        // If relative or missing scheme, assume https
        target = new URL(`https://${targetRaw}`);
      }

      // Build outbound request options
      const outboundInit = await buildOutboundInit(request);

      // Fetch
      const upstreamResp = await fetch(target, outboundInit);

      // Copy headers but strip hop-by-hop and encoding stuff
      const contentType = upstreamResp.headers.get("content-type") || "";
      const headers = new Headers(upstreamResp.headers);
      sanitizeHeaders(headers);

      // HTML → rewrite links
      if (contentType.includes("text/html")) {
        const rewriter = new HTMLRewriter()
          .on("a[href]", new AttrRewriter("href", target))
          .on("link[href]", new AttrRewriter("href", target))
          .on("script[src]", new AttrRewriter("src", target))
          .on("img[src]", new AttrRewriter("src", target))
          .on("iframe[src]", new AttrRewriter("src", target))
          .on("video[src]", new AttrRewriter("src", target))
          .on("audio[src]", new AttrRewriter("src", target))
          .on("source[src]", new AttrRewriter("src", target))
          .on("form[action]", new AttrRewriter("action", target))
          .on("meta[http-equiv='refresh']", new MetaRefreshRewriter(target));

        headers.set("content-type", "text/html; charset=utf-8");
        return rewriter.transform(upstreamResp);
      }

      // CSS → rewrite url(...)
      if (contentType.includes("text/css")) {
        const cssText = await upstreamResp.text();
        const rewritten = rewriteCssUrls(cssText, target);
        headers.set("content-type", "text/css; charset=utf-8");
        return new Response(rewritten, { status: upstreamResp.status, headers });
      }

      // Everything else → pass through (arrayBuffer to avoid text encoding surprises)
      const buf = await upstreamResp.arrayBuffer();
      return new Response(buf, { status: upstreamResp.status, headers });

    } catch (err) {
      return new Response(`Proxy error: ${err?.message || err}`, { status: 500, headers: { "content-type": "text/plain" }});
    }
  }
};

// ---------- Helpers ----------

function htmlIndex() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Edge Rewriter (educational)</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;max-width:720px;margin:5vh auto;padding:24px}
    input,button{font:inherit;padding:10px;border-radius:10px;border:1px solid #ddd}
    .row{display:flex;gap:8px}
    .row input{flex:1}
    small{color:#666}
  </style>
</head>
<body>
  <h1>Edge Rewriter</h1>
  <form class="row" method="get">
    <input name="u" placeholder="https://example.com" spellcheck="false" />
    <button type="submit">Go</button>
  </form>
  <p><small>For educational/testing use on content you’re allowed to proxy.</small></p>
</body>
</html>`;
}

async function buildOutboundInit(request) {
  const { method } = request;

  // Clone body only for methods that can have a body
  let body = null;
  if (!["GET", "HEAD"].includes(method)) {
    // CF Workers allow body to be passed through directly
    body = request.body;
  }

  // Copy headers but drop hop-by-hop and encoding headers
  const headers = new Headers(request.headers);
  const drop = [
    "host",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "content-length",
    "accept-encoding",
    "connection",
    "upgrade",
    "via",
    "te",
    "trailers",
    "proxy-authorization",
    "proxy-authenticate",
    "keep-alive",
  ];
  for (const h of drop) headers.delete(h);

  // Let the platform negotiate encodings; upstream will handle gzip/brotli
  return { method, headers, body, redirect: "manual" };
}

function sanitizeHeaders(headers) {
  const strip = [
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "alt-svc",
  ];
  for (const h of strip) headers.delete(h);
  // Avoid leaking upstream cookies to the client by default
  headers.delete("set-cookie");
  // Safer default
  headers.set("x-content-type-options", "nosniff");
}

// Convert absolute/relative to proxied URL
function proxify(absOrRel, baseUrl) {
  try {
    const absolute = new URL(absOrRel, baseUrl).href;
    const self = new URL("https://example.com/"); // placeholder; we only need search shape
    self.searchParams.set(PARAM, absolute);
    return `?${self.searchParams.toString()}`;
  } catch {
    return absOrRel; // if it’s something weird, leave it
  }
}

// HTML attribute rewriter
class AttrRewriter {
  constructor(attr, baseUrl) {
    this.attr = attr;
    this.baseUrl = baseUrl;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val) return;
    // Skip data:, mailto:, javascript:, tel:, etc.
    if (/^(data:|mailto:|javascript:|tel:|blob:)/i.test(val)) return;
    el.setAttribute(this.attr, proxify(val, this.baseUrl));
  }
}

// Meta refresh (e.g., <meta http-equiv="refresh" content="0;url=/next">)
class MetaRefreshRewriter {
  constructor(baseUrl) { this.baseUrl = baseUrl; }
  element(el) {
    const content = el.getAttribute("content");
    if (!content) return;
    const m = content.match(/^\s*\d+\s*;\s*url\s*=\s*(.+)\s*$/i);
    if (!m) return;
    const rewritten = content.replace(m[1], proxify(m[1], this.baseUrl));
    el.setAttribute("content", rewritten);
  }
}

// Basic CSS url(...) rewriting
function rewriteCssUrls(cssText, baseUrl) {
  return cssText.replace(/url\(([^)]+)\)/gi, (m, p1) => {
    let raw = p1.trim().replace(/^['"]|['"]$/g, "");
    if (/^(data:|about:|mailto:|javascript:|blob:)/i.test(raw)) return m;
    const proxied = proxify(raw, baseUrl);
    // Preserve quoting if present
    const quoted = (/^['"].*['"]$/).test(p1.trim()) ? `"${proxied}"` : proxied;
    return `url(${quoted})`;
  });
}
