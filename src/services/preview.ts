// Live preview of a generated web project. Files are served from /api/preview/:id/<path>
// with a CSP sandbox (opaque origin): the app can run scripts but can never read Baton's
// page, cookies or the API keys saved in Baton's localStorage.

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  svg: "image/svg+xml", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
};

export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups";

export function contentTypeFor(path: string): string {
  return TYPES[path.toLowerCase().split(".").pop() ?? ""] ?? "text/plain; charset=utf-8";
}

/** The page to open first: index.html at the shallowest level, else any HTML file. */
export function previewEntry(artifacts: Record<string, string>): string | undefined {
  const html = Object.keys(artifacts).filter((p) => /\.html?$/i.test(p));
  return html.filter((p) => /(^|\/)index\.html?$/i.test(p)).sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? html.sort()[0];
}

// The sandboxed page has no storage of its own (opaque origin), so apps that save to
// localStorage would crash. Give them an in-memory stand-in for the preview.
const STORAGE_SHIM =
  "<script>(function(){function S(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}" +
  "['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('x')}catch(e){Object.defineProperty(window,n,{value:S(),configurable:true})}})})();</script>";

/** Insert the storage stand-in before any of the page's own scripts. */
export function withPreviewShim(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_SHIM + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + STORAGE_SHIM + html.slice(doctype.index + doctype[0].length);
  return STORAGE_SHIM + html;
}
