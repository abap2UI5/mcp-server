/*
 * system - the app tools against a REAL SAP system, for MCP clients that are
 * not the VS Code extension (Claude Desktop, Claude Code, Cursor, ...).
 *
 * The server's app tools operate apps on the LOCAL backend. The VS Code
 * extension runs the same protocol client (vendored from lib/appclient.mjs)
 * against a real system, through its auth proxy - but that server lives in
 * the extension and is offered to the MCP clients of that window only. This
 * module is the same half for every other client: when A2UI5_MCP_SYSTEM_URL
 * is set, server.mjs serves the system tools (lib/system-tools.mjs) instead
 * of the sandbox loop, and every request goes straight to the system with
 * the configured user:
 *
 *   A2UI5_MCP_SYSTEM_URL           the launch URL, as F9 knows it:
 *                                  https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100
 *                                  (or the endpoint without the class)
 *   A2UI5_MCP_SYSTEM_USER          the SAP user
 *   A2UI5_MCP_SYSTEM_PASSWORD      its password - or, to keep it out of the
 *   A2UI5_MCP_SYSTEM_PASSWORD_CMD  client's config file, a command that
 *                                  prints it (a keychain lookup)
 *   A2UI5_MCP_SYSTEM_INSECURE_TLS  1: accept a certificate that cannot be
 *                                  verified (NODE_EXTRA_CA_CERTS is the
 *                                  better answer for a private CA)
 *
 * What this module adds to the protocol client is what the extension's
 * transport adds (vscode-extension src/agentapps.ts), minus the proxy:
 *
 *   - the ENDPOINT: the launch URL without the class - the frontend POSTs to
 *     its own page and names the class in the start request;
 *   - the LOCATION: the start request's ORIGIN/PATHNAME/SEARCH are the
 *     system's launch URL (the backend keeps them with the app's session);
 *   - the LOGON: Basic authentication on every request, and the system's
 *     cookies kept and sent back as a browser would (a CSRF token layer
 *     binds its token to the session cookie);
 *   - the BREAKER: a rejected logon is sent ONCE. SAP counts failed logons
 *     and locks the user after a few, and an agent retries - so after a 401
 *     nothing more is sent with that password, until the password command
 *     (if any) answers a different one or the server is restarted.
 *
 * The handshakes of the protocol - the CSRF token fetch and re-send, the
 * stateful session's sap-contextid - are the CLIENT's own (lib/appclient.mjs,
 * docs/agent-snapshot.md "Embedding the client"); the transport only carries
 * their headers. Pure where it can be: the request function, the password
 * command and the environment are parameters, so test/system.test.mjs runs
 * the whole decision tree without a system.
 */
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { AgentError, createAppClient } from './appclient.mjs';

/** The environment variables of the system mode, by role. */
export const SYSTEM_ENV = {
  url: 'A2UI5_MCP_SYSTEM_URL',
  user: 'A2UI5_MCP_SYSTEM_USER',
  password: 'A2UI5_MCP_SYSTEM_PASSWORD',
  passwordCmd: 'A2UI5_MCP_SYSTEM_PASSWORD_CMD',
  insecureTls: 'A2UI5_MCP_SYSTEM_INSECURE_TLS',
};

/** The class name the endpoint is derived with - any name works, it only has
 *  to be findable again in the expanded template (the extension's own). */
export const PROBE_CLASS = 'Z2UI5_AGENT_PROBE';

/** What follows "the backend did not answer (...)": this mode's own check. */
export const SYSTEM_HINT = 'is the system reachable? system_status checks the URL and the logon';

/** A roundtrip answer carries a whole view and its model, so the cap is
 *  generous - it only exists so that a runaway answer cannot fill memory. */
const RESPONSE_CAP = 32 * 1024 * 1024;

/** How long the password command may take (a keychain may ask the user). */
const PASSWORD_CMD_TIMEOUT_MS = 60 * 1000;

/** The class names app_start accepts on a system: the customer namespace
 *  (z/y, as the sandbox's classNameOf) and a namespaced class (/ns/cl_app),
 *  lower case as the client sends it - the extension's rule. */
const CLASS_RE = /^(?:[zy][a-z0-9_]*|\/[a-z0-9_]{1,10}\/[a-z0-9_]+)$/;
const CLASS_MAX = 30;

export function systemClassName(className) {
  const cls = String(className ?? '').trim().toLowerCase();
  if (!CLASS_RE.test(cls) || cls.length > CLASS_MAX) {
    throw new Error(
      `invalid class name '${String(className ?? '')}' — must be a plain ABAP class name in the customer namespace: `
      + '/^[zy][a-z0-9_]*$/ (letters, digits and underscores only, starting z or y) or a namespaced one (/ns/cl_app), '
      + `and <= ${CLASS_MAX} chars. e.g. zcl_my_app, z2ui5_cl_my_app`,
    );
  }
  return cls;
}

// ---------------------------------------------------------------------------
// Where the roundtrips go
// ---------------------------------------------------------------------------

/**
 * The abap2UI5 endpoint behind a launch URL: the URL the frontend POSTs every
 * roundtrip to, without the class. `{class}` is the placeholder the VS Code
 * extension's launch URLs carry; a URL without it is taken as the endpoint
 * (an `app_start` parameter in it is dropped). A template that puts the class
 * into the PATH has no such endpoint, and credentials in the URL are refused:
 * they belong in the USER/PASSWORD variables, never in a URL that is shown.
 */
export function systemEndpoint(launchUrl) {
  const raw = String(launchUrl ?? '').trim();
  let url;
  try {
    url = new URL(raw.replace(/\{class\}/gi, PROBE_CLASS));
  } catch {
    return { problem: `${SYSTEM_ENV.url} '${raw}' is not a URL — e.g. https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { problem: `${SYSTEM_ENV.url} must be an http(s) URL, not ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { problem: `${SYSTEM_ENV.url} carries credentials — put the user into ${SYSTEM_ENV.user} and the password into ${SYSTEM_ENV.password} (or ${SYSTEM_ENV.passwordCmd}), never into the URL` };
  }
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (value.toUpperCase() === PROBE_CLASS || key.toLowerCase() === 'app_start') url.searchParams.delete(key);
  }
  url.hash = '';
  if (decodeURIComponent(url.pathname).toUpperCase().includes(PROBE_CLASS)) {
    return {
      problem: `${SYSTEM_ENV.url} puts {class} into the path — the app tools POST to the abap2UI5 endpoint and name the `
        + 'class in the request, so the class must be a query parameter: https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100',
    };
  }
  return { endpoint: url.toString() };
}

/** The start request's location on the system: the endpoint's origin and
 *  path, its query (sap-client, theme, language) with the class added as
 *  `app_start` - what the browser sends from the launch URL. */
export function systemLocation(endpoint, app) {
  const url = new URL(endpoint);
  const query = new URLSearchParams(url.search);
  query.set('app_start', app);
  return { origin: url.origin, pathname: url.pathname, search: `?${query}` };
}

/** The sap-client of a URL, when it names one. */
export function sapClientOf(endpoint) {
  try {
    return new URL(endpoint).searchParams.get('sap-client') || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * The system mode's configuration, or null when A2UI5_MCP_SYSTEM_URL is not
 * set (the server is the sandbox loop then). A configuration with a mistake
 * still switches the mode on - the server starts, and every tool answers
 * with `problems` instead of a stack trace: in a desktop client the tool
 * answer is the one place a user sees.
 */
export function systemConfig(env = process.env) {
  const url = env[SYSTEM_ENV.url];
  if (url === undefined || String(url).trim() === '') return null;
  const problems = [];
  const where = systemEndpoint(url);
  if (where.problem) problems.push(where.problem);
  const user = String(env[SYSTEM_ENV.user] ?? '').trim();
  if (!user) problems.push(`${SYSTEM_ENV.user} is not set — the SAP user the app tools log on with`);
  const password = env[SYSTEM_ENV.password];
  const passwordCmd = String(env[SYSTEM_ENV.passwordCmd] ?? '').trim();
  const hasPassword = password !== undefined && password !== '';
  if (hasPassword && passwordCmd) {
    problems.push(`set ${SYSTEM_ENV.password} or ${SYSTEM_ENV.passwordCmd}, not both`);
  } else if (!hasPassword && !passwordCmd) {
    problems.push(`neither ${SYSTEM_ENV.password} nor ${SYSTEM_ENV.passwordCmd} is set — the password of ${user || 'the user'}, `
      + 'or a command that prints it (a keychain lookup)');
  }
  return {
    url: String(url).trim(),
    endpoint: where.endpoint,
    user,
    passwordSource: hasPassword ? 'env' : (passwordCmd ? 'command' : null),
    password: hasPassword ? String(password) : undefined,
    passwordCmd: passwordCmd || undefined,
    insecureTls: truthy(env[SYSTEM_ENV.insecureTls]),
    problems,
  };
}

/** The configuration as it may be SHOWN: never the password, never the command. */
export function describeConfig(config) {
  return {
    endpoint: config.endpoint || null,
    user: config.user || null,
    password: config.passwordSource === 'env' ? `set (${SYSTEM_ENV.password})`
      : config.passwordSource === 'command' ? `from a command (${SYSTEM_ENV.passwordCmd})` : 'not set',
    tls: config.insecureTls ? `unverified certificates accepted (${SYSTEM_ENV.insecureTls})` : 'certificates verified',
  };
}

/**
 * The password command, run once per call through the shell: its stdout,
 * without the trailing line break. What it printed is never part of an
 * error - a command that failed may have printed the secret anyway.
 */
export function runPasswordCommand(command, { timeoutMs = PASSWORD_CMD_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let errText = '';
    let settled = false;
    const child = spawnImpl(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(reject, new Error(`${SYSTEM_ENV.passwordCmd} did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('error', (e) => done(reject, new Error(`${SYSTEM_ENV.passwordCmd} could not be started: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const why = errText.trim().split('\n')[0].slice(0, 200);
        done(reject, new Error(`${SYSTEM_ENV.passwordCmd} exited with ${code}${why ? ` (${why})` : ''}`));
        return;
      }
      const password = out.replace(/\r?\n$/, '');
      if (!password) done(reject, new Error(`${SYSTEM_ENV.passwordCmd} printed nothing`));
      else done(resolve, password);
    });
  });
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/** The node error codes of a certificate that could not be verified. */
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE',
]);

/** A failed request as a sentence that says what to change. */
export function networkProblem(err, host) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const msg = (err && err.message) || String(err);
  if (TLS_CODES.has(code)) {
    return `the certificate of ${host} could not be verified (${code}) — point NODE_EXTRA_CA_CERTS at the system's CA `
      + `certificate (PEM), or set ${SYSTEM_ENV.insecureTls}=1 to accept it unverified`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `the host ${host} does not resolve (${code}) — check ${SYSTEM_ENV.url}, and the VPN`;
  if (code === 'ECONNREFUSED') return `${host} refused the connection (${code}) — check the port in ${SYSTEM_ENV.url}`;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `${host} did not answer (${code}) — check ${SYSTEM_ENV.url}, the network and the VPN`;
  }
  if (err && err.name === 'AbortError') return `the request to ${host} was aborted (timeout)`;
  return msg;
}

/** One request with node http(s) - not `fetch`, which cannot be told to
 *  accept one system's self-signed certificate without a global switch. */
export function nodeRequest(url, { method = 'GET', headers = {}, body, signal, insecureTls = false } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
      signal,
      ...(target.protocol === 'https:' ? { rejectUnauthorized: !insecureTls } : {}),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_CAP) {
          res.destroy();
          reject(new Error(`the answer exceeded ${RESPONSE_CAP / 1024 / 1024} MB`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The cookies of one system, kept as a browser keeps them for one host. */
export function cookieJar() {
  const cookies = new Map();
  return {
    keep(headers) {
      const raw = headers && (headers['set-cookie'] ?? headers['Set-Cookie']);
      for (const line of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        const [pair, ...attrs] = String(line).split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attrs.some((a) => {
          const [k, v = ''] = a.split('=').map((x) => x.trim());
          if (/^max-age$/i.test(k)) return Number(v) <= 0;
          if (/^expires$/i.test(k)) {
            const t = Date.parse(v);
            return Number.isFinite(t) && t <= Date.now();
          }
          return false;
        });
        if (expired || value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return cookies.size ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
    },
    get size() {
      return cookies.size;
    },
  };
}

/**
 * The system as one function that sends a request with the logon: Basic
 * authentication, the system's cookies, the TLS choice - and the breaker
 * (see the header). `request` and `runCommand` are injectable for the tests.
 */
export function createSystemHttp(config, { request = nodeRequest, runCommand = runPasswordCommand } = {}) {
  const jar = cookieJar();
  let rejected = null; // the password the system refused, while it is the one configured
  let host = '';
  try {
    host = new URL(config.endpoint).host;
  } catch {
    host = '(no endpoint)';
  }

  /* The command's answer is kept until the system rejects it: a keychain
   * that asks the user should ask once, not on every roundtrip. */
  let fromCommand = null;
  const password = async () => {
    if (config.passwordSource !== 'command') return config.password;
    if (fromCommand === null) fromCommand = await runCommand(config.passwordCmd);
    return fromCommand;
  };

  /** Throws the refusal a request would meet - misconfigured, or the
   *  password the system already rejected - and sends nothing. */
  async function ready() {
    if (config.problems.length) throw new AgentError(`the system mode is misconfigured: ${config.problems.join('; ')}`);
    const pw = await password();
    if (rejected !== null && pw === rejected) {
      fromCommand = null; // the next call asks the command again - the user may have fixed the keychain meanwhile
      throw new AgentError(`${host} rejected the logon of ${config.user} once already — nothing more is sent with that password, `
        + 'because SAP locks a user after a few failed logons. Fix the credentials in the MCP client\'s configuration and restart the server '
        + `(in Claude Desktop: quit and reopen it)${config.passwordSource === 'command' ? `, or make ${SYSTEM_ENV.passwordCmd} print the right one` : ''}.`);
    }
    return pw;
  }

  async function send(url, { method = 'GET', headers = {}, body, signal } = {}) {
    const pw = await ready();
    const sent = { ...headers, authorization: `Basic ${Buffer.from(`${config.user}:${pw}`, 'utf8').toString('base64')}` };
    const cookie = jar.header();
    if (cookie) sent.cookie = cookie;
    let res;
    try {
      res = await request(url, { method, headers: sent, body, signal, insecureTls: config.insecureTls });
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new Error(networkProblem(e, host));
    }
    jar.keep(res.headers);
    if (res.status === 401) {
      rejected = pw;
      fromCommand = null; // asked again next time: the command may answer a corrected one
      return {
        ...res,
        body: `${host} rejected the logon of user ${config.user} (wrong user or password, or the user is locked). `
          + 'Nothing more is sent with this password, so the user is not locked by retries.',
      };
    }
    rejected = null;
    return res;
  }

  return { send, ready, host, jar };
}

/**
 * The protocol client's transport on the system: ONE request to the
 * endpoint as the client built it - the roundtrip POST, or the HEAD of the
 * CSRF token fetch - through `send` (logon, cookies, breaker).
 */
export function createSystemTransport({ endpoint, send }) {
  return async ({ method = 'POST', body, headers, signal }) => (method === 'HEAD'
    ? send(endpoint, { method: 'HEAD', headers, signal })
    : send(endpoint, { method: 'POST', headers, body, signal }));
}

/** The protocol client on the system: the same client the local backend
 *  gets, with this module's transport, location and hint. */
export function createSystemClient(config, sys, { metadata } = {}) {
  return createAppClient({
    transport: createSystemTransport({ endpoint: config.endpoint, send: sys.send }),
    location: (app) => systemLocation(config.endpoint, app),
    backendHint: SYSTEM_HINT,
    ...(metadata ? { metadata } : {}),
  });
}

// ---------------------------------------------------------------------------
// ADT: the class-name search
// ---------------------------------------------------------------------------

const attributeOf = (tag, name) => {
  const m = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(tag);
  if (!m) return undefined;
  return m[1].replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
};

/** The classes of an ADT quick-search answer (the extension's parser). */
export function parseAdtClassRefs(xml) {
  const refs = [];
  for (const tag of String(xml).matchAll(/<adtcore:objectReference\b[^>]*>/g)) {
    const type = attributeOf(tag[0], 'adtcore:type');
    const name = attributeOf(tag[0], 'adtcore:name');
    if (type !== 'CLAS/OC' || !name || refs.some((r) => r.name === name)) continue;
    const description = attributeOf(tag[0], 'adtcore:description');
    const packageName = attributeOf(tag[0], 'adtcore:packageName');
    refs.push({ name, ...(description ? { description } : {}), ...(packageName ? { packageName } : {}) });
  }
  return refs;
}

/** The ADT quick-search URL for a class-name pattern on the system. */
export function adtSearchUrl(endpoint, filter, maxResults = 50) {
  const url = new URL('/sap/bc/adt/repository/informationsystem/search', endpoint);
  const query = String(filter || 'Z').toUpperCase();
  url.searchParams.set('operation', 'quickSearch');
  url.searchParams.set('query', query.endsWith('*') ? query : `${query}*`);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('objectType', 'CLAS/OC');
  const client = sapClientOf(endpoint);
  if (client) url.searchParams.set('sap-client', client);
  return url.toString();
}

/** The classes whose name matches `filter` - a NAME search: whether a class
 *  implements z2ui5_if_app is not checked (app_start says so). */
export async function searchClasses(sys, endpoint, filter) {
  const res = await sys.send(adtSearchUrl(endpoint, filter), { method: 'GET', headers: { accept: 'application/xml' } });
  if (res.status === 401) throw new AgentError(res.body);
  if (res.status === 403) {
    throw new AgentError(`the ADT search answered 403 — ${sys.host} does not let this user search the repository (ADT, `
      + 'authorization S_ADT_RES / S_DEVELOP); app_start works without it if the class name is known');
  }
  if (res.status === 404) {
    throw new AgentError('the ADT search answered 404 — the ADT services (/sap/bc/adt) are not active on this system; '
      + 'app_start works without them if the class name is known');
  }
  if (res.status < 200 || res.status >= 300) throw new AgentError(`the ADT search answered HTTP ${res.status}`);
  return parseAdtClassRefs(res.body);
}

// ---------------------------------------------------------------------------
// system_status
// ---------------------------------------------------------------------------

/**
 * Whether the endpoint answers and the logon is accepted: ONE GET of the
 * endpoint (the abap2UI5 handler answers a GET with its start page), read
 * as a sentence. A rejected logon trips the breaker like any other request.
 */
export async function checkSystem(config, sys) {
  const shown = describeConfig(config);
  if (config.problems.length) return { ok: false, ...shown, problems: config.problems };
  let res;
  try {
    res = await sys.send(config.endpoint, { method: 'GET', headers: { accept: 'text/html' } });
  } catch (e) {
    return { ok: false, ...shown, problem: (e && e.message) || String(e) };
  }
  const verdict = res.status >= 200 && res.status < 300 ? { ok: true, verdict: `${sys.host} answered and accepted the logon of ${config.user}` }
    : res.status === 401 ? { ok: false, problem: res.body }
      : res.status === 403 ? { ok: false, problem: `HTTP 403 — the logon worked, but ${config.user} may not call this ICF service (authorization S_ICF), or a gateway refused the request` }
        : res.status === 404 ? { ok: false, problem: 'HTTP 404 — no service at this path: is the abap2UI5 ICF service (SICF) active, and is the path in the URL its path?' }
          : { ok: false, problem: `HTTP ${res.status}` };
  return { ...verdict, ...shown, status: res.status };
}
