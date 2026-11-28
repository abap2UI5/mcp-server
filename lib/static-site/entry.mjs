/*
 * The browser entry of build_static: the whole abap2UI5 backend - the
 * framework and the project's classes, transpiled by the npm backend's build
 * - runs in this tab; sql.js is the database. The recipe of
 * abap2UI5/browser-demo (app/web.mjs), with what a static host of ANY
 * project needs on top:
 *
 *   - the start class: the page starts the class build_static was given,
 *     unless the URL names another (?app_start=...)
 *   - the endpoint is this page, with or without its trailing slash and
 *     index.html: a GitHub project page is /<repo>/, and the frontend
 *     compares its endpoint without the slash
 *   - a SCRIPT ELEMENT addressed to the endpoint (from 1.151 on the frontend
 *     loads ?z2ui5-bundle=<hash> - and the custom controls and devtools
 *     bundles - with a script element, which no fetch override sees and no
 *     static host answers): its src is answered by the backend in this tab
 *     through a blob URL, and reading `src` back still gives the endpoint
 *     URL, because the frontend derives the next bundle's URL from it
 *   - the frontend files of addon BSPs (/sap/bc/ui5_ui5/sap/<bsp>/...) are
 *     files of the site, beside this page: a request for one is pointed
 *     there, by script element, fetch and XMLHttpRequest alike
 *
 * The configuration comes from the build (globalThis.__A2UI5_STATIC__ is
 * defined by esbuild): { startClass, ui5 }.
 */
import { initializeABAP } from 'abap2ui5-static:init';

const CONFIG = __A2UI5_STATIC__;
const BSP_PATH = '/sap/bc/ui5_ui5/sap/';

/* ---- where we are ---- */
const BASE = new URL('.', window.location.href); // the site's folder, with its slash
const strip = (p) => p.replace(/\/index\.html?$/i, '').replace(/\/+$/, '');
const ENDPOINT = strip(window.location.pathname);

if (CONFIG.startClass && !new URL(window.location.href).searchParams.has('app_start')) {
  const u = new URL(window.location.href);
  u.searchParams.set('app_start', CONFIG.startClass);
  window.history.replaceState(window.history.state, '', u.href);
}

await initializeABAP();

/* ---- the backend in this tab: a fetch() into CL_EXPRESS_ICF_SHIM ---- */
function isRequest(input) {
  return typeof Request !== 'undefined' && input instanceof Request;
}

async function readRequest(input, options) {
  if (isRequest(input)) {
    return { url: input.url, method: input.method, headers: Object.fromEntries(input.headers), body: Buffer.from(await input.arrayBuffer()) };
  }
  return {
    url: String(input),
    method: options.method || 'GET',
    headers: Object.fromEntries(new Headers(options.headers || {})),
    body: Buffer.from(options.body || ''),
  };
}

async function backendFetch(input, options = {}) {
  const request = await readRequest(input, options);
  let status = 200;
  let body = Buffer.alloc(0);
  const headers = new Map();
  const res = {
    append: (name, value) => { headers.set(String(name).toLowerCase(), String(value)); },
    status: (code) => { status = Number(code); return res; },
    send: (data) => { body = Buffer.from(data); },
  };
  const req = {
    body: request.body,
    method: request.method,
    headers: request.headers,
    path: new URL(request.url, window.location.href).pathname,
    url: request.url,
  };
  await abap.Classes['CL_EXPRESS_ICF_SHIM'].run({ req, res, class: 'ZCL_SICF' });
  const hasBody = status !== 204 && status !== 205 && status !== 304;
  return new Response(hasBody ? body : null, { status, headers: Object.fromEntries(headers) });
}

function hrefOf(input) {
  if (isRequest(input)) return input.url;
  if (typeof input === 'string' || input instanceof URL) return String(input);
  return null;
}

/** Is `href` addressed to the backend - this page, slash or not? */
function isBackendUrl(href) {
  if (href === null || href === undefined) return false;
  try {
    const t = new URL(String(href), window.location.href);
    return t.origin === window.location.origin && strip(t.pathname) === ENDPOINT;
  } catch {
    return false;
  }
}

/** A BSP file's URL as a file of this site, or null. */
function bspUrl(href) {
  if (href === null || href === undefined) return null;
  try {
    const t = new URL(String(href), window.location.href);
    if (t.origin !== window.location.origin) return null;
    const at = t.pathname.toLowerCase().indexOf(BSP_PATH);
    if (at < 0) return null;
    const local = new URL(t.pathname.slice(at + 1) + t.search, BASE);
    return local.href === t.href ? null : local.href;
  } catch {
    return null;
  }
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const href = hrefOf(input);
  if (isBackendUrl(href)) return backendFetch(input, options);
  const bsp = bspUrl(href);
  if (bsp) return nativeFetch(bsp, isRequest(input) ? undefined : options);
  return nativeFetch(input, options);
};

/* UI5 loads some modules synchronously, by XMLHttpRequest */
const nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
  return nativeOpen.call(this, method, bspUrl(url) || url, ...rest);
};

/* ---- script elements: the bundles the frontend loads by src ---- */
const srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
const ORIGINAL = Symbol('a2ui5 original src');
Object.defineProperty(HTMLScriptElement.prototype, 'src', {
  configurable: true,
  enumerable: srcDesc.enumerable,
  get() {
    return this[ORIGINAL] || srcDesc.get.call(this);
  },
  set(value) {
    const bsp = bspUrl(value);
    if (bsp) {
      srcDesc.set.call(this, bsp);
      return;
    }
    if (!isBackendUrl(value)) {
      srcDesc.set.call(this, value);
      return;
    }
    const el = this;
    el[ORIGINAL] = new URL(String(value), window.location.href).href;
    backendFetch(el[ORIGINAL], { method: 'GET' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = new Blob([await r.arrayBuffer()], { type: 'text/javascript' });
        srcDesc.set.call(el, URL.createObjectURL(blob));
      })
      .catch((e) => {
        console.error(`abap2UI5 static: ${el[ORIGINAL]} - ${e.message}`);
        el.dispatchEvent(new Event('error'));
      });
  },
});
const nativeSetAttribute = Element.prototype.setAttribute;
Element.prototype.setAttribute = function setAttribute(name, value) {
  if (this instanceof HTMLScriptElement && String(name).toLowerCase() === 'src') {
    this.src = value;
    return undefined;
  }
  return nativeSetAttribute.call(this, name, value);
};

/* ---- boot: the page the backend serves, written into this document ---- */
try {
  const response = await backendFetch(window.location.href, { method: 'GET' });
  let html = await response.text();
  if (!response.ok) throw new Error(`the backend answered ${response.status}: ${html.slice(0, 300)}`);
  // the backend's CSP is written for a server; here it would block the runtime running in this tab
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/?>/i, '');
  const BOOTSTRAP_OPEN_TAG = /<script[^>]*\bid="sap-ui-bootstrap"[^>]*\bdata-sap-ui-[^>]*>/i;
  if (!BOOTSTRAP_OPEN_TAG.test(html)) throw new Error('no sap-ui-bootstrap script tag in the page the backend served');
  // UI5's ResizeHandler still listens to window "unload", which Chromium refuses with a console violation;
  // "pagehide" is the same moment (the recipe of browser-demo's app/web.mjs) - in front of the bootstrap
  const unloadShim = '<script>(function () {'
    + 'var add = window.addEventListener.bind(window); var remove = window.removeEventListener.bind(window);'
    + 'window.addEventListener = function (t, l, o) { return add(t === "unload" ? "pagehide" : t, l, o); };'
    + 'window.removeEventListener = function (t, l, o) { return remove(t === "unload" ? "pagehide" : t, l, o); };'
    + '})();</' + 'script>';
  html = html.replace(BOOTSTRAP_OPEN_TAG, (tag) => unloadShim + tag);
  if (CONFIG.ui5) {
    const src = `https://sdk.openui5.org/${CONFIG.ui5}/resources/sap-ui-core.js`;
    html = html.replace(BOOTSTRAP_OPEN_TAG, (tag) => tag.replace(/\bsrc="[^"]*"/i, () => `src="${src}"`));
  }
  if (document.readyState === 'loading') {
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  document.open();
  document.write(html);
  document.close();
} catch (error) {
  console.error(error);
  document.body.textContent = `abap2UI5 could not boot: ${(error && error.message) || error}`;
}
