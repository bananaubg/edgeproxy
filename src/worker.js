// src/worker.js
const DEFAULTS = {
  MAX_REWRITE_BYTES: 2_000_000, // skip files over 2MB
  CACHE_TTL: 3600, // 1 hour for caching
};

// -------- utils --------
const nowMs = () => Date.now();

function isRewriteableResource(url) {
  return url && !/^(data:|blob:|about:|mailto:|javascript:)/i.test(url);
}

function resolveUrl(raw, base) {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

function proxify(origin, absoluteUrl) {
  return `${origin}/${absoluteUrl}`;
}

// -------- CSS Rewriter --------
function rewriteCSS(cssText, base, origin) {
  if (!cssText) return cssText;
  cssText = cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m,q,u)=>{
    if(!isRewriteableResource(u)) return m;
    return `url(${proxify(origin, resolveUrl(u,base))})`;
  });
  cssText = cssText.replace(/@import\s+(?:url\()?['"]?([^'"\)\s]+)['"]?\)?/gi,(m,u)=>{
    if(!isRewriteableResource(u)) return m;
    return `@import url("${proxify(origin, resolveUrl(u,base))}")`;
  });
  return cssText;
}

// -------- JS Rewriter --------
function rewriteJS(jsText, base, origin) {
  if(!jsText || jsText.length>DEFAULTS.MAX_REWRITE_BYTES) return jsText;

  const proxifyIf = u => {
    if(!isRewriteableResource(u)) return u;
    if(u.startsWith(origin)) return u;
    return proxify(origin, resolveUrl(u,base));
  };

  return jsText
    // fetch('...')
    .replace(/fetch\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi,(m,q,u)=>`fetch(${q}${proxifyIf(u)}${q}`)
    // import('...')
    .replace(/import\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1\s*\)/gi,(m,q,u)=>`import(${q}${proxifyIf(u)}${q})`)
    // importScripts(...)
    .replace(/importScripts\(\s*([^)]+)\)/gi,(m,args)=>{
      const parts = args.split(",").map(p=>{
        const m2=p.match(/^(['"`])(.*)\1$/);
        if(m2) return `${m2[1]}${proxifyIf(m2[2])}${m2[1]}`;
        return p;
      });
      return `importScripts(${parts.join(",")})`;
    })
    // XHR open
    .replace(/(\.open\s*\(\s*(['"`])(?:GET|POST|PUT|DELETE|OPTIONS|HEAD)\2\s*,\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\3)/gi,(m,prefix,q1,q2,url)=>{
      return prefix.replace(url, proxifyIf(url));
    })
    // new Worker / SharedWorker
    .replace(/new\s+(?:Worker|SharedWorker)\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi,(m,q,u)=>m.replace(u,proxifyIf(u)))
    // location.href / assign
    .replace(/(location(?:\.href|\.assign)?\s*=\s*)(['"`])((?:https?:\/\/|\/)[^'"`]+)\2/gi,(m,lhs,q,u)=>`${lhs}${q}${proxifyIf(u)}${q}`)
    // serviceWorker.register('/sw.js')
    .replace(/(registerServiceWorker|serviceWorker\.register)\(\s*(['"`])((?:https?:\/\/|\/)[^'"`]+)\2\s*\)/gi,(m,fn,q,u)=>`${fn}(${q}${proxifyIf(u)}${q})`)
    // sourceMappingURL
    .replace(/(\/\/# sourceMappingURL=)(.*)/gi,(m,prefix,url)=>isRewriteableResource(url)?`${prefix}${proxifyIf(url)}`:m)
    // generic URLs
    .replace(/(['"`])((?:https?:\/\/|\/)[^'"`]+)\1/gi,(m,q,u)=>{
      if(u.startsWith(origin)) return m;
      if(/[<>\s]/.test(u)) return m;
      return `${q}${proxifyIf(u)}${q}`;
    });
}

// -------- JSON Rewriter --------
function rewriteJSON(text, base, origin) {
  if(!text) return text;
  try{
    const parsed=JSON.parse(text);
    const replacer=obj=>{
      if(Array.isArray(obj)) return obj.map(replacer);
      else if(obj && typeof obj==="object"){
        const out={};
        for(const k in obj) out[k]=replacer(obj[k]);
        return out;
      } else if(typeof obj==="string"){
        if(/^(?:https?:\/\/|\/)/i.test(obj) && isRewriteableResource(obj)) return proxify(origin, resolveUrl(obj,base));
        return obj;
      } else return obj;
    };
    return JSON.stringify(replacer(parsed));
  }catch{return text;}
}

// -------- HTML Handlers --------
function createHTMLHandlers(origin, base){
  return {
    element(el){
      const t = el.tagName.toLowerCase();
      if(t==="a"||t==="area"){
        const h=el.getAttribute("href");
        if(h && !h.startsWith("javascript:")) el.setAttribute("href", proxify(origin, resolveUrl(h,base)));
      } else if(["img","video","audio","source","iframe"].includes(t)){
        ["src","poster","data-src","data-srcset","srcset"].forEach(attr=>{
          const v=el.getAttribute(attr);
          if(!v) return;
          if(attr==="srcset"){
            const parts=v.split(",").map(p=>{
              const [url,desc]=p.trim().split(/\s+/,2);
              if(!isRewriteableResource(url)) return p;
              return `${proxify(origin, resolveUrl(url,base))}${desc?" "+desc:""}`;
            });
            el.setAttribute(attr, parts.join(", "));
          } else if(isRewriteableResource(v)) el.setAttribute(attr, proxify(origin, resolveUrl(v,base)));
        });
      } else if(t==="link"||t==="script"){
        const u=el.getAttribute(t==="link"?"href":"src");
        if(u && isRewriteableResource(u)) el.setAttribute(t==="link"?"href":"src", proxify(origin, resolveUrl(u,base)));
        if(el.hasAttribute("integrity")) el.removeAttribute("integrity");
      } else if(t==="style"){
        const txt=el.text||"";
        el.setInnerContent(rewriteCSS(txt,base,origin),{html:false});
      } else if(t==="script" && !el.getAttribute("src")){
        const txt=el.text||"";
        el.setInnerContent(rewriteJS(txt,base,origin),{html:false});
      } else if(el.hasAttribute("style")){
        const s=el.getAttribute("style");
        el.setAttribute("style", rewriteCSS(s,base,origin));
      }
    }
  };
}

// -------- main fetch --------
export default {
  async fetch(request){
    const url=new URL(request.url);
    let target=url.pathname.slice(1)+url.search;
    if(!/^https?:\/\//i.test(target)) target="https://"+target;
    const origin=url.origin;

    const headers=new Headers(request.headers);
    ["cookie","authorization","referer","host"].forEach(h=>headers.delete(h));

    const req=new Request(target,{
      method:request.method,
      headers,
      body:["GET","HEAD"].includes(request.method)?undefined:request.body,
      redirect:"manual"
    });

    let res;
    try{res=await fetch(req);}catch(e){return new Response("Upstream failed: "+e.message,{status:502});}

    const outHeaders=new Headers(res.headers);
    ["content-security-policy","x-frame-options","x-xss-protection"].forEach(h=>outHeaders.delete(h));
    outHeaders.set("access-control-allow-origin","*");
    outHeaders.set("access-control-allow-headers","*");

    const ct=(outHeaders.get("content-type")||"").toLowerCase();

    if(ct.includes("text/html")){
      return new HTMLRewriter().on("*", createHTMLHandlers(origin,target))
        .transform(new Response(res.body,{status:res.status,headers:outHeaders}));
    } else if(ct.includes("javascript")||/\.js$/.test(target)){
      const t=await res.text();
      return new Response(rewriteJS(t,target,origin),{status:res.status,headers:outHeaders});
    } else if(ct.includes("css")||/\.css$/.test(target)){
      const t=await res.text();
      return new Response(rewriteCSS(t,target,origin),{status:res.status,headers:outHeaders});
    } else if(ct.includes("json")||/\.json$/.test(target)){
      const t=await res.text();
      return new Response(rewriteJSON(t,target,origin),{status:res.status,headers:outHeaders});
    } else {
      return new Response(res.body,{status:res.status,headers:outHeaders});
    }
  }
};
