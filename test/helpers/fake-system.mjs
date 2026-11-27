// A fake SAP system for the system mode's tests (test/system.test.mjs): an
// http server on 127.0.0.1 that behaves like the parts of an ABAP system the
// system mode talks to - Basic authentication with a 401 for a wrong one, a
// session cookie handed out on the first accepted logon, a CSRF token layer
// in front of the abap2UI5 endpoint (403 + X-CSRF-Token: Required, the token
// fetched by HEAD and bound to the session cookie), the ADT quick search,
// and the abap2UI5 handler itself, which REPLAYS a recorded sample session of
// test/fixtures/agent and fails on any request that differs from it. Not a
// test file itself (npm test runs test/*.test.mjs only).
//
// And, for the write half (lib/system-write.mjs, test/system-write.test.mjs),
// the ADT endpoints it uses - `adtHandler` below: the class metadata, the
// sources, create, LOCK / UNLOCK, the source PUT, the test include, the
// activation and the ABAP Unit run, over a small in-memory repository. It is
// a STAND-IN written from the same request shapes the client was written
// from (the VS Code extension's fixtures after abap-adt-api), not a recording
// of a system: it proves the client's sequence, refusals and unlock, and
// nothing about what a real ADT answers.
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fixture } from './agent-replay.mjs';

export const USER = 'DEVELOPER';
export const PASSWORD = 'pass word:1';
export const SAP_CLIENT = '001';
const SESSION = 'SAP_SESSIONID_A4H_001';
const TOKEN = 'TOKEN-42';

const ADT_TOKEN = 'ADT-TOKEN-7';
const xmlEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const exception = (type, message) => '<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">'
  + `<namespace id="com.sap.adt"/><type id="${type}"/><message lang="EN">${xmlEsc(message)}</message>`
  + `<localizedMessage lang="EN">${xmlEsc(message)}</localizedMessage><properties/></exc:exception>`;

/**
 * The ADT side of the fake system. `options`:
 *   classes  { NAME: { package, changedBy, changedAt?, description?, main, testclasses?, lockedBy?, corrNr? } }
 *            the repository at the start (names upper case; `lockedBy`
 *            another user holds the lock; `corrNr` the request it sits in)
 *   failPut  a part ("main" / "testclasses") whose source PUT answers 500
 * A main source containing the word SYNTAX_ERROR does not activate (an error
 * message at that line, and the class stays inactive); a test method whose
 * name contains "fail" fails its run. Returns `{ handle, classes, locks }` -
 * the live state, for the assertions.
 */
function adtHandler(options = {}) {
  const classes = new Map(Object.entries(options.classes || {}).map(([name, c]) => [name.toUpperCase(), {
    package: '$TMP', changedBy: USER, changedAt: '2026-11-10T09:00:00Z', description: '', main: '', active: true, ...c,
  }]));
  const locks = new Map(); // class name -> lock handle
  let handles = 0;
  const nameOf = (segment) => decodeURIComponent(segment).toUpperCase();

  function handle(req, res, { url, body, headers, cookieOk }) {
    const send = (status, text = '', type = 'application/xml', extra = {}) => {
      res.writeHead(status, { ...headers, 'content-type': type, ...extra });
      res.end(text);
    };
    const rest = url.pathname.slice('/sap/bc/adt/'.length);
    const fetched = String(req.headers['x-csrf-token'] || '').toLowerCase() === 'fetch' ? { 'x-csrf-token': ADT_TOKEN } : {};
    if (req.method !== 'GET' && (req.headers['x-csrf-token'] !== ADT_TOKEN || !cookieOk)) {
      send(403, 'CSRF token validation failed', 'text/plain', { 'x-csrf-token': 'Required' });
      return;
    }
    const stateful = req.headers['x-sap-adt-sessiontype'] === 'stateful';
    if (rest === 'compatibility/graph') {
      send(200, '<graph/>', 'application/xml', fetched);
      return;
    }
    if (rest === 'activation' && req.method === 'POST') {
      const name = /adtcore:name="([^"]+)"/.exec(body)?.[1];
      const cls = classes.get(name);
      if (!cls) {
        send(404, exception('ExceptionResourceNotFound', `${name} does not exist`));
        return;
      }
      const lines = cls.main.split('\n');
      const at = lines.findIndex((l) => l.includes('SYNTAX_ERROR'));
      if (at >= 0) {
        const uri = `/sap/bc/adt/oo/classes/${encodeURIComponent(name.toLowerCase())}`;
        send(200, '<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">'
          + `<msg objDescr="Class ${name}" type="E" line="1" href="${uri}/source/main#start=${at + 1},${lines[at].indexOf('SYNTAX_ERROR')}" forceSupported="true">`
          + '<shortText><txt>Field &quot;SYNTAX_ERROR&quot; is unknown.</txt></shortText></msg>'
          + (cls.testclasses ? `<msg objDescr="Class ${name}, test classes" type="W" line="1" href="${uri}/includes/testclasses#start=2,4" forceSupported="true"><shortText><txt>A warning in the tests.</txt></shortText></msg>` : '')
          + '</chkl:messages>'
          + '<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects"><ioc:entry><ioc:object ioc:user="DEVELOPER" ioc:deleted="false">'
          + `<ioc:ref xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${uri}" adtcore:type="CLAS/OC" adtcore:name="${name}"/>`
          + '</ioc:object></ioc:entry></ioc:inactiveObjects>');
        return;
      }
      cls.active = true;
      send(200, '<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"/>');
      return;
    }
    if (rest === 'abapunit/testruns' && req.method === 'POST') {
      const segment = /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/([^"]+)"/.exec(body)?.[1];
      const name = segment ? nameOf(segment) : '';
      const cls = classes.get(name);
      const uri = `/sap/bc/adt/oo/classes/${segment}`;
      let out = '<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit">';
      const source = (cls && cls.testclasses) || '';
      const testClasses = [...source.matchAll(/^\s*CLASS\s+(\w+)\s+DEFINITION\b[^.]*FOR\s+TESTING/gim)].map((m) => m[1].toUpperCase());
      if (testClasses.length) {
        const methods = [...source.matchAll(/^\s*(?:METHODS\s+)?(\w+)\s+FOR\s+TESTING\b/gim)].map((m) => m[1].toUpperCase()).filter((m) => !testClasses.includes(m));
        out += `<program xmlns:adtcore="http://www.sap.com/adt/core" adtcore:uri="${uri}" adtcore:type="CLAS/OC" adtcore:name="${name}" uriType="semantic"><testClasses>`
          + `<testClass adtcore:uri="${uri}/includes/testclasses#testclass=${testClasses[0]}" adtcore:name="${testClasses[0]}" uriType="semantic" durationCategory="short" riskLevel="harmless"><testMethods>`;
        methods.forEach((m, i) => {
          out += `<testMethod adtcore:uri="${uri}/includes/testclasses#testclass=${testClasses[0]};testmethod=${m}" adtcore:name="${m}" executionTime="0.01" uriType="semantic" unit="s">`;
          if (m.includes('FAIL')) {
            out += '<alerts><alert kind="failedAssertion" severity="critical"><title>Critical Assertion Error: &apos;count&apos;</title>'
              + '<details><detail text="Expected [1] Actual [2]"><details><detail text="Test &apos;' + m + '&apos; in Main Program"/></details></detail></details>'
              + `<stack><stackEntry adtcore:uri="${uri}/includes/testclasses#start=${10 + i},0" adtcore:type="CLAS/OCN/testclasses" adtcore:name="${name}" adtcore:description="Include: &lt;${name}====CCAU&gt; Line: &lt;${10 + i}&gt; (${m})"/></stack>`
              + '</alert></alerts>';
          }
          out += '</testMethod>';
        });
        out += '</testMethods></testClass></testClasses></program>';
      }
      send(200, `${out}</aunit:runResult>`);
      return;
    }
    if (rest === 'oo/classes' && req.method === 'POST') {
      const name = /adtcore:name="([^"]+)"/.exec(body)?.[1];
      const pkg = /<adtcore:packageRef adtcore:name="([^"]+)"/.exec(body)?.[1];
      const corrNr = url.searchParams.get('corrNr') || '';
      if (classes.has(name)) {
        send(400, exception('ExceptionResourceAlreadyExists', `Resource ${name} does already exist`));
        return;
      }
      if (!pkg.startsWith('$') && !corrNr) {
        send(400, exception('ExceptionResourceInvalidRequest', 'A transport request is required for this object (parameter corrNr)'));
        return;
      }
      classes.set(name, {
        package: pkg, changedBy: USER, changedAt: '2026-11-27T10:00:00Z', description: /adtcore:description="([^"]*)"/.exec(body)?.[1] ?? '',
        responsible: /adtcore:responsible="([^"]*)"/.exec(body)?.[1], main: '', testclasses: '', active: false, corrNr, created: true,
      });
      send(201, '', 'application/xml', { location: `/sap/bc/adt/oo/classes/${encodeURIComponent(name.toLowerCase())}` });
      return;
    }
    const m = /^oo\/classes\/([^/]+)(?:\/(source\/main|includes(?:\/(\w+))?))?$/.exec(rest);
    if (!m) {
      send(404, exception('ExceptionResourceNotFound', `no ADT resource ${url.pathname}`));
      return;
    }
    const name = nameOf(m[1]);
    const cls = classes.get(name);
    if (!cls) {
      send(404, exception('ExceptionResourceNotFound', `Class ${name} does not exist`), 'application/xml', fetched);
      return;
    }
    const local = cls.package.startsWith('$');
    const part = m[2] === 'source/main' ? 'main' : m[3];
    if (!m[2]) {
      const action = url.searchParams.get('_action');
      if (req.method === 'GET') {
        const include = (type, uri) => `<class:include class:includeType="${type}" abapsource:sourceUri="${uri}" adtcore:name="${name}" adtcore:type="CLAS/I"/>`;
        send(200, '<?xml version="1.0" encoding="utf-8"?><class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" '
          + `xmlns:abapsource="http://www.sap.com/adt/abapsource" adtcore:name="${name}" adtcore:type="CLAS/OC" adtcore:version="${cls.active ? 'active' : 'inactive'}" `
          + `adtcore:changedAt="${cls.changedAt}"${cls.changedBy ? ` adtcore:changedBy="${cls.changedBy}"` : ''} adtcore:description="${xmlEsc(cls.description)}">`
          + `<adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/${encodeURIComponent(cls.package.toLowerCase())}" adtcore:type="DEVC/K" adtcore:name="${cls.package}"/>`
          + include('definitions', 'includes/definitions') + include('implementations', 'includes/implementations')
          + (cls.testclasses !== undefined ? include('testclasses', 'includes/testclasses') : '')
          + include('main', 'source/main')
          + '</class:abapClass>', 'application/xml', fetched);
        return;
      }
      if (action === 'LOCK') {
        if (!stateful) {
          send(400, exception('ExceptionResourceInvalidRequest', 'A lock needs a stateful session'));
          return;
        }
        if (cls.lockedBy && cls.lockedBy !== USER) {
          send(403, exception('ExceptionResourceNoAccess', `User ${cls.lockedBy} is currently editing ${name}`));
          return;
        }
        const lockHandle = `LOCK${++handles}`;
        locks.set(name, lockHandle);
        send(200, '<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>'
          + `<LOCK_HANDLE>${lockHandle}</LOCK_HANDLE><CORRNR>${cls.corrNr || ''}</CORRNR><CORRUSER/><CORRTEXT/>`
          + `<IS_LOCAL>${local ? 'X' : ''}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT>NoModification</MODIFICATION_SUPPORT></DATA></asx:values></asx:abap>`);
        return;
      }
      if (action === 'UNLOCK') {
        if (locks.get(name) === url.searchParams.get('lockHandle')) locks.delete(name);
        send(200);
        return;
      }
      send(400, exception('ExceptionResourceInvalidRequest', 'unknown action'));
      return;
    }
    const locked = () => stateful && locks.has(name) && locks.get(name) === url.searchParams.get('lockHandle');
    if (m[2] === 'includes' && req.method === 'POST') {
      if (!locked()) {
        send(423, exception('ExceptionResourceLockedByAnotherUser', `${name} is not locked with this handle`));
        return;
      }
      cls.testclasses = '';
      send(201);
      return;
    }
    if (req.method === 'GET') {
      if (cls[part] === undefined) {
        send(404, exception('ExceptionResourceNotFound', `${name} has no include ${part}`));
        return;
      }
      send(200, cls[part], 'text/plain');
      return;
    }
    if (req.method === 'PUT') {
      if (!locked()) {
        send(423, exception('ExceptionResourceLockedByAnotherUser', `${name} is not locked with this handle`));
        return;
      }
      if (!local && !url.searchParams.get('corrNr')) {
        send(400, exception('ExceptionResourceInvalidRequest', 'A transport request is required for this object (parameter corrNr)'));
        return;
      }
      if (options.failPut === part) {
        send(500, exception('ExceptionResourceSaveFailure', `The ${part} include of ${name} could not be saved`));
        return;
      }
      cls[part] = body;
      cls.changedBy = USER;
      cls.changedAt = '2026-11-27T10:00:01Z';
      cls.active = false;
      if (!local) cls.corrNr = url.searchParams.get('corrNr');
      send(200);
      return;
    }
    send(405);
  }
  return { handle, classes, locks };
}

export async function fakeSystem({ sample = 'form-381', adt: adtOptions } = {}) {
  const adt = adtHandler(adtOptions);
  const exchanges = fixture(sample).steps.filter((s) => s.exchange).map((s) => s.exchange);
  const log = [];
  const problems = [];
  let posted = 0;
  let sessions = 0;
  let origin = '';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const url = new URL(req.url, origin);
      const auth = req.headers.authorization || '';
      const cookie = req.headers.cookie || '';
      log.push({ method: req.method, path: url.pathname, search: url.search, auth, cookie, csrf: req.headers['x-csrf-token'], session: req.headers['x-sap-adt-sessiontype'] });
      const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
      if (auth !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="SAP NetWeaver Application Server [A4H/001]"', 'content-type': 'text/html' });
        res.end('<html><body>Logon failed</body></html>');
        return;
      }
      const headers = {};
      if (!cookie.includes(`${SESSION}=`)) {
        sessions++;
        headers['set-cookie'] = [`${SESSION}=s${sessions}; path=/; HttpOnly`, 'sap-usercontext=sap-client=001; path=/'];
      }
      if (url.pathname === '/sap/bc/adt/repository/informationsystem/search') {
        const q = url.searchParams.get('query');
        res.writeHead(200, { ...headers, 'content-type': 'application/xml' });
        res.end('<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">'
          + `<adtcore:objectReference adtcore:uri="/x" adtcore:type="CLAS/OC" adtcore:name="Z2UI5_CL_SMP_APP_381" adtcore:packageName="Z2UI5_SAMPLES" adtcore:description="Form &amp; toast (${q})"/>`
          + '<adtcore:objectReference adtcore:uri="/y" adtcore:type="INTF/OI" adtcore:name="Z2UI5_IF_APP" adtcore:packageName="Z2UI5"/>'
          + '<adtcore:objectReference adtcore:uri="/z" adtcore:type="CLAS/OC" adtcore:name="ZCL_OTHER"/>'
          + '</adtcore:objectReferences>');
        return;
      }
      if (url.pathname.startsWith('/sap/bc/adt/')) {
        // a request that brings no session cookie gets one - and counts as inside that session
        adt.handle(req, res, { url, body, headers, cookieOk: cookie.includes(`${SESSION}=`) });
        return;
      }
      if (url.pathname !== '/sap/bc/z2ui5') {
        res.writeHead(404, headers);
        res.end('not found');
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        // the shell z2ui5_cl_ui5_http_handler=>_http_get answers, abbreviated
        res.end('<html><head><title>abap2UI5</title></head><body>'
          + '<div data-sap-ui-component data-name="z2ui5" data-id="container"></div></body></html>');
        return;
      }
      if (req.method === 'HEAD') {
        // the token is handed out only within a session, as on a real system
        const t = req.headers['x-csrf-token'] === 'Fetch' && cookie.includes(`${SESSION}=`) ? TOKEN : '';
        res.writeHead(200, { ...headers, ...(t ? { 'x-csrf-token': t } : {}) });
        res.end();
        return;
      }
      if (req.headers['x-csrf-token'] !== TOKEN || !cookie.includes(`${SESSION}=`)) {
        res.writeHead(403, { ...headers, 'x-csrf-token': 'Required', 'content-type': 'text/plain' });
        res.end('CSRF token validation failed');
        return;
      }
      const sent = JSON.parse(body).value;
      const next = exchanges[posted++];
      if (!next) {
        problems.push(`request ${posted} was not in the recording`);
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('not recorded');
        return;
      }
      let want = next.request;
      if (want.S_FRONT && want.S_FRONT.ORIGIN !== undefined) {
        // the start: the location is the SYSTEM's launch URL, not the recording's local backend
        const { ORIGIN, PATHNAME, SEARCH, ...rest } = sent.S_FRONT;
        if (ORIGIN !== origin) problems.push(`ORIGIN ${ORIGIN}, expected ${origin}`);
        if (PATHNAME !== '/sap/bc/z2ui5') problems.push(`PATHNAME ${PATHNAME}`);
        const search = new URLSearchParams(SEARCH);
        if (search.get('sap-client') !== SAP_CLIENT) problems.push(`SEARCH ${SEARCH} lost the sap-client`);
        if (search.get('app_start') !== want.S_FRONT.SEARCH.replace('?app_start=', '')) problems.push(`SEARCH ${SEARCH} names another class`);
        const { ORIGIN: o, PATHNAME: p, SEARCH: s, ...wantRest } = want.S_FRONT;
        want = { ...want, S_FRONT: wantRest };
        sent.S_FRONT = rest;
      }
      if (!isDeepStrictEqual(sent, want)) problems.push(`request ${posted} differs: ${JSON.stringify(sent)} vs ${JSON.stringify(want)}`);
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(next.response));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    launchUrl: `${origin}/sap/bc/z2ui5?app_start={class}&sap-client=${SAP_CLIENT}`,
    log,
    adt,
    problems,
    get posted() { return posted; },
    close: () => new Promise((r) => server.close(r)),
  };
}
