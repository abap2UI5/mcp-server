/*
 * system-write - the WRITE half of the system mode: a global class from the
 * agent's abapGit files onto a real SAP system, over the ADT REST API.
 * EXPERIMENTAL, and off unless A2UI5_MCP_SYSTEM_WRITE=1 is set beside
 * A2UI5_MCP_SYSTEM_URL - without it the write tools are not even listed.
 *
 * NOT RUN AGAINST A REAL SYSTEM. Everything here is tested against
 * test/helpers/fake-system.mjs, a stand-in written from the same request
 * shapes - which proves the sequence, the refusals and the unlock, and
 * proves nothing about what a real ADT answers. Say so wherever this is
 * described, until somebody has run it on a system.
 *
 * The system mode (lib/system.mjs) could only OPERATE apps; an agent with a
 * gate-green class had no way to put it on the system, a human pulled with
 * abapGit. This module adds three steps, one tool each (lib/system-tools.mjs
 * SYSTEM_WRITE_TOOLS):
 *
 *   writeClass       create-or-update: the main source (`.clas.abap`), the
 *                    local test classes (`.clas.testclasses.abap`), the
 *                    description (from `.clas.xml`) - lock, write what
 *                    differs, unlock. Leaves the class INACTIVE.
 *   activateClass    activate, and the activation messages by file, line
 *                    and column.
 *   runClassUnitTests  the class's ABAP Unit tests through ADT.
 *
 * The request shapes are the ones the VS Code extension's Push and Activate
 * (vscode-extension src/adtwrite.ts, src/adtmessages.ts) checked against the
 * open-source ADT client abap-adt-api - read there, not run:
 *
 *   GET  /sap/bc/adt/oo/classes/<name>           metadata; `x-csrf-token:
 *        fetch` brings the token; 404 = the class does not exist. The root
 *        carries adtcore:changedBy / changedAt / version, an
 *        adtcore:packageRef and one class:include per include it has.
 *   GET  .../source/main, .../includes/testclasses   the server's source
 *   POST <class>?_action=LOCK&accessMode=MODIFY  -> LOCK_HANDLE, CORRNR,
 *        IS_LOCAL (asx:abap/asx:values/DATA); stateful session from here
 *   POST <class>/includes?lockHandle=            a missing test include
 *   PUT  .../source/main?lockHandle=[&corrNr=]   text/plain; charset=utf-8
 *   POST <class>?_action=UNLOCK&lockHandle=      in a `finally`
 *   GET  /sap/bc/adt/compatibility/graph         stateless: ends the session
 *   POST /sap/bc/adt/activation?method=activate&preauditRequested=true
 *        an adtcore:objectReferences body; the answer is chkl:messages/msg
 *        (type, href with #start=line,column, shortText/txt) and
 *        ioc:inactiveObjects.
 *
 * Two requests are NOT in the extension and were written from what
 * abap-adt-api does, from memory of that library rather than from a copy
 * checked line by line - the first things to verify on a system:
 *
 *   POST /sap/bc/adt/oo/classes[?corrNr=]        create: a class:abapClass
 *        body with adtcore:name, adtcore:description, adtcore:responsible
 *        and an adtcore:packageRef (its objectcreator.ts)
 *   POST /sap/bc/adt/abapunit/testruns           an aunit:runConfiguration
 *        body naming the class; the answer is aunit:runResult/program/
 *        testClasses/testClass/testMethods/testMethod with alerts (its
 *        unittest.ts)
 *
 * THE SAFETY RULES - each one pinned by test/system-write.test.mjs, none of
 * them to be weakened:
 *
 *   - OPT-IN. A2UI5_MCP_SYSTEM_WRITE=1, beside the system URL. A call
 *     without it is refused naming the variable, and nothing is sent.
 *   - WHICH NAMES. A customer name only: Z..., Y... or /NAMESPACE/...
 *     Refused whatever the allow pattern says: Z2UI5_* (the framework's own
 *     namespace - an agent must never overwrite the framework), anything in
 *     SAP's name range (a name that starts with neither Z, Y nor a
 *     namespace) and SAP's own namespaces (SAP_NAMESPACE). On top of that
 *     A2UI5_MCP_SYSTEM_WRITE_ALLOW, a regular expression (default
 *     `^Z|^Y|^/\w+/`), narrows it to a project's prefix.
 *   - PACKAGE AND TRANSPORT ARE THE CALLER'S. `package` is a required
 *     argument; `$TMP` needs no transport, every other package needs
 *     `transport`. A request is never chosen here and never created: when
 *     the lock says the object already sits in a request, the caller must
 *     have named that very one.
 *   - NOT OVER SOMEBODY ELSE'S WORK. An existing class whose last change
 *     is not the logged-on user's is refused unless `overwrite: true` -
 *     and so is one whose metadata does not say who changed it.
 *   - ALWAYS UNLOCKED. From the moment the lock is held the unlock is in a
 *     `finally`, sent with a signal of its own: a failed write, a dropped
 *     connection or a client's cancel still releases the object.
 *   - SAID EXACTLY. The answer names what was created, which parts were
 *     written and which were left as they were, the package and the request
 *     used, and that the class is still inactive.
 *
 * The logon, the TLS choice, the breaker and the network sentences are
 * lib/system.mjs's own (`sys.send`); what an ADT conversation adds is a
 * cookie jar of its own (a stateful ADT session's cookies must not ride on
 * the app tools' roundtrips), its CSRF token and the session type. Pure
 * where it can be: every function takes `sys`, so the tests inject requests.
 */
import { AgentError } from './appclient.mjs';
import { cookieJar, sapClientOf, systemConfig, SYSTEM_ENV } from './system.mjs';

export const WRITE_ENV = {
  on: 'A2UI5_MCP_SYSTEM_WRITE',
  allow: 'A2UI5_MCP_SYSTEM_WRITE_ALLOW',
};

/** The default allow pattern: the customer namespaces. */
export const DEFAULT_ALLOW = '^Z|^Y|^/\\w+/';
/** The framework's own classes: never written, whatever is allowed. */
const FRAMEWORK_NAME = /^Z2UI5_/;
/** A customer class name: Z/Y, or a namespaced one (/NS/CL_X). Upper case. */
const CUSTOMER_NAME = /^(?:[ZY][A-Z0-9_]*|\/[A-Z0-9_]{1,8}\/[A-Z0-9_]+)$/;
/* Namespaces SAP delivers objects in. A registered namespace looks the same
 * as a customer's, so this is a list of the ones known to be SAP's - not
 * complete, and no substitute for the allow pattern of a project. */
const SAP_NAMESPACE = /^\/(?:SAP[A-Z0-9_]*|[0-9][A-Z0-9_]*|BI0|BIC|BOBF|IWBEP|IWFND|UI5|UI2|AIF|DMO|SCWM|SCMB)\//;
const NAME_MAX = 30;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * The write half's configuration: `{ enabled, allow, allowSource, problems }`.
 * An allow pattern that is no regular expression is a problem every write
 * tool answers with - it never falls back to the default, which would write
 * names the user meant to exclude.
 *
 * Two transports the app tools put up with are problems here: the blanket
 * A2UI5_MCP_SYSTEM_INSECURE_TLS (any certificate - whoever answers gets the
 * logon AND the source, and can answer the lock and the activation) and
 * plain http off the loopback (the logon in clear text). A pinned
 * certificate (A2UI5_MCP_SYSTEM_CERT_SHA256) is the way to write to a
 * system without a CA the server trusts.
 */
export function writeConfig(env = process.env) {
  const enabled = truthy(env[WRITE_ENV.on]);
  const raw = String(env[WRITE_ENV.allow] ?? '').trim();
  const problems = [];
  const system = enabled ? systemConfig(env) : null;
  if (system && system.insecureTls) {
    problems.push(`${WRITE_ENV.on} refuses ${SYSTEM_ENV.insecureTls} - with any certificate accepted, whoever answers gets the logon `
      + `and the class; pin the system's certificate with ${SYSTEM_ENV.certSha256}=<its SHA-256 fingerprint> instead, `
      + `or point NODE_EXTRA_CA_CERTS at its CA`);
  }
  if (system && system.plainHttp) {
    problems.push(`${WRITE_ENV.on} refuses plain http: off the loopback - the logon would go over the network in clear text; `
      + `use the https: port of the system in ${SYSTEM_ENV.url}`);
  }
  let allow = new RegExp(DEFAULT_ALLOW, 'i');
  if (raw) {
    try {
      allow = new RegExp(raw, 'i');
    } catch (e) {
      allow = null;
      problems.push(`${WRITE_ENV.allow} '${raw.slice(0, 80)}' is not a regular expression (${String(e.message).slice(0, 120)})`);
    }
  }
  return { enabled, allow, allowSource: raw || DEFAULT_ALLOW, problems };
}

/** The write half as system_status shows it. */
export function describeWrite(write) {
  if (!write.enabled) return `off - the write tools are not listed (set ${WRITE_ENV.on}=1 to list them: experimental)`;
  return `ON (experimental, tested against a fake system only): classes matching /${write.allowSource}/i may be written, never Z2UI5_* or an SAP name`
    + (write.problems.length ? ` - MISCONFIGURED: ${write.problems.join('; ')}` : '');
}

/**
 * The class name a write may touch, upper case - or a throw saying why not.
 * The hard refusals first (they hold whatever the allow pattern says), then
 * the pattern.
 */
export function writableClassName(className, write) {
  const name = String(className ?? '').trim().toUpperCase();
  const shown = String(className ?? '').slice(0, 80);
  if (!name) throw new AgentError('class_name is missing - the global class to write, e.g. zcl_my_app');
  if (name.length > NAME_MAX) throw new AgentError(`'${shown}' is longer than ${NAME_MAX} characters - no class name is`);
  if (FRAMEWORK_NAME.test(name)) {
    throw new AgentError(`refused: '${shown}' is in Z2UI5_*, the namespace of the abap2UI5 framework itself - this server never writes there; `
      + 'name your class in your own namespace (zcl_..., ycl_... or /yourns/cl_...)');
  }
  if (!CUSTOMER_NAME.test(name)) {
    throw new AgentError(`refused: '${shown}' is no customer class name - a name that starts with neither Z nor Y nor a /NAMESPACE/ is SAP's, `
      + 'and this server never writes an SAP-owned object (letters, digits and underscores only)');
  }
  if (SAP_NAMESPACE.test(name)) {
    throw new AgentError(`refused: '${shown}' is in a namespace SAP delivers objects in - this server never writes an SAP-owned object`);
  }
  if (write.problems.length) throw new AgentError(`the write tools are misconfigured: ${write.problems.join('; ')}`);
  if (!write.allow.test(name)) {
    throw new AgentError(`refused: '${shown}' does not match the allowed names /${write.allowSource}/i (${WRITE_ENV.allow}) - `
      + 'only classes the configuration allows are written');
  }
  return name;
}

/** The refusal of a write tool while the opt-in is not set. */
export function writeDisabledMessage(tool) {
  return `${tool} writes to the SAP system and is switched off: set ${WRITE_ENV.on}=1 beside ${SYSTEM_ENV.url} in the MCP client's `
    + 'configuration and restart the server to list the write tools (experimental - tested against a fake system only, never against a real one). '
    + 'Nothing was sent.';
}

// ---------------------------------------------------------------------------
// The abapGit files
// ---------------------------------------------------------------------------

/** The parts of a class this module writes, as ADT names them. */
export const PARTS = ['main', 'testclasses'];
/** Every part an activation message can point into, with its abapGit file. */
export const PART_SUFFIX = {
  main: '.clas.abap',
  definitions: '.clas.locals_def.abap',
  implementations: '.clas.locals_imp.abap',
  macros: '.clas.macros.abap',
  testclasses: '.clas.testclasses.abap',
};

/** The abapGit file of a part: zcl_x.clas.abap, zcl_x.clas.testclasses.abap.
 *  A namespaced class is written the way abapGit names it: #ns#cl_x. */
export function partFile(className, part) {
  return `${String(className).toLowerCase().replace(/\//g, '#')}${PART_SUFFIX[part] || PART_SUFFIX.main}`;
}

/** The class a main source defines (`CLASS zcl_x DEFINITION`), upper case, or null. */
export function definedClass(source) {
  const m = /^\s*CLASS\s+([A-Za-z0-9_/]+)\s+DEFINITION\b/im.exec(String(source ?? '').replace(/^\uFEFF/, ''));
  return m ? m[1].toUpperCase() : null;
}

const decodeXml = (value) => String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e) => {
  if (e[0] === '#') {
    const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }[e.toLowerCase()];
});
const encodeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
};

/** What a `.clas.xml` (the abapGit sidecar) says: the class name and its
 *  description (VSEOCLASS CLSNAME / DESCRIPT). Missing fields are undefined. */
export function sidecarFacts(xml) {
  const text = String(xml ?? '');
  const field = (name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
    return m ? decodeXml(m[1]).trim() : undefined;
  };
  return { className: field('CLSNAME')?.toUpperCase(), description: field('DESCRIPT') };
}

/** Line endings and the final newline do not count as a difference -
 *  abapGit writes LF, the server may answer CRLF (the extension's rule). */
export function sameSource(a, b) {
  const norm = (s) => String(s).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// The ADT conversation
// ---------------------------------------------------------------------------

const CLASSES = '/sap/bc/adt/oo/classes';
const LOCK_ACCEPT = 'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result';
/** How long one ADT request may take - an activation compiles, a test run runs. */
const REQUEST_MS = 60 * 1000;
const LONG_REQUEST_MS = 5 * 60 * 1000;

/** The class's ADT path - lower case, encoded (/NS/CL_X -> %2Fns%2Fcl_x). */
export const classPath = (className) => `${CLASSES}/${encodeURIComponent(String(className).toLowerCase())}`;
/** Where a part's source is read and written. */
export const partPath = (className, part) => classPath(className) + (part === 'main' ? '/source/main' : `/includes/${part}`);

const ok = (res) => res.status >= 200 && res.status < 300;
const header = (res, name) => {
  const v = res.headers && res.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The text of an ADT error answer: exc:exception's localizedMessage or
 *  message, else the status. */
export function adtErrorText(res) {
  const body = String(res.body ?? '');
  const localized = /<localizedMessage\b[^>]*>([\s\S]*?)<\/localizedMessage>/.exec(body)?.[1];
  const message = /<message\b[^>]*>([\s\S]*?)<\/message>/.exec(body)?.[1];
  const text = (localized || message || '').trim();
  return text ? decodeXml(text).slice(0, 500) : `HTTP ${res.status}`;
}

/** The statuses that mean "ADT is not there for this user", as a sentence. */
function adtProblem(res, sys, what) {
  if (res.status === 401) return new AgentError(res.body);
  if (res.status === 403 && !/<exc:exception/.test(String(res.body ?? ''))) {
    return new AgentError(`${what} answered 403 - ${sys.host} does not let this user use the ADT services (authorizations S_ADT_RES / S_DEVELOP), `
      + 'or its CSRF token was refused');
  }
  return null;
}

/**
 * One ADT conversation on `sys`: the paths resolved against the endpoint
 * with its sap-client, a cookie jar of its own, the CSRF token fetched by
 * the first request and sent on every later one, the session type per
 * request. `signal` is the client's cancel; every request is also bounded.
 */
export function adtSession(config, sys, { signal } = {}) {
  const jar = cookieJar();
  const client = sapClientOf(config.endpoint);
  let token = 'fetch';
  const bounded = (ms, own) => {
    const timeout = AbortSignal.timeout(ms);
    return own && signal ? AbortSignal.any([signal, timeout]) : timeout;
  };
  /* `cancellable: false` is the unlock's: it must go out after a cancel too. */
  async function send(method, path, query = {}, { headers = {}, body, stateful = false, timeoutMs = REQUEST_MS, cancellable = true } = {}) {
    const url = new URL(path, config.endpoint);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    if (client) url.searchParams.set('sap-client', client);
    const res = await sys.send(url.toString(), {
      method,
      headers: {
        accept: '*/*',
        'cache-control': 'no-cache',
        'x-csrf-token': token,
        'x-sap-adt-sessiontype': stateful ? 'stateful' : 'stateless',
        ...headers,
      },
      body,
      signal: bounded(timeoutMs, cancellable),
      jar,
    });
    const answered = header(res, 'x-csrf-token');
    if (token === 'fetch' && answered && answered.toLowerCase() !== 'required') token = answered;
    return res;
  }
  return { send };
}

/** What the class metadata says: who changed it last and when, its package,
 *  whether it is active, which includes it has. */
export function parseClassMetadata(xml) {
  const text = String(xml ?? '');
  const root = /<class:abapClass\b[^>]*>/.exec(text)?.[0] ?? '';
  const pkg = /<adtcore:packageRef\b[^>]*>/.exec(text)?.[0] ?? '';
  return {
    changedBy: attr(root, 'adtcore:changedBy'),
    changedAt: attr(root, 'adtcore:changedAt'),
    version: attr(root, 'adtcore:version'),
    description: attr(root, 'adtcore:description'),
    package: attr(pkg, 'adtcore:name')?.toUpperCase(),
    includes: new Set([...text.matchAll(/class:includeType="([^"]+)"/g)].map((m) => m[1])),
  };
}

/** `asx:abap/asx:values/DATA` of a lock answer. */
export function parseLock(xml) {
  const field = (name) => decodeXml(new RegExp(`<${name}>([^<]*)</${name}>`).exec(String(xml ?? ''))?.[1] ?? '').trim();
  const lockHandle = field('LOCK_HANDLE');
  if (!lockHandle) return null;
  return { lockHandle, corrNr: field('CORRNR').toUpperCase(), isLocal: field('IS_LOCAL') === 'X' };
}

/** The create request's body (abap-adt-api objectcreator.ts, from memory -
 *  see the header: not verified against a system). */
export function createClassBody({ className, description, packageName, responsible }) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" '
    + `adtcore:description="${encodeXml(description)}" adtcore:name="${encodeXml(className)}" adtcore:type="CLAS/OC" `
    + `adtcore:responsible="${encodeXml(responsible)}">`
    + `<adtcore:packageRef adtcore:name="${encodeXml(packageName)}"/>`
    + '<class:include adtcore:name="CLAS/OC" adtcore:type="CLAS/OC" class:includeType="testclasses"/>'
    + '<class:superClassRef/>'
    + '</class:abapClass>';
}

/** The activation request's body. */
export function activationBody(className) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">'
    + `<adtcore:objectReference adtcore:uri="${classPath(className)}" adtcore:name="${encodeXml(String(className).toUpperCase())}"/>`
    + '</adtcore:objectReferences>';
}

/** The unit-test run's body (abap-adt-api unittest.ts, from memory - see
 *  the header: not verified against a system). Harmless, short tests and the
 *  medium ones: what a class's own local tests are; nothing dangerous. */
export function unitRunBody(className) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">'
    + '<external><coverage active="false"/></external>'
    + '<options>'
    + '<uriType value="semantic"/>'
    + '<testDeterminationStrategy sameProgram="true" assignedTests="false"/>'
    + '<testRiskLevels harmless="true" dangerous="false" critical="false"/>'
    + '<testDurations short="true" medium="true" long="false"/>'
    + '<withNavigationUri enabled="true"/>'
    + '</options>'
    + '<adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences>'
    + `<adtcore:objectReference adtcore:uri="${classPath(className)}"/>`
    + '</adtcore:objectReferences></objectSet></adtcore:objectSets>'
    + '</aunit:runConfiguration>';
}

// ---------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------

const severityOf = (type) => (/^[EAX]/i.test(type ?? '') ? 'error' : /^W/i.test(type ?? '') ? 'warning' : 'info');

/** The part of `className` an ADT href points into, or undefined. */
export function partOfHref(href, className) {
  const path = String(href).replace(/[?#].*$/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(path).toLowerCase();
  } catch {
    decoded = path.toLowerCase();
  }
  const prefix = `${CLASSES}/${String(className).toLowerCase()}`;
  if (!decoded.startsWith(prefix)) return undefined;
  const rest = decoded.slice(prefix.length);
  if (rest === '' || rest === '/' || rest === '/source/main' || rest === '/includes/main') return 'main';
  const include = /^\/includes\/([a-z]+)$/.exec(rest)?.[1];
  return include && PART_SUFFIX[include] ? include : undefined;
}

/** `#start=line,column` (or `#start=line`) out of an href. */
function startOf(href) {
  const m = /#(?:.*;)?start=(\d+)(?:,(\d+))?/.exec(String(href));
  return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : 0 } : null;
}

/**
 * The activation answer of `className`: `{ success, messages, inactive }`.
 * A message carries the abapGit `file` of the part it points into, `line`
 * (1-based) and `column` (0-based, as ADT's `#start=` counts), `severity`
 * and `text`; one without a position, or about another object, lands on
 * line 1 of the main source with the object named in its text. Failed when
 * any message is an error (type E, A or X) or anything stayed inactive - an
 * empty answer is a success (the extension's reading, after abap-adt-api).
 */
export function parseActivation(xml, className) {
  const text = String(xml ?? '');
  const messages = [];
  for (const m of text.matchAll(/<msg\b([^>]*?)(\/>|>([\s\S]*?)<\/msg>)/g)) {
    const tag = m[1];
    const txt = /<txt>([\s\S]*?)<\/txt>/.exec(m[3] ?? '')?.[1];
    let said = txt !== undefined ? decodeXml(txt).trim() : 'Syntax error';
    const href = attr(tag, 'href') ?? '';
    const part = href ? partOfHref(href, className) : undefined;
    const start = href ? startOf(href) : null;
    let line = 1;
    let column = 0;
    if (part) {
      const lineAttr = Number(attr(tag, 'line'));
      if (start && start.line > 0) {
        line = start.line;
        column = start.column;
      } else if (Number.isInteger(lineAttr) && lineAttr > 0) {
        line = lineAttr;
      }
    } else {
      const about = attr(tag, 'objDescr');
      if (about) said = `${about}: ${said}`;
    }
    messages.push({ file: partFile(className, part ?? 'main'), part: part ?? 'main', line, column, severity: severityOf(attr(tag, 'type')), text: said });
  }
  const inactive = [];
  const list = /<ioc:inactiveObjects\b[\s\S]*?<\/ioc:inactiveObjects>/.exec(text)?.[0] ?? '';
  for (const entry of list.matchAll(/<ioc:object\b[^>]*>[\s\S]*?<\/ioc:object>/g)) {
    const ref = /<ioc:ref\b[^>]*>/.exec(entry[0])?.[0];
    const name = ref ? attr(ref, 'adtcore:name') : undefined;
    if (name) inactive.push(name);
  }
  return { success: inactive.length === 0 && !messages.some((x) => x.severity === 'error'), messages, inactive };
}

/** The alerts directly inside `xml` (not those of an element nested in it). */
function alertsOf(xml, className) {
  const out = [];
  for (const a of String(xml).matchAll(/<alert\b([^>]*)>([\s\S]*?)<\/alert>/g)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(a[2])?.[1];
    const details = [...a[2].matchAll(/<detail\b[^>]*\stext="([^"]*)"/g)].map((d) => decodeXml(d[1])).filter(Boolean);
    const stack = [...a[2].matchAll(/<stackEntry\b[^>]*>/g)].map((s) => {
      const uri = attr(s[0], 'adtcore:uri') ?? '';
      const part = partOfHref(uri, className);
      const at = startOf(uri);
      return {
        ...(part ? { file: partFile(className, part) } : {}),
        ...(at ? { line: at.line } : {}),
        ...(attr(s[0], 'adtcore:description') ? { text: attr(s[0], 'adtcore:description') } : {}),
      };
    }).filter((s) => Object.keys(s).length);
    out.push({
      kind: attr(a[1], 'kind') ?? 'alert',
      severity: attr(a[1], 'severity') ?? '',
      title: title !== undefined ? decodeXml(title).trim() : '',
      ...(details.length ? { details: details.slice(0, 10) } : {}),
      ...(stack.length ? { stack: stack.slice(0, 5) } : {}),
    });
  }
  return out;
}

/** An alert that fails a run: everything but a tolerable (warning-level) one. */
const failing = (alert) => !/^tolerable$/i.test(alert.severity);

/**
 * The ABAP Unit answer of one class: `{ ok, ran, failed, tests, alerts }`.
 * `tests` is one entry per test method (`class`, `method`, `ok`, its
 * alerts); `alerts` are the ones raised outside a method (a class that
 * could not be set up, "no test classes found").
 */
export function parseUnitRun(xml, className) {
  const text = String(xml ?? '');
  const tests = [];
  const alerts = [];
  let outside = text;
  for (const c of text.matchAll(/<testClass\b([^>]*)>([\s\S]*?)<\/testClass>/g)) {
    outside = outside.replace(c[0], '');
    const cls = attr(c[1], 'adtcore:name') ?? '';
    let rest = c[2];
    for (const m of c[2].matchAll(/<testMethod\b([^>]*?)(\/>|>([\s\S]*?)<\/testMethod>)/g)) {
      rest = rest.replace(m[0], '');
      const found = alertsOf(m[3] ?? '', className);
      const time = Number(attr(m[1], 'executionTime'));
      tests.push({
        class: cls,
        method: attr(m[1], 'adtcore:name') ?? '',
        ok: !found.some(failing),
        ...(Number.isFinite(time) ? { seconds: time } : {}),
        ...(found.length ? { alerts: found } : {}),
      });
    }
    for (const a of alertsOf(rest, className)) alerts.push({ class: cls, ...a });
  }
  for (const a of alertsOf(outside, className)) alerts.push(a);
  const failed = tests.filter((t) => !t.ok).length;
  return { ok: failed === 0 && !alerts.some(failing), ran: tests.length, failed, tests, ...(alerts.length ? { alerts } : {}) };
}

// ---------------------------------------------------------------------------
// The three steps
// ---------------------------------------------------------------------------

/** A step's refusal or failure: `{ ok: false, refused | failed, ... }`. */
const refused = (reason, more = {}) => ({ ok: false, refused: reason, ...more });
const failed = (reason, more = {}) => ({ ok: false, failed: reason, ...more });

/**
 * Create or update one global class. `input`: `{ className, source,
 * testclasses?, xml?, description?, packageName, transport?, overwrite? }`.
 * Answers `{ ok, class, created, written, unchanged, package, transport?,
 * active: false, ... }`, or `{ ok: false, refused | failed, ... }` with what
 * had been written until then. Nothing is activated.
 */
export async function writeClass(input, { config, sys, write, signal, log = () => {} }) {
  // ---- everything that can be refused before a request is sent
  const className = writableClassName(input.className, write);
  const source = String(input.source ?? '');
  if (!source.trim()) return refused('`source` is empty - pass the content of the class\'s .clas.abap file');
  const defined = definedClass(source);
  if (defined !== className) {
    return refused(defined
      ? `\`source\` defines the class ${defined}, not ${className} - class_name and the .clas.abap must name the same class`
      : `\`source\` has no "CLASS ${className.toLowerCase()} DEFINITION" - pass the content of the class's .clas.abap file`);
  }
  const sidecar = input.xml ? sidecarFacts(input.xml) : {};
  if (sidecar.className && sidecar.className !== className) {
    return refused(`the .clas.xml names the class ${sidecar.className} (CLSNAME), not ${className}`);
  }
  const description = String(input.description ?? sidecar.description ?? '').trim().slice(0, 60);
  const packageName = String(input.packageName ?? '').trim().toUpperCase();
  if (!packageName) return refused('`package` is missing - the package the class belongs to, named explicitly ($TMP for a local object)');
  if (!/^(?:\$[A-Z0-9_]*|[A-Z][A-Z0-9_]*|\/[A-Z0-9_]{1,8}\/[A-Z0-9_]+)$/.test(packageName) || packageName.length > NAME_MAX) {
    return refused(`'${packageName.slice(0, 80)}' is no package name`);
  }
  const transport = String(input.transport ?? '').trim().toUpperCase();
  if (transport && !/^[A-Z0-9]{3}K[A-Z0-9]{6}$/.test(transport)) {
    return refused(`'${transport.slice(0, 40)}' is no transport request number (like A4HK900123)`);
  }
  const local = packageName.startsWith('$');
  if (!local && !transport) {
    return refused(`the package ${packageName} is transportable, so \`transport\` is required - name the request the user wants this in; `
      + 'this server never picks a transport request and never creates one (only $TMP needs none)');
  }
  const parts = { main: source, ...(typeof input.testclasses === 'string' && input.testclasses.trim() ? { testclasses: input.testclasses } : {}) };
  const user = String(config.user || '').toUpperCase();

  await sys.ready();
  const adt = adtSession(config, sys, { signal });
  const base = {
    class: className,
    package: packageName,
    ...(local ? {} : { transport }),
    ...(local && transport ? { transportNotUsed: `${packageName} is a local package - the request ${transport} was not used` } : {}),
  };

  // ---- does it exist? (the answer brings the CSRF token)
  const meta = await adt.send('GET', classPath(className));
  const noAdt = adtProblem(meta, sys, 'reading the class');
  if (noAdt) throw noAdt;
  let created = false;
  let includes = new Set(['testclasses']);
  if (meta.status === 404) {
    if (!description) {
      return refused(`${className} does not exist on ${sys.host} and has no description - a new class needs one: pass \`xml\` `
        + '(the .clas.xml, its DESCRIPT is used) or `description`', base);
    }
    const res = await adt.send('POST', CLASSES, local ? {} : { corrNr: transport }, {
      headers: { 'content-type': 'application/*' },
      body: createClassBody({ className, description, packageName, responsible: user }),
    });
    if (!ok(res)) return failed(`creating ${className} in ${packageName} failed - ${adtErrorText(res)}. Nothing was written.`, base);
    created = true;
    log(`${className} created in ${packageName}`);
  } else if (!ok(meta)) {
    return failed(`reading ${className} failed - ${adtErrorText(meta)}. Nothing was written.`, base);
  } else {
    const facts = parseClassMetadata(meta.body);
    includes = facts.includes;
    if (facts.package && facts.package !== packageName) {
      return refused(`${className} exists on ${sys.host} in the package ${facts.package}, not in ${packageName} - `
        + 'pass the package it is in; this server does not move a class. Nothing was written.', { ...base, existingPackage: facts.package });
    }
    const changedBy = String(facts.changedBy ?? '').toUpperCase();
    if (changedBy !== user && input.overwrite !== true) {
      return refused(changedBy
        ? `${className} exists on ${sys.host} and was last changed by ${changedBy}${facts.changedAt ? ` (${facts.changedAt})` : ''}, not by ${user} - `
          + 'writing it would overwrite somebody else\'s work. Ask the user; pass `overwrite: true` only when they said so. Nothing was written.'
        : `${className} exists on ${sys.host} and its metadata does not say who changed it last - pass \`overwrite: true\` only when the user said so. Nothing was written.`,
      { ...base, ...(changedBy ? { changedBy } : {}), ...(facts.changedAt ? { changedAt: facts.changedAt } : {}) });
    }
  }

  // ---- what differs from the server (a new class: everything)
  const toWrite = [];
  const unchanged = [];
  let createTestInclude = false;
  for (const part of PARTS) {
    if (parts[part] === undefined) continue;
    if (created) {
      toWrite.push(part);
      continue;
    }
    const res = await adt.send('GET', partPath(className, part), {}, { headers: { accept: 'text/plain' } });
    if (res.status === 404 && part === 'testclasses') {
      createTestInclude = true;
      toWrite.push(part);
    } else if (!ok(res)) {
      return failed(`reading ${className} (${partFile(className, part)}) failed - ${adtErrorText(res)}. Nothing was written.`, base);
    } else if (sameSource(res.body, parts[part])) {
      unchanged.push(part);
    } else {
      toWrite.push(part);
    }
  }
  if (parts.testclasses !== undefined && !created && includes.size > 0 && !includes.has('testclasses')) createTestInclude = true;
  const files = (list) => list.map((p) => partFile(className, p));
  if (!toWrite.length) {
    return { ok: true, ...base, created: false, written: [], unchanged: files(unchanged), note: `${className} on ${sys.host} already has this source - nothing was written, nothing was locked` };
  }

  // ---- lock, write, unlock
  const lockRes = await adt.send('POST', classPath(className), { _action: 'LOCK', accessMode: 'MODIFY' }, { headers: { accept: LOCK_ACCEPT }, stateful: true });
  if (!ok(lockRes)) {
    return refused(`${className} could not be locked - ${adtErrorText(lockRes)}. ${created ? 'The class was created, empty; nothing else' : 'Nothing'} was written.`, { ...base, created });
  }
  const lock = parseLock(lockRes.body);
  if (!lock) {
    return failed(`the lock answer for ${className} carried no lock handle - ${created ? 'the class was created, empty; nothing else' : 'nothing'} was written.`, { ...base, created });
  }
  log(`${className} locked`);
  const written = [];
  let unlocked = false;
  let outcome;
  try {
    outcome = await (async () => {
      /* The request is the caller's: the one the object already sits in must
       * be the one named, and an object that is not local needs one named. */
      if (lock.corrNr && lock.corrNr !== transport) {
        return refused(`${className} is already in the transport request ${lock.corrNr}${transport ? `, not in ${transport}` : ''} - `
          + `pass \`transport: "${lock.corrNr}"\` when the user wants the change there; this server never picks a request by itself.`, { inRequest: lock.corrNr });
      }
      if (!lock.isLocal && !lock.corrNr && !transport) {
        return refused(`${className} is not a local object and is in no transport request yet - \`transport\` is required; this server never picks or creates one.`);
      }
      const corrNr = lock.isLocal ? undefined : transport || undefined;
      if (createTestInclude) {
        const res = await adt.send('POST', `${classPath(className)}/includes`, { lockHandle: lock.lockHandle, corrNr }, {
          headers: { 'content-type': 'application/*' },
          stateful: true,
          body: '<?xml version="1.0" encoding="UTF-8"?><class:abapClassInclude xmlns:class="http://www.sap.com/adt/oo/classes" '
            + 'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="dummy" class:includeType="testclasses"/>',
        });
        if (!ok(res)) return failed(`creating the test include of ${className} failed - ${adtErrorText(res)}`);
      }
      for (const part of toWrite) {
        const res = await adt.send('PUT', partPath(className, part), { lockHandle: lock.lockHandle, corrNr }, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          stateful: true,
          body: parts[part],
        });
        if (!ok(res)) return failed(`writing ${partFile(className, part)} failed - ${adtErrorText(res)}`);
        written.push(part);
        log(`${className} ${part} written`);
      }
      return { ok: true, ...(corrNr ? { usedTransport: corrNr } : {}) };
    })().catch((e) => failed(`the write of ${className} was interrupted - ${(e && e.message) || e}`));
  } finally {
    /* Whatever happened above - a refusal, a failed write, a throw, the
     * client's cancel: the lock is given back, with a signal of its own. */
    try {
      const res = await adt.send('POST', classPath(className), { _action: 'UNLOCK', lockHandle: lock.lockHandle }, { stateful: true, cancellable: false });
      unlocked = ok(res);
      log(unlocked ? `${className} unlocked` : `unlocking ${className} answered ${res.status}`);
    } catch (e) {
      log(`unlocking ${className} failed - ${(e && e.message) || e}`);
    }
    try {
      // ends the stateful session; the server ends an idle one by itself
      await adt.send('GET', '/sap/bc/adt/compatibility/graph', {}, { cancellable: false });
    } catch {
      // best effort
    }
  }
  const lockNote = unlocked ? {} : { lockNotReleased: `the unlock of ${className} was not confirmed - the lock ends with the ADT session; check SM12 if the class stays locked` };
  const { usedTransport, ...verdict } = outcome;
  const state = {
    ...base,
    ...(local || lock.isLocal ? {} : { transport: usedTransport || transport }),
    created,
    written: files(written),
    unchanged: files(unchanged),
    unlocked,
    ...lockNote,
  };
  if (!verdict.ok) {
    const what = written.length ? `${files(written).join(', ')} had been written before that and is on the system, inactive` : (created ? 'the class was created, empty; no source was written' : 'nothing was written');
    const key = verdict.refused ? 'refused' : 'failed';
    return { ...verdict, [key]: `${verdict[key]} - ${what}.`, ...state };
  }
  return {
    ok: true,
    ...state,
    active: false,
    next: `${className} is written and INACTIVE on ${sys.host} - system_activate { class_name: "${className.toLowerCase()}" } activates it and answers the activation messages`,
  };
}

/**
 * Activate one class: `{ ok, class, activated, messages, inactive }`. The
 * messages carry file, line and column; a class that does not exist is
 * refused before the activation is asked for.
 */
export async function activateClass(input, { config, sys, write, signal }) {
  const className = writableClassName(input.className, write);
  await sys.ready();
  const adt = adtSession(config, sys, { signal });
  const meta = await adt.send('GET', classPath(className));
  const noAdt = adtProblem(meta, sys, 'reading the class');
  if (noAdt) throw noAdt;
  if (meta.status === 404) return refused(`${className} does not exist on ${sys.host} - system_write_class writes it first`, { class: className });
  if (!ok(meta)) return failed(`reading ${className} failed - ${adtErrorText(meta)}`, { class: className });
  const res = await adt.send('POST', '/sap/bc/adt/activation', { method: 'activate', preauditRequested: 'true' }, {
    headers: { 'content-type': 'application/xml' },
    body: activationBody(className),
    timeoutMs: LONG_REQUEST_MS,
  });
  if (!ok(res)) return failed(`activating ${className} failed - ${adtErrorText(res)}`, { class: className });
  const result = parseActivation(res.body, className);
  const errors = result.messages.filter((m) => m.severity === 'error').length;
  return {
    ok: result.success,
    class: className,
    activated: result.success,
    ...(result.success ? {} : { errors }),
    messages: result.messages,
    ...(result.inactive.length ? { inactive: result.inactive } : {}),
    ...(result.success
      ? { note: `${className} is active on ${sys.host}` }
      : { note: `${className} was NOT activated and stays inactive on ${sys.host} - fix the errors in the files they name (line 1-based, column 0-based), write again, activate again` }),
  };
}

/** Run the ABAP Unit tests of one class through ADT. */
export async function runClassUnitTests(input, { config, sys, write, signal }) {
  const className = writableClassName(input.className, write);
  await sys.ready();
  const adt = adtSession(config, sys, { signal });
  const meta = await adt.send('GET', classPath(className));
  const noAdt = adtProblem(meta, sys, 'reading the class');
  if (noAdt) throw noAdt;
  if (meta.status === 404) return refused(`${className} does not exist on ${sys.host}`, { class: className });
  if (!ok(meta)) return failed(`reading ${className} failed - ${adtErrorText(meta)}`, { class: className });
  const res = await adt.send('POST', '/sap/bc/adt/abapunit/testruns', {}, {
    headers: { 'content-type': 'application/*', accept: 'application/*' },
    body: unitRunBody(className),
    timeoutMs: LONG_REQUEST_MS,
  });
  if (!ok(res)) return failed(`the ABAP Unit run of ${className} failed - ${adtErrorText(res)}`, { class: className });
  const result = parseUnitRun(res.body, className);
  const inactive = parseClassMetadata(meta.body).version === 'inactive';
  return {
    class: className,
    ...result,
    ...(result.ran === 0 ? { note: `no test method ran - ${className} has no local test classes on ${sys.host} (system_write_class with \`testclasses\`), or they are not active` } : {}),
    ...(inactive ? { inactiveVersion: `${className} has an inactive version on ${sys.host} - the tests ran against the ACTIVE one; system_activate first` } : {}),
  };
}
