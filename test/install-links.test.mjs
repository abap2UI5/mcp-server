// The README's one-click install links (VS Code, VS Code Insiders, Cursor)
// carry the server registration ENCODED - URL-encoded JSON for VS Code,
// base64 JSON for Cursor - so a change to the registration that updates the
// readable JSON beside them and forgets one of the encodings is invisible to a
// reviewer and ships a button that installs something else. This decodes every
// link and holds it against the one registration the README shows in clear.
//
// Sibling-free: the README is in this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const NAME = 'abap2ui5';
const CONFIG = { command: 'npx', args: ['--yes', '-p', pkg.name, 'abap2ui5-mcp'] };

const params = (url) => new URL(url.replace(/^(vscode(-insiders)?|cursor):/, 'https://x/')).searchParams;

test('the registration the README shows in clear is the npx form every version answers', () => {
  assert.ok(readme.includes(JSON.stringify(CONFIG)), `README.md should show ${JSON.stringify(CONFIG)}`);
  assert.ok(Object.values(pkg.bin).length && pkg.bin['abap2ui5-mcp'], 'the abap2ui5-mcp bin the links name must exist');
});

test('the VS Code and VS Code Insiders badges install exactly that registration', () => {
  const links = [...readme.matchAll(/\((https:\/\/insiders\.vscode\.dev\/redirect\/mcp\/install\?[^)\s]+)\)/g)].map((m) => m[1]);
  assert.equal(links.length, 2, 'one VS Code and one VS Code Insiders badge');
  assert.equal(links.filter((l) => params(l).get('quality') === 'insiders').length, 1, 'one of them carries quality=insiders');
  for (const l of links) {
    const q = params(l);
    assert.equal(q.get('name'), NAME);
    assert.deepEqual(JSON.parse(q.get('config')), CONFIG, l);
  }
});

test('the direct vscode: link carries the name inside the JSON, as VS Code expects', () => {
  const m = /^vscode:mcp\/install\?(\S+)$/m.exec(readme);
  assert.ok(m, 'README.md should give the direct vscode:mcp/install link');
  assert.deepEqual(JSON.parse(decodeURIComponent(m[1])), { name: NAME, ...CONFIG });
});

test('the Cursor badge and deeplink install exactly that registration (base64 JSON)', () => {
  const links = [
    ...readme.matchAll(/(https:\/\/cursor\.com\/en\/install-mcp\?[^)\s]+)/g),
    ...readme.matchAll(/(cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?\S+)/g),
  ].map((m) => m[1]);
  assert.equal(links.length, 2, 'the Cursor badge and the cursor:// deeplink');
  for (const l of links) {
    const q = params(l);
    assert.equal(q.get('name'), NAME);
    assert.deepEqual(JSON.parse(Buffer.from(q.get('config'), 'base64').toString('utf8')), CONFIG, l);
  }
});
