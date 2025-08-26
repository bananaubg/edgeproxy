const PARAM = "u"; // query param for target URL

export default {
  async fetch(request) {
    try {
      const reqUrl = new URL(request.url);
      const targetRaw = reqUrl.searchParams.get(PARAM);

      // Landing page
      if (!targetRaw) {
        return new Response(htmlIndex(), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // Resolve target
      let target;
      try {
        target = new URL(targetRaw);
      } catch {
        target = new URL(`https://${targetRaw}`);
      }

      // Build outbound request
      const outboundInit = await buildOutboundInit(request);

      // Fetch upstream
      const upstreamResp = await fetch(target, outboundInit);
      const contentType = upstreamResp.headers.get("content-type") || "";
      const headers = new Headers(upstreamResp.headers);
      sanitizeHeaders(headers);

      // Rewrite HTML
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

      // Rewrite CSS urls
      if (contentType.includes("text/css")) {
        const cssText = await upstreamResp.text();
        const rewritten = rewriteCssUrls(cssText, target);
        headers.set("content-type", "text/css; charset=utf-8");
        return new Response(rewritten, {
          status: upstreamResp.status,
          headers
        });
      }

      // Other → passthrough
      const buf = await upstreamResp.arrayBuffer();
      return new Response(buf, { status: upstreamResp.status, headers });

    } catch (err) {
      return new Response(`Proxy error: ${err?.message || err}`, {
        status: 500,
        headers: { "content-type": "text/plain" }
      });
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
  <title>Edge Rewriter</title>
</head>
<body>
  <h1>Edge Rewriter Proxy</h1>
  <form method="get">
    <input name="u" placeholder="https://example.com" style="width:300px"/>
    <button type="submit">Go</button>
  </form>
</body>
</html>`;
}

async function buildOutboundInit(request) {
  const { method } = request;
  let body = null;
  if (!["GET", "HEAD"].includes(method)) {
    body = request.body;
  }

  const headers = new Headers(request.headers);
  const drop = [
    "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    "content-length", "accept-encoding", "connection", "upgrade", "via",
    "te", "trailers", "proxy-authorization", "proxy-authenticate", "keep-alive"
  ];
  for (const h of drop) headers.delete(h);

  return { method, headers, body, redirect: "manual" };
}

function sanitizeHeaders(headers) {
  const strip = [
    "content-encoding", "content-length", "transfer-encoding",
    "connection", "alt-svc"
  ];
  for (const h of strip) headers.delete(h);
  headers.delete("set-cookie");
  headers.set("x-content-type-options", "nosniff");
}

function proxify(absOrRel, baseUrl) {
  try {
    const absolute = new URL(absOrRel, baseUrl).href;
    const self = new URL("https://example.com/");
    self.searchParams.set(PARAM, absolute);
    return `?${self.searchParams.toString()}`;
  } catch {
    return absOrRel;
  }
}

class AttrRewriter {
  constructor(attr, baseUrl) { this.attr = attr; this.baseUrl = baseUrl; }
  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val) return;
    if (/^(data:|mailto:|javascript:|tel:|blob:)/i.test(val)) return;
    el.setAttribute(this.attr, proxify(val, this.baseUrl));
  }
}

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

function rewriteCssUrls(cssText, baseUrl) {
  return cssText.replace(/url\(([^)]+)\)/gi, (m, p1) => {
    let raw = p1.trim().replace(/^['"]|['"]$/g, "");
    if (/^(data:|about:|mailto:|javascript:|blob:)/i.test(raw)) return m;
    const proxied = proxify(raw, baseUrl);
    return `url("${proxied}")`;
  });
}
