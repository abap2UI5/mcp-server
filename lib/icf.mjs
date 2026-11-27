/*
 * The deployed HTTP handlers - classes implementing if_http_extension, the
 * way a system serves a service node in SICF - on the npm backend.
 *
 * An app is not only screens: a REST endpoint for a device, a webhook, the
 * door a middleware polls. On a system each gets a service node; on the npm
 * backend lib/npm-host.mjs runs any deployed handler class under
 *
 *   /__a2ui5/icf/<CLASS>[/rest of the path][?query]
 *
 * through the release's createHandler({ handlerClass }) - the same shim the
 * framework's own handler runs on, so get_form_field, the method, the body
 * and set_status behave as there. No configuration: a class that is not
 * deployed, or does not implement if_http_extension, answers 404 with the
 * reason. Loopback only, like every other request to the host.
 *
 * call_handler is the tool that sends such a request and returns the
 * answer - for an agent without a shell, and so a test of an endpoint needs
 * no script around the backend.
 */

/** Where the host mounts the handlers. */
export const ICF_MOUNT = '/__a2ui5/icf';

/** The methods call_handler sends. */
export const ICF_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Characters of a response body an answer carries before it is cut. */
export const ICF_BODY_LIMIT = 20000;

/** The class name of a handler, upper case, or null when it is none: a
 *  plain ABAP class name (letters, digits, underscore, 30 at most) - no
 *  namespace with slashes, which a URL segment would have to escape. */
export function icfClassName(name) {
  const up = String(name ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,29}$/.test(up) ? up : null;
}

/** The class and the rest of a path below ICF_MOUNT ("/ZCL_X/a/b" ->
 *  { className: "ZCL_X", rest: "/a/b" }), or null. */
export function icfTarget(url) {
  const [pathname, query = ''] = String(url || '').split(/\?(.*)/s);
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const className = icfClassName(decodeURIComponent(m[1]));
  if (!className) return null;
  return { className, rest: (m[2] || '/') + (query ? `?${query}` : '') };
}

/** Whether an error thrown by the shim means "no such handler class": the
 *  shim raises CX_SY_CREATE_OBJECT_ERROR for an unknown class, and the
 *  create-object check refuses one that does not implement the interface. */
export function isMissingHandler(e) {
  const names = [e && e.constructor && e.constructor.name, e && e.name, e && e.message, e && e.classname]
    .map((v) => String(v ?? '')).join(' ');
  return /CX_SY_CREATE_OBJECT_ERROR|CX_SY_MOVE_CAST_ERROR|IF_HTTP_EXTENSION/i.test(names);
}

/**
 * The route the host mounts at ICF_MOUNT: one createHandler per class, made
 * on the first request to it. `createHandler` is the release's.
 * @returns {(req: object, res: object, next: Function) => void}
 */
export function icfRoute(createHandler) {
  const handlers = new Map();
  return (req, res, next) => {
    const target = icfTarget(req.url);
    if (!target) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`abap2ui5 npm host: ${ICF_MOUNT}/<CLASS> - the class of an if_http_extension handler, e.g. ${ICF_MOUNT}/ZCL_MY_HANDLER?x=1\n`);
      return;
    }
    let handle = handlers.get(target.className);
    if (!handle) {
      handle = createHandler({ handlerClass: target.className });
      handlers.set(target.className, handle);
    }
    req.url = target.rest;
    Promise.resolve(handle(req, res)).catch((e) => {
      if (res.headersSent) return next(e);
      const missing = isMissingHandler(e);
      res.statusCode = missing ? 404 : 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(missing
        ? `abap2ui5 npm host: no deployed class ${target.className} implementing if_http_extension - deploy it, then build_backend\n`
        : `abap2ui5 npm host: ${target.className} failed: ${String((e && e.message) || e).split('\n')[0]}\n`);
    });
  };
}

/**
 * Send one request to a handler on the backend at `baseUrl` and return
 * { status, content_type, body, bytes, truncated }. `query`: an object
 * (values stringified) or a query string; `body`: a string sent as is,
 * anything else as JSON.
 */
export async function callHandler({ baseUrl, className, method = 'GET', path = '', query, body, contentType, signal, limit = ICF_BODY_LIMIT }) {
  const cls = icfClassName(className);
  if (!cls) throw new Error(`class must be an ABAP class name (letters, digits, _; at most 30), not ${JSON.stringify(className)}`);
  const verb = String(method || 'GET').toUpperCase();
  if (!ICF_METHODS.includes(verb)) throw new Error(`method must be one of ${ICF_METHODS.join(', ')}`);
  const rest = String(path || '').replace(/^\/+/, '');
  if (/[?#]/.test(rest) || rest.split('/').includes('..')) throw new Error('path is the part after the class, without ? or # or ..; put parameters into `query`');
  let qs = '';
  if (typeof query === 'string') qs = query.replace(/^\?/, '');
  else if (query && typeof query === 'object') qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  /* backendBaseUrl() ends in a slash: "//__a2ui5" would be no path the route matches */
  const url = `${String(baseUrl).replace(/\/+$/, '')}${ICF_MOUNT}/${cls}${rest ? `/${rest.split('/').map(encodeURIComponent).join('/')}` : ''}${qs ? `?${qs}` : ''}`;
  const headers = {};
  let payload;
  if (body !== undefined && body !== null && verb !== 'GET' && verb !== 'HEAD') {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['content-type'] = contentType || (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
  }
  const res = await fetch(url, { method: verb, headers, body: payload, signal });
  const text = verb === 'HEAD' ? '' : await res.text();
  return {
    status: res.status,
    content_type: res.headers.get('content-type') || '',
    body: text.length > limit ? text.slice(0, limit) : text,
    bytes: Buffer.byteLength(text),
    truncated: text.length > limit,
  };
}
