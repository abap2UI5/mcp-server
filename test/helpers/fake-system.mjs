// A fake SAP system for the system mode's tests (test/system.test.mjs): an
// http server on 127.0.0.1 that behaves like the parts of an ABAP system the
// system mode talks to - Basic authentication with a 401 for a wrong one, a
// session cookie handed out on the first accepted logon, a CSRF token layer
// in front of the abap2UI5 endpoint (403 + X-CSRF-Token: Required, the token
// fetched by HEAD and bound to the session cookie), the ADT quick search,
// and the abap2UI5 handler itself, which REPLAYS a recorded sample session of
// test/fixtures/agent and fails on any request that differs from it. Not a
// test file itself (npm test runs test/*.test.mjs only).
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fixture } from './agent-replay.mjs';

export const USER = 'DEVELOPER';
export const PASSWORD = 'pass word:1';
export const SAP_CLIENT = '001';
const SESSION = 'SAP_SESSIONID_A4H_001';
const TOKEN = 'TOKEN-42';

export async function fakeSystem({ sample = 'form-381' } = {}) {
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
      log.push({ method: req.method, path: url.pathname, search: url.search, auth, cookie, csrf: req.headers['x-csrf-token'] });
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
    problems,
    get posted() { return posted; },
    close: () => new Promise((r) => server.close(r)),
  };
}
