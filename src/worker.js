export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");

    if (!target) {
      return new Response(
        `Use like: ${url.origin}?url=https://example.com`,
        { headers: { "content-type": "text/plain" } }
      );
    }

    const res = await fetch(target, { redirect: "manual" });

    // Handle redirects by rewriting them through proxy
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      if (loc) {
        const absolute = new URL(loc, target).toString();
        const proxied = `${url.origin}?url=${encodeURIComponent(absolute)}`;
        return Response.redirect(proxied, res.status);
      }
    }

    // Clone headers, strip security stuff
    const headers = new Headers(res.headers);
    headers.delete("content-security-policy");
    headers.delete("x-frame-options");

    const contentType = headers.get("content-type") || "";

    // If HTML, rewrite links/scripts/images/forms
    if (contentType.includes("text/html")) {
      const rewriter = new HTMLRewriter()
        .on("a[href]", {
          element(el) {
            const href = el.getAttribute("href");
            if (href && !href.startsWith("javascript:")) {
              const absolute = new URL(href, target).toString();
              el.setAttribute("href", `?url=${encodeURIComponent(absolute)}`);
            }
          },
        })
        .on("form[action]", {
          element(el) {
            const action = el.getAttribute("action");
            if (action) {
              const absolute = new URL(action, target).toString();
              el.setAttribute("action", `?url=${encodeURIComponent(absolute)}`);
            }
          },
        })
        .on("img[src]", {
          element(el) {
            const src = el.getAttribute("src");
            if (src) {
              const absolute = new URL(src, target).toString();
              el.setAttribute("src", `?url=${encodeURIComponent(absolute)}`);
            }
          },
        })
        .on("script[src]", {
          element(el) {
            const src = el.getAttribute("src");
            if (src) {
              const absolute = new URL(src, target).toString();
              el.setAttribute("src", `?url=${encodeURIComponent(absolute)}`);
            }
          },
        })
        .on("link[href]", {
          element(el) {
            const href = el.getAttribute("href");
            if (href) {
              const absolute = new URL(href, target).toString();
              el.setAttribute("href", `?url=${encodeURIComponent(absolute)}`);
            }
          },
        });

      return rewriter.transform(
        new Response(res.body, { headers, status: res.status })
      );
    }

    // Otherwise just return untouched (CSS, JS, images, etc.)
    return new Response(res.body, { headers, status: res.status });
  },
};
