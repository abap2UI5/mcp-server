// The code this repository vendors (lib/vendor/): every copy matches the
// sha256 its source.json recorded when scripts/vendor-adaptive-cards.mjs
// wrote it, starts with the header naming that commit, and imports the agent
// modules from lib/ rather than any copy of them - so a hand edit fails here,
// offline. When a protocol checkout that has the recorded commit sits next to
// this repository (PROTOCOL_HOME, or ../protocol), the copies are also
// regenerated from it in memory and must be identical: the copy has not
// drifted from its source commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODULES, SOURCE_RECORD, VENDOR_DIR, REPO, sha256, moduleHeader, build, committedFiles, drift } from '../scripts/vendor-adaptive-cards.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE_RECORD), 'utf8'));

test('every vendored file matches the hash its record holds - no hand edits', () => {
  assert.equal(RECORD.repository, REPO);
  assert.match(RECORD.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(RECORD.files).sort(), Object.values(MODULES).sort());
  for (const [file, { from, sha256: want }] of Object.entries(RECORD.files)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(sha256(text), want, `${file} differs from what was vendored - change it upstream (${REPO} ${from}) and re-vendor`);
    assert.ok(text.startsWith(moduleHeader(from, RECORD.commit)), `${file} must start with the header naming ${from} at ${RECORD.commit}`);
    assert.equal(MODULES[from], file);
  }
  const listed = fs.readdirSync(path.join(ROOT, VENDOR_DIR)).map((f) => `${VENDOR_DIR}/${f}`).sort();
  assert.deepEqual(listed, [...Object.values(MODULES), SOURCE_RECORD].sort(), 'nothing unrecorded lives in the vendor folder');
});

test('the vendored renderer imports the agent modules from lib/, never a copy', () => {
  for (const file of Object.values(MODULES)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const imports = [...text.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(/^\.\/(render|mapping|submit)\.mjs$/.test(spec) || /^\.\.\/\.\.\/(viewxml|snapshot|appclient)\.mjs$/.test(spec),
        `${file} imports ${spec}`);
    }
    assert.ok(!text.includes('conformance/'), `${file} still points into the protocol repository's tree`);
  }
});

function protocolCheckout() {
  const candidates = [process.env.PROTOCOL_HOME, path.join(ROOT, '..', 'protocol')].filter(Boolean);
  for (const dir of candidates) {
    try {
      execFileSync('git', ['-C', dir, 'cat-file', '-e', `${RECORD.commit}^{commit}`], { stdio: 'ignore' });
      return dir;
    } catch {
      /* not a checkout with the commit */
    }
  }
  return null;
}

test('the copies are what the vendor script makes of the recorded commit (with a protocol checkout)', async (t) => {
  const dir = protocolCheckout();
  if (!dir) {
    t.skip(`no protocol checkout with ${RECORD.commit.slice(0, 12)} (PROTOCOL_HOME or ../protocol)`);
    return;
  }
  assert.deepEqual(drift(await build(dir, RECORD.commit), committedFiles(ROOT)), []);
});
