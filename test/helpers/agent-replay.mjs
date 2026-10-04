// The recorded sample sessions of test/fixtures/agent, replayed through the
// protocol client with a fetch that fails on any request that differs from
// the recorded one - the harness of test/appclient.test.mjs, shared by the
// suites that drive the client through another surface (the MCP Apps page,
// the Adaptive Card) and must end up sending exactly what the agent's own
// acts sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppClient } from '../../lib/appclient.mjs';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agent');
export const BASE = 'http://127.0.0.1:4471/';
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
export const FIXTURES = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();

/** A client whose fetch answers the fixture's exchanges in order. */
export function replayClient(name) {
  const exchanges = fixture(name).steps.filter((s) => s.exchange).map((s) => s.exchange);
  const sent = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, BASE);
    const body = JSON.parse(init.body).value;
    sent.push(body);
    const next = exchanges[sent.length - 1];
    assert.ok(next, `${name}: request ${sent.length} was not in the recording: ${JSON.stringify(body)}`);
    assert.deepEqual(body, next.request, `${name}: request ${sent.length} differs from the recorded one`);
    return new Response(JSON.stringify(next.response), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { client: createAppClient({ baseUrl: BASE, fetchImpl }), sent, exchanges };
}

/** The action an agent's step names (an id, or an event name: the first
 *  enabled one of that name, the row action when `row` is given - app_act's
 *  rule), or undefined. */
export function actionOf(snapshot, event, row) {
  const byId = snapshot.actions.find((a) => a.id === event);
  if (byId) return byId;
  const named = snapshot.actions.filter((a) => a.event === event);
  const pool = named.filter((a) => a.enabled).length ? named.filter((a) => a.enabled) : named;
  return (row !== undefined && row !== null ? pool.find((a) => a.scope === 'row') : null) || pool[0];
}

/** A `values` key of a step (field id, path or name; cell by table path or
 *  id) as { kind: 'field', field } or { kind: 'cell', table, row, col, path }. */
export function targetOf(snapshot, key) {
  const k = String(key);
  const f = snapshot.fields.find((x) => x.id === k) || snapshot.fields.find((x) => x.path === k)
    || snapshot.fields.find((x) => x.name.toUpperCase() === k.toUpperCase());
  if (f) return { kind: 'field', field: f };
  const m = /^(.*)\/(\d+)\/([A-Za-z_][\w-]*)$/.exec(k);
  const t = m && snapshot.tables.find((x) => x.path === m[1] || x.id === m[1]);
  if (t) return { kind: 'cell', table: t, row: Number(m[2]), col: m[3], path: `${t.path}/${m[2]}/${m[3]}` };
  return null;
}
