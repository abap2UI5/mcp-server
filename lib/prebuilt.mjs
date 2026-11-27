/*
 * prebuilt - the framework's own backend (split out of lib/runtime.mjs,
 * which re-exports it): the release asset (download, size cap, the .sha256
 * sidecar, unpack, layout check), the framework clone that mode prebuilt
 * makes when there is no checkout, and the framework's own transpile.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { workspaceRoot } from './repos.mjs';
import { spawnWithTimeout, timedOutError } from './spawn.mjs';
import { spawnNpm, outputLayout } from './npm-backend.mjs';
import { readCappedText, declaredLength, tooLargeError } from './remote.mjs';
import { a2Local } from './sandbox.mjs';

// -------------------------------------------------------------- prebuilt ----

/* The asset the framework's release workflow attaches to every release
 * (abap2UI5's .github/workflows/backend-prebuilt.yaml): its name and the
 * manifest at the archive root are a contract shared with that workflow. A
 * renamed asset over there is a failed download here, reported by URL. */
export function prebuiltUrl(version) {
  return process.env.A2UI5_MCP_PREBUILT_URL
    || `https://github.com/abap2UI5/abap2UI5/releases/download/${version}/backend-${version}.tar.gz`;
}

/* The archive is CODE: run_app boots node/output/init.mjs out of it. The
 * release asset comes over TLS from github.com, but A2UI5_MCP_PREBUILT_URL
 * takes any URL - and a corporate mirror over plain http is one hop a proxy
 * can rewrite into a backend of its own. So an http: URL is refused unless
 * A2UI5_MCP_PREBUILT_INSECURE=1 says the network is trusted - except for the
 * loopback addresses, where nothing is on the wire (the tests serve from
 * 127.0.0.1, and so does a developer's local mirror). Returns the reason,
 * or null when the URL may be fetched. */
export function prebuiltUrlProblem(url, env = process.env) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (u.protocol !== 'http:') return null;
  // the loopback by address (the name is not resolved here, so it is not trusted)
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (env.A2UI5_MCP_PREBUILT_INSECURE === '1') return null;
  return `${url} is plain http: - the archive is code the backend runs, and nothing on the way can be trusted; `
    + 'use https:, or set A2UI5_MCP_PREBUILT_INSECURE=1 for a network you trust';
}

/* The digest sidecar the framework's release workflow attaches beside the
 * archive from the release after 1.148.0 on: `backend-<version>.tar.gz.sha256`, one line in
 * sha256sum's format (`<hex>  backend-<version>.tar.gz`, written by
 * node/setup/pack-backend.mjs over there). The hex is what counts; the file
 * name after it is sha256sum's and not checked (a mirror may rename). Null
 * when the text is not such a line. */
export function parseSha256Sidecar(text) {
  const m = /^\s*([0-9a-fA-F]{64})(?:\s|$)/.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

/* The last release whose archive comes without the sidecar: every release
 * after it carries one (abap2UI5's backend-prebuilt workflow). */
export const LAST_RELEASE_WITHOUT_SIDECAR = '1.148.0';

/* Whether the release `version` must come with a .sha256 sidecar: every
 * X.Y.Z after LAST_RELEASE_WITHOUT_SIDECAR. A version that is no plain
 * X.Y.Z (a suffix, a typo) is taken as one that must: the side to err on
 * is a refused download, not an unchecked one. Pure. */
export function sidecarRequired(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!m) return true;
  const last = LAST_RELEASE_WITHOUT_SIDECAR.split('.').map(Number);
  const v = m.slice(1).map(Number);
  const i = v.findIndex((n, j) => n !== last[j]);
  return i >= 0 && v[i] > last[i];
}

/* The sidecar beside `url`: `{ hex }`, `{ absent: true }` when the server
 * has none (404 - a release before the sidecar existed, or a mirror that
 * carries only the archive), or `{ failed: <why> }` for every other failure
 * - an HTTP error, a network error, a text that is no sha256sum line. A
 * sidecar that cannot be read must not turn a release that has one into an
 * unverified one, so the caller decides by the version (sidecarRequired)
 * and says which it was. */
async function fetchSha256Sidecar(url, { fetchImpl, signal }) {
  const sidecar = `${url}.sha256`;
  try {
    const res = await fetchImpl(sidecar, { signal, headers: { 'User-Agent': 'abap2ui5-mcp-server' }, redirect: 'follow' });
    if (res.status === 404) return { absent: true };
    if (!res.ok) return { failed: `HTTP ${res.status} for ${sidecar}` };
    const text = await res.text();
    const hex = parseSha256Sidecar(text);
    return hex ? { hex } : { failed: `${sidecar} is not a sha256sum line` };
  } catch (e) {
    return { failed: `${sidecar}: ${String((e && e.message) || e)}` };
  }
}

function sha256OfFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* The framework repository and where its releases are asked for.
 *
 * NOT `releases/latest`: the framework publishes every version twice, the
 * release (`1.145.0`, which carries backend-1.145.0.tar.gz) and its 7.02
 * downport (`1.145.0-702`, published seconds later, no asset). GitHub's
 * "latest" is simply the newest, so it named the downport, and the clone got
 * downported sources that no prebuilt backend exists for. The list is read
 * instead and the highest plain X.Y.Z release is taken (latestPlainRelease). */
const FRAMEWORK_REPO = 'https://github.com/abap2UI5/abap2UI5';
const FRAMEWORK_RELEASES = 'https://api.github.com/repos/abap2UI5/abap2UI5/releases?per_page=100';

/** The highest plain `X.Y.Z` (or `vX.Y.Z`) tag among GitHub releases -
 *  never a draft, a prerelease or a suffixed tag like `1.145.0-702`. Pure. */
export function latestPlainRelease(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue;
    const tag = String(r.tag_name || '');
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!m) continue;
    const v = m.slice(1).map(Number);
    const i = best ? v.findIndex((n, j) => n !== best.v[j]) : -1;
    if (!best || (i >= 0 && v[i] > best.v[i])) best = { tag, v };
  }
  return best ? best.tag : null;
}

/** Where cloneFramework puts the checkout. */
export function frameworkCloneDir() {
  return path.join(workspaceRoot(), 'abap2UI5');
}

/*
 * A shallow clone of the framework's latest release into the workspace, for
 * a machine that has no abap2UI5 checkout at all: with it, `build_backend`
 * (prebuilt) and `run_app` need nothing anybody prepared. The release tag is
 * asked of GitHub so the clone's package.json version is one a backend asset
 * exists for; when the API cannot be reached the default branch is cloned
 * and the download then reports whether an asset exists for that version.
 * Narrated through onLine like the download. Never rejects.
 */
export async function cloneFramework({ onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch, tag: wanted = null } = {}) {
  const dir = frameworkCloneDir();
  if (fs.existsSync(path.join(dir, 'node/srv/express.mjs'))) {
    /* A clone that is there but on another release than the one asked for
     * (the CI runner asks for the project's pin) is replaced: a backend
     * built from the wrong framework tests the wrong framework. */
    if (!wanted || readVersion(dir) === wanted) return { ok: true, dir, existed: true, tag: readVersion(dir) };
    onLine(`clone: ${dir} is abap2UI5 ${readVersion(dir)}, ${wanted} was asked for - replacing it`);
  }
  let tag = wanted;
  if (!tag) try {
    const res = await fetchImpl(FRAMEWORK_RELEASES, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'abap2ui5-mcp-server' } });
    if (res.ok) {
      tag = latestPlainRelease(JSON.parse(await readCappedText(res, FRAMEWORK_RELEASES)));
      if (!tag) onLine('clone: no X.Y.Z release among the framework\'s releases — cloning the default branch instead');
    } else onLine(`clone: GitHub answered ${res.status} for the release list — cloning the default branch instead`);
  } catch (e) {
    onLine(`clone: the latest release could not be looked up (${String((e && e.message) || e)}) — cloning the default branch instead`);
  }
  if (signal && signal.aborted) return { ok: false, aborted: true, dir };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true }); // a half clone from a killed run
  onLine(`clone: git clone --depth 1${tag ? ` --branch ${tag}` : ''} ${FRAMEWORK_REPO} ${dir}`);
  const args = ['clone', '--quiet', '--depth', '1', ...(tag ? ['--branch', tag] : []), FRAMEWORK_REPO, dir];
  const git = await spawnWithTimeout('git', args, { timeoutMs, onLine, signal });
  if (git.aborted) return { ok: false, aborted: true, dir };
  if (git.code !== 0 || !fs.existsSync(path.join(dir, 'node/srv/express.mjs'))) {
    onLine(`clone: git exited ${git.code} — ${(git.stderr || '').slice(-300)}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, dir, reason: `git exited ${git.code}` };
  }
  onLine(`clone: abap2UI5${tag ? ` ${tag}` : ''} is at ${dir} (A2UI5_MCP_WORKSPACE moves the workspace)`);
  return { ok: true, dir, tag };
}

/** The version a checkout's package.json names, or null. */
export function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/*
 * The framework's own build, in its checkout: what backend-prebuilt.yaml
 * runs to make the asset, run here when there is none. `npm ci` first when
 * the checkout has no node_modules (the transpiler and abaplint are its
 * devDependencies; express, which the served backend needs, too). Narrated
 * through onLine; never rejects.
 */
export async function transpileFramework({ a2, onLine = () => {}, signal, timeoutMs = 30 * 60_000 } = {}) {
  const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  const steps = [];
  if (!fs.existsSync(path.join(a2, 'node_modules', '@abaplint', 'transpiler-cli'))) {
    steps.push({ what: 'npm ci', args: ['ci', '--no-audit', '--no-fund'] });
  }
  steps.push({ what: 'npm run downport', args: ['run', 'downport'] });
  steps.push({ what: 'npm run auto_transpile', args: ['run', 'auto_transpile'] });
  for (const d of ['node/output', PREBUILT_MANIFEST]) fs.rmSync(path.join(a2, d), { recursive: true, force: true });
  for (const step of steps) {
    onLine(`transpile: ${step.what} in ${a2}`);
    /* spawnNpm: on Windows npm is npm.cmd, which spawn runs through cmd.exe
     * or not at all - a bare npm spawn failed there with ENOENT */
    const res = await spawnNpm(step.args, { cwd: a2, env, timeoutMs, onLine, signal });
    if (res.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    if (res.timedOut) {
      onLine(`transpile: ${timedOutError(step.what, 'A2UI5_MCP_BUILD_TIMEOUT_MS')}`);
      return { ok: false, reason: 'timeout' };
    }
    if (res.code !== 0) {
      onLine(`transpile: ${step.what} exited ${res.code} — ${(res.stderr || res.stdout || '').slice(-400)}`);
      return { ok: false, reason: `${step.what} exited ${res.code}` };
    }
  }
  if (!fs.existsSync(path.join(a2, 'node/output/init.mjs'))) {
    onLine('transpile: finished, but node/output/init.mjs is not there');
    return { ok: false, reason: 'no node/output after the transpile' };
  }
  onLine(`transpile: abap2UI5 ${readVersion(a2) || ''} built in ${a2}`);
  return { ok: true };
}

/** The @abaplint/transpiler-cli version a checkout builds with: its
 *  lockfile's entry, else the installed one; null when neither says. */
function checkoutTranspiler(a2) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(a2, 'package-lock.json'), 'utf8'));
    const v = lock.packages && lock.packages['node_modules/@abaplint/transpiler-cli'] && lock.packages['node_modules/@abaplint/transpiler-cli'].version;
    if (typeof v === 'string') return v;
  } catch {
    /* no lockfile: the installed one */
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(a2, 'node_modules', '@abaplint', 'transpiler-cli', 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** The output layout a checkout's transpiler writes (see outputLayout in
 *  lib/npm-backend.mjs): 'folders' from @abaplint/transpiler-cli 2.14 on,
 *  'flat' before; null when the version cannot be read. */
export function checkoutLayout(a2) {
  const v = checkoutTranspiler(a2);
  const m = /^(\d+)\.(\d+)\./.exec(String(v || ''));
  if (!m) return null;
  return Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 14) ? 'folders' : 'flat';
}

/* The manifest the archive carries at its root, kept beside the checkout's
 * package.json after unpacking (the framework gitignores it). */
export const PREBUILT_MANIFEST = 'backend-manifest.json';

/* The most the prebuilt archive may be. backend-1.146.0.tar.gz is 2.7 MB
 * (1.145.0: 2.7 MB too) - the framework transpiled, its downport and
 * open-abap-core, compressed; 200 MB leaves it room to grow seventyfold. A
 * download was bounded by the build timeout only, so a proxy or a mirror
 * (A2UI5_MCP_PREBUILT_URL) answering with an endless body filled the temp
 * disk for half an hour. One that declares more is refused unread, one that
 * streams more is cut at the cap; the previous build stays either way. */
export const PREBUILT_MAX_BYTES = 200 * 1024 * 1024;

/** The manifest of the prebuilt backend a checkout carries, or null. */
export function prebuiltManifest(a2 = a2Local()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(a2, PREBUILT_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/*
 * Download and unpack the released backend into the checkout. Resolves —
 * never rejects — with { ok, reason?, aborted?, manifest? }; every step is
 * narrated through onLine so the build log carries the story.
 *
 * The build products of any earlier build are removed first: an archive
 * unpacked over a stale node/output would keep files the release no longer
 * has. `npm ci` runs in the checkout when express (which the served backend
 * requires, and which samples-controls' node:setup used to install) is not
 * there yet.
 */
export async function downloadPrebuilt({ a2, onLine = () => {}, signal, timeoutMs = 30 * 60_000, fetchImpl = globalThis.fetch, maxBytes = PREBUILT_MAX_BYTES } = {}) {
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(a2, 'package.json'), 'utf8')).version;
  } catch (e) {
    onLine(`prebuilt backend: cannot read the checkout's package.json (${e.message})`);
    return { ok: false, reason: 'no package.json version' };
  }
  const url = prebuiltUrl(version);
  const problem = prebuiltUrlProblem(url);
  if (problem) {
    onLine(`prebuilt backend: ${problem}`);
    return { ok: false, reason: 'insecure url' };
  }
  onLine(`prebuilt backend: fetching ${url}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-prebuilt-'));
  const file = path.join(tmp, `backend-${version}.tar.gz`);
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let out = null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.any(signals), headers: { 'User-Agent': 'abap2ui5-mcp-server' }, redirect: 'follow' });
    if (!res.ok) {
      onLine(`prebuilt backend: HTTP ${res.status} — release ${version} carries no backend-${version}.tar.gz `
        + '(the asset is attached by the framework\'s backend-prebuilt workflow a while after the release; '
        + 'a checkout on an unreleased commit has no asset at all: run mode:full, or check out the release tag)');
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const total = declaredLength(res) || 0;
    if (total > maxBytes) {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
      throw tooLargeError(url, maxBytes);
    }
    out = fs.createWriteStream(file);
    let got = 0;
    let lastTenth = -1;
    for await (const chunk of res.body) {
      got += chunk.length;
      // leaving the loop by the throw cancels the download (catch below)
      if (got > maxBytes) throw tooLargeError(url, maxBytes);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const tenth = total ? Math.floor((got * 10) / total) : -1;
      if (tenth !== lastTenth) {
        lastTenth = tenth;
        onLine(`prebuilt backend: ${Math.round(got / 1048576)} MB${total ? ` of ${Math.round(total / 1048576)} MB` : ''}`);
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    /* Verified BEFORE the previous build is removed: a tampered or truncated
     * archive leaves what was there, like every other failed download. The
     * sidecar is the release workflow's (prebuiltUrlProblem says why the
     * archive deserves one). A release after LAST_RELEASE_WITHOUT_SIDECAR
     * is unpacked only verified: a missing, unreadable or malformed sidecar
     * refuses it - an archive that could not be checked was unpacked
     * unchecked, and a proxy answering the .sha256 with a 500 was enough.
     * An older release without one (404) unpacks as before, with the one
     * line that says so. */
    const sidecar = await fetchSha256Sidecar(url, { fetchImpl, signal: AbortSignal.any(signals) });
    if (sidecar.hex) {
      const actual = sha256OfFile(file);
      if (actual !== sidecar.hex) {
        onLine(`prebuilt backend: sha256 mismatch - ${url} is ${actual}, its .sha256 sidecar says ${sidecar.hex}; `
          + 'the download is discarded and the previous build stays');
        return { ok: false, reason: 'sha256 mismatch' };
      }
      onLine(`prebuilt backend: sha256 ${actual} verified against ${url}.sha256`);
    } else if (sidecarRequired(version)) {
      onLine(`prebuilt backend: ${sidecar.absent ? `no ${url}.sha256 beside the archive (404)` : sidecar.failed} - `
        + `release ${version} carries a .sha256 sidecar (every release after ${LAST_RELEASE_WITHOUT_SIDECAR} does), so the archive `
        + 'is not unpacked unverified; the download is discarded and the previous build stays '
        + '(a mirror in A2UI5_MCP_PREBUILT_URL has to serve the sidecar beside the archive)');
      return { ok: false, reason: 'sha256 unverified' };
    } else if (sidecar.absent) {
      onLine(`prebuilt backend: no ${url}.sha256 beside the archive - unverified (releases after ${LAST_RELEASE_WITHOUT_SIDECAR} carry one)`);
    } else {
      onLine(`prebuilt backend: ${sidecar.failed} - the archive is unverified (release ${version} predates the sidecar)`);
    }
    for (const d of ['node/output', 'node/downport', 'node/deps', PREBUILT_MANIFEST]) {
      fs.rmSync(path.join(a2, d), { recursive: true, force: true });
    }
    onLine(`prebuilt backend: unpacking into ${a2}`);
    /* --no-same-owner: as root (a container, a CI runner) GNU tar and bsdtar
     * would otherwise restore the uid/gid the archive carries - the
     * workflow's runner user - onto the checkout. Both tars know the flag. */
    const untar = await spawnWithTimeout('tar', ['-xzf', file, '-C', a2, '--no-same-owner'], { cwd: a2, timeoutMs, onLine, signal });
    if (untar.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    if (untar.code !== 0) {
      onLine(`prebuilt backend: tar exited ${untar.code} — ${(untar.stderr || '').slice(-300)}`);
      return { ok: false, reason: `tar exited ${untar.code}` };
    }
    const manifest = prebuiltManifest(a2);
    if (!manifest) {
      onLine(`prebuilt backend: the archive carries no ${PREBUILT_MANIFEST} at its root — not an archive this server understands`);
      return { ok: false, reason: 'no manifest' };
    }
    if (manifest.version && manifest.version !== version) {
      onLine(`prebuilt backend: the manifest says ${manifest.version}, the checkout is ${version} — run_app boots the archived build`);
    }
    if (!fs.existsSync(path.join(a2, 'node/output/init.mjs'))) {
      onLine('prebuilt backend: the archive carries no node/output/init.mjs');
      return { ok: false, reason: 'no node/output in the archive' };
    }
    /* The checkout's node/srv imports the shim and the handler from where
     * ITS transpiler writes them, and the incremental build writes on top
     * with that transpiler: an archive of the other layout (a checkout past
     * the 2.14 switch whose version's release predates it, or the reverse)
     * boots nothing and mixes two layouts in one node/output. */
    const want = checkoutLayout(a2);
    const unpacked = outputLayout(path.join(a2, 'node', 'output'));
    if (want && want !== unpacked) {
      for (const d of ['node/output', 'node/downport', 'node/deps', PREBUILT_MANIFEST]) fs.rmSync(path.join(a2, d), { recursive: true, force: true });
      onLine(`prebuilt backend: the archive's node/output is ${unpacked}, and the checkout's transpiler (${checkoutTranspiler(a2)}) writes ${want === 'folders' ? 'a folder per origin' : 'one flat folder'} - `
        + 'the release predates the checkout\'s commit; build the framework itself (mode transpile), or check out the release tag');
      return { ok: false, layoutMismatch: true, reason: `layout: archive ${unpacked}, checkout ${want}` };
    }
    if (!fs.existsSync(path.join(a2, 'node_modules', 'express'))) {
      onLine('prebuilt backend: npm ci in the abap2UI5 checkout (express and the ABAP runtime the backend needs)');
      const ci = await spawnNpm(['ci', '--no-audit', '--no-fund'], { cwd: a2, timeoutMs, onLine, signal, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
      if (ci.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
      if (ci.code !== 0) {
        onLine(`prebuilt backend: npm ci exited ${ci.code} — ${(ci.stderr || '').slice(-300)}`);
        return { ok: false, reason: `npm ci exited ${ci.code}` };
      }
    }
    onLine(`prebuilt backend ${manifest.version || version} (${manifest.commit || 'unknown commit'}, built ${manifest.builtAt || 'unknown'}) unpacked into ${a2}`);
    return { ok: true, manifest };
  } catch (e) {
    /* A download that died mid-stream leaves the file open; closed here so
     * the cleanup below can remove it (Windows refuses an open file) - and
     * waited for: a stream still opening its file when the download is cut
     * (the size cap on the first chunk) opened it after the cleanup had
     * removed the directory, an ENOENT 'error' nobody listened for. */
    if (out) {
      out.on('error', () => {});
      out.destroy();
      if (!out.closed) await new Promise((r) => out.once('close', r));
    }
    if (signal && signal.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
    const message = String((e && e.message) || e);
    onLine(`prebuilt backend: ${message}`);
    return { ok: false, reason: message };
  } finally {
    // best effort: a temp dir that will not go must not turn a reported
    // failure into a rejection this function promises never to produce
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in tmp */ }
  }
}
