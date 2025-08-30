// Advanced CF Worker proxy with rewriting.
// Modes:
//  - GET /?u=<url> → proxy+rewrite
//  - Any asset URL discovered in HTML/CSS is rewritten back through /?u=...

const PARAM = "u";

// Utility: normalize/absolute → proxied
function proxify(absOrRel, baseUrl) {
  try {
    const absolute = new URL(absOrRel, baseUrl).href;
    const proxy = new URL("https://example.invalid/"); // placeholder; we only need search shape
    proxy.searchParams.set(PARAM, absolute);
    return `/?${proxy.searchParams.toString()}`;
  } catch {
    return absOrRel;
  }
}

function dropHopByHop(h) {
  const strip = [
    "connection","keep-alive","proxy-authenticate","proxy-authorization","te",
    "trailer","transfer-encoding","upgrade","content-length","accept-encoding",
    "via","alt-svc"
  ];
  for (const k of strip) h.delete(k);
}

function relaxEmbedding(h) {
  // Kill frame blockers
  h.delete("x-frame-options");
  // Best-effort CSP relax (remove frame-ancestors; keep rest)
  const csp = h.get("content-security-policy");
  if (csp) {
    const relaxed = csp
      .split(";")
      .map(d => d.trim())
      .filter(d => !/^frame-ancestors/i.test(d))
      .join("; ");
    if (relaxed) h.set("content-security-policy", relaxed);
    else h.delete("content-security-policy");
  }
  // Avoid content-type confusion
  h.set("x-content-type-options", "nosniff");
}

function rewriteCssUrls(cssText, baseUrl) {
  // url(foo), url('foo'), url("foo") — keep data: and friends intact
  return cssText.replace(/url\(([^)]+)\)/gi, (m, p1) => {
    let raw = p1.trim().replace(/^['"]|['"]$/g, "");
    if (/^(data:|about:|mailto:|javascript:|blob:)/i.test(raw)) return m;
    const proxied = proxify(raw, baseUrl);
    const quoted = (/^['"].*['"]$/).test(p1.trim()) ? `"${proxied}"` : `${proxied}`;
    return `url(${quoted})`;
  });
}

class AttrRewriter {
  constructor(attr, baseUrl) { this.attr = attr; this.baseUrl = baseUrl; }
  element(el) {
    const v = el.getAttribute(this.attr);
    if (!v) return;
    if (/^(data:|mailto:|javascript:|tel:|blob:)/i.test(v)) return;
    el.setAttribute(this.attr, proxify(v, this.baseUrl));
  }
}

class SrcSetRewriter {
  constructor(baseUrl) { this.baseUrl = baseUrl; }
  element(el) {
    const v = el.getAttribute("srcset");
    if (!v) return;
    // srcset: "img1.jpg 1x, img2.jpg 2x"
    const rewritten = v.split(",").map(part => {
      const [url, size] = part.trim().split(/\s+/, 2);
      if (!url) return part;
      return [proxify(url, this.baseUrl), size].filter(Boolean).join(" ");
    }).join(", ");
    el.setAttribute("srcset", rewritten);
  }
}

class StyleUrlRewriter {
  constructor(baseUrl) { this.baseUrl = baseUrl; }
  element(el) {
    const style = el.getAttribute("style");
    if (!style) return;
    const rewritten = rewriteCssUrls(style, this.baseUrl);
    el.setAttribute("style", rewritten);
  }
}

class MetaRefreshRewriter {
  constructor(baseUrl) { this.baseUrl = baseUrl; }
  element(el) {
    const content = el.getAttribute("content");
    if (!content) return;
    const m = content.match(/^\s*\d+\s*;\s*url\s*=\s*(.+)\s*$/i);
    if (!m) return;
    el.setAttribute("content", content.replace(m[1], proxify(m[1], this.baseUrl)));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Front page: serve the static UI from /public (handled by assets), or show minimal.
    if (!url.searchParams.has(PARAM)) {
      // If assets is enabled, let it serve index.html; otherwise show mini form.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Let assets serve; if not configured, fall through to form:
      } else if (url.pathname !== "/") {
        // Allow static files via assets. If not enabled, 404.
      }
    }

    const targetRaw = url.searchParams.get(PARAM);
    if (!targetRaw) {
      return new Response(`<!doctype html><meta charset="utf-8">
        <title>Edge Rewriter</title>
        <form method="get" style="font:14px system-ui;margin:2rem">
          <input name="u" placeholder="https://example.com" style="width:360px;padding:8px"/>
          <button type="submit" style="padding:8px 12px">Go</button>
        </form>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    let target;
    try {
      target = new URL(targetRaw);
    } catch {
      target = new URL(`https://${targetRaw}`);
    }

    // Build outbound request mirroring method/body/headers
    const outbound = { method: request.method, redirect: "manual" };
    if (!["GET","HEAD"].includes(request.method)) outbound.body = request.body;

    const fwd = new Headers(request.headers);
    // Don’t forward our own origin/length/encodings etc.
    dropHopByHop(fwd);
    fwd.delete("host");
    fwd.delete("origin"); // avoid CORS weirdness upstream
    // Optional: spoof basic UA to reduce fingerprinting breakage
    const ua = request.headers.get("user-agent");
    if (ua) fwd.set("user-agent", ua);
    outbound.headers = fwd;

    const upstream = await fetch(target, outbound);

    const h = new Headers(upstream.headers);
    dropHopByHop(h);
    relaxEmbedding(h);

    const ct = h.get("content-type") || "";

    // HTML → rewrite links/assets/forms/meta refresh, style url(), srcset
    if (ct.includes("text/html")) {
      const rewriter = new HTMLRewriter()
        .on("a[href]", new AttrRewriter("href", target))
        .on("area[href]", new AttrRewriter("href", target))
        .on("link[href]", new AttrRewriter("href", target))
        .on("script[src]", new AttrRewriter("src", target))
        .on("img[src]", new AttrRewriter("src", target))
        .on("iframe[src]", new AttrRewriter("src", target))
        .on("video[src]", new AttrRewriter("src", target))
        .on("audio[src]", new AttrRewriter("src", target))
        .on("source[src]", new AttrRewriter("src", target))
        .on("form[action]", new AttrRewriter("action", target))
        .on("img[srcset]", new SrcSetRewriter(target))
        .on("*[style]", new StyleUrlRewriter(target))
        .on("meta[http-equiv='refresh']", new MetaRefreshRewriter(target));
      h.set("content-type", "text/html; charset=utf-8");
      return rewriter.transform(new Response(upstream.body, { status: upstream.status, headers: h }));
    }

    // CSS → rewrite url(...)
    if (ct.includes("text/css")) {
      const css = await upstream.text();
      const out = rewriteCssUrls(css, target);
      h.set("content-type", "text/css; charset=utf-8");
      return new Response(out, { status: upstream.status, headers: h });
    }

    // JS/Images/Fonts/etc → pass through
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: h });
  }
};
