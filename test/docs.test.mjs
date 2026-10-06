// Statements the documents make about the code, held to the code: the files
// a release ships, the timeouts and their defaults, the order the popups
// checkout is looked for in. Each was written once, by hand, and drifted
// while the code moved on - a document an agent or a maintainer acts on is
// as wrong as a bug when it disagrees.
//
// Sibling-free: the documents and the code are in this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT_DEFAULTS } from '../lib/spawn.mjs';
import { resolvePopups } from '../lib/migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (f) => read(f).replace(/\s+/g, ' ');

test('RELEASING.md names the files the tarball carries - package.json `files`', () => {
  const pkg = JSON.parse(read('package.json'));
  const m = /\*\*The tarball is (.*?)\*\*/.exec(flat('RELEASING.md'));
  assert.ok(m, 'RELEASING.md says what the tarball is');
  const named = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter((f) => !/^abap2ui5-/.test(f));
  assert.deepEqual(named.sort(), [...pkg.files, 'package.json'].sort());
});

test('the README and server.json name every child timeout with its default', () => {
  const readme = flat('README.md');
  const server = JSON.parse(read('server.json'));
  const listed = new Map(server.packages[0].environmentVariables.map((v) => [v.name, v.description]));
  for (const [name, ms] of Object.entries(TIMEOUT_DEFAULTS)) {
    assert.ok(readme.includes(`\`${name}\``), `README.md "Timeouts" leaves out ${name}`);
    const def = /Default: (\d+) minutes/.exec(listed.get(name) || '');
    assert.ok(def, `server.json describes ${name} with its default`);
    assert.equal(Number(def[1]) * 60_000, ms, `server.json's default for ${name}`);
  }
  // the README's sentence: "lint/scope 5 min, unit tests 10 min, build ... 30 min"
  const sentence = /\*\*Timeouts:\*\*(.*?)override/.exec(readme)[1];
  for (const [what, name] of [['lint/scope', 'A2UI5_MCP_LINT_TIMEOUT_MS'], ['unit tests', 'A2UI5_MCP_UNIT_TIMEOUT_MS'], ['build', 'A2UI5_MCP_BUILD_TIMEOUT_MS']]) {
    const min = new RegExp(`${what}[^,;]*?(\\d+) min`).exec(sentence);
    assert.ok(min, `README.md gives the ${what} timeout`);
    assert.equal(Number(min[1]) * 60_000, TIMEOUT_DEFAULTS[name], `README.md's ${what} timeout`);
  }
});

test('the documents give the popups lookup in the order resolvePopups takes it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-popups-order-'));
  try {
    const gui = path.join(base, 'abap-cloud-gui');
    const cands = { '.deps/popups': path.join(gui, '.deps', 'popups'), '../popups': path.join(base, 'popups'), 'build/popups': path.join(gui, 'build', 'popups') };
    for (const dir of Object.values(cands)) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'z2ui5_cl_popup_to_select.clas.abap'), '');
    }
    // the order the code takes them in: remove the winner, ask again
    const order = [];
    for (let left = Object.keys(cands).length; left > 0; left -= 1) {
      const won = resolvePopups(gui, {});
      const name = Object.keys(cands).find((k) => path.resolve(cands[k]) === won);
      order.push(name);
      fs.rmSync(cands[name], { recursive: true });
    }
    assert.deepEqual(order, ['.deps/popups', '../popups', 'build/popups'], 'resolvePopups changed - update the documents below and this list');
    const said = (text) => order.map((n) => text.indexOf(n));
    for (const [file, text] of [
      ['README.md', /at `POPUPS_HOME`(.*?)in that order/.exec(flat('README.md'))?.[1]],
      ['AGENTS.md', /\(`POPUPS_HOME`(.*?)`resolvePopups`\)/.exec(flat('AGENTS.md'))?.[1]],
      ['server.json', JSON.parse(read('server.json')).packages[0].environmentVariables.find((v) => v.name === 'POPUPS_HOME')?.description],
    ]) {
      assert.ok(text, `${file} names where the popups are looked for`);
      const at = said(text);
      assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `${file} gives ${order.join(', ')} out of order: ${text}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
