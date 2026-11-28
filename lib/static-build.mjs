/*
 * build_static - a project as a static site: the framework and the
 * project's classes transpiled by the npm backend's build (one runtime,
 * lib/npm-backend.mjs buildNpm into a directory of its own), bundled for the
 * browser with esbuild, beside them the database's wasm, the page and the
 * frontend files of the project's BSPs. The result runs the whole backend in
 * the visitor's tab and needs nothing but a static host (GitHub Pages).
 *
 * The recipe is abap2UI5/browser-demo's, generalised; lib/static-site/
 * holds the browser side and says what it adds. The tools the bundle needs
 * (esbuild and the browser stand-ins for Node's modules) are installed once
 * into <workspace>/static-tools at the exact versions of STATIC_TOOLS - the
 * way the npm backend installs its runtime: never bundled with the server,
 * installed when first needed.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { workspaceRoot } from './repos.mjs';
import { spawnNpm, buildNpm } from './npm-backend.mjs';
import { folderObjects } from './deploy.mjs';
import { bspIndex, bspBody } from './bsp.mjs';
import { timeoutOf } from './spawn.mjs';

const SITE = fileURLToPath(new URL('./static-site/', import.meta.url));

/** The bundling tools, at exact versions. */
export const STATIC_TOOLS = {
  esbuild: '0.28.2',
  buffer: '6.0.3',
  process: '0.11.10',
  'path-browserify': '1.0.1',
  '@noble/hashes': '2.4.0',
  pako: '3.0.3',
  'web-encoding': '1.1.5',
};

/* Node modules the transpiled code imports and the browser cannot have:
 * resolved to an empty module - the code paths that use them (a file
 * read, an outbound socket) are not taken in a static site. */
const EMPTY = ['fs', 'tls', 'https', 'http', 'net', 'vm', 'url', 'stream', 'util/types', 'child_process', 'os', 'worker_threads'];

export const toolsDir = () => path.join(workspaceRoot(), 'static-tools');

/** The tools installed in `dir`, or the first one missing. Pure over the directory. */
export function missingTool(dir = toolsDir()) {
  for (const [name, version] of Object.entries(STATIC_TOOLS)) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version;
      if (v !== version) return `${name}@${version} (${v} installed)`;
    } catch {
      return `${name}@${version}`;
    }
  }
  return null;
}

/** Install the bundling tools once; resolves { ok, dir, reason? }. */
export async function ensureTools({ onLine = () => {}, signal, timeoutMs = timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS') } = {}) {
  const dir = toolsDir();
  const missing = missingTool(dir);
  if (!missing) return { ok: true, dir };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'abap2ui5-mcp-static-tools',
    private: true,
    description: 'The abap2UI5 MCP server\'s tools for build_static (lib/static-build.mjs): esbuild and the browser stand-ins of Node\'s modules. Safe to delete; installed again when needed.',
    dependencies: STATIC_TOOLS,
  }, null, 2) + '\n');
  onLine(`static: installing ${missing} and the other bundling tools into ${dir}`);
  const res = await spawnNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], { cwd: dir, timeoutMs, signal, onLine });
  if (res.aborted) return { ok: false, aborted: true, reason: 'cancelled' };
  if (res.code !== 0 || missingTool(dir)) {
    return { ok: false, reason: `npm install of the bundling tools failed (exit ${res.code}): ${String(res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-3).join(' / ')}` };
  }
  return { ok: true, dir };
}

/**
 * The esbuild options of the bundle - pure, so the test can read them.
 * `target` holds the transpiled runtime (init.mjs), `tools` the tools'
 * node_modules, `runtime` the runtime directory's.
 */
export function bundleOptions({ target, tools, runtime, outfile, startClass, ui5 = null, minify = true }) {
  const at = (p) => path.join(tools, p);
  const alias = {
    crypto: path.join(SITE, 'crypto-shim.mjs'),
    zlib: path.join(SITE, 'zlib-shim.mjs'),
    path: at('path-browserify'),
    buffer: at('buffer'),
    util: at('web-encoding'),
  };
  for (const m of EMPTY) alias[m] = path.join(SITE, 'empty.mjs');
  return {
    entryPoints: [path.join(SITE, 'entry.mjs')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // RTTI reads class and function names off the generated objects: mangled, describe_by_data answers nonsense
    keepNames: true,
    minify,
    legalComments: 'none',
    nodePaths: [tools, runtime],
    alias: { ...alias, 'abap2ui5-static:init': path.join(target, 'init.mjs') },
    inject: [path.join(SITE, 'globals.mjs')],
    define: {
      __A2UI5_STATIC__: JSON.stringify({ startClass: startClass ? String(startClass).toUpperCase() : '', ui5 }),
      global: 'globalThis',
    },
    plugins: [ENCODED_PATHS],
    logLevel: 'silent',
  };
}

/* The transpiler writes the import of an object with a namespace URL-encoded
 * (`./open-abap-core/%23ui2%23cl_json.clas.mjs` for /ui2/cl_json) - right for
 * an ESM loader, which decodes it, and a file esbuild does not find. */
export const ENCODED_PATHS = {
  name: 'a2ui5-encoded-paths',
  setup(build) {
    build.onResolve({ filter: /%[0-9A-Fa-f]{2}/ }, (args) => {
      if (!args.path.startsWith('.')) return undefined;
      return { path: path.resolve(args.resolveDir, decodeURIComponent(args.path)) };
    });
  },
};

/**
 * Build `dir` (a project folder) as a static site into `out`. Resolves
 * { ok, out, files, bytes, bsp, startClass, ... } or { ok: false, reason }.
 */
export const SITE_MARKER = '.abap2ui5-static.json';

/**
 * Why `out` may not be written, or null: a build replaces the folder's
 * files, so it is a new folder, an empty one, or one an earlier build_static
 * wrote (its marker) - never a folder of somebody's own, never the project
 * folder or one above it. Pure over the file system.
 */
export function outProblem(out, projectDir) {
  const o = path.resolve(out);
  const p = path.resolve(projectDir);
  if (o === p || p.startsWith(o + path.sep)) return `${o} holds the project itself - name a folder of its own for the site, e.g. ${path.join(path.dirname(p), 'site')}`;
  if (o.startsWith(p + path.sep)) return `${o} is inside the folder being built - deploy_folder and the next build would read the site as part of the project; put it beside the project`;
  let entries;
  try {
    entries = fs.readdirSync(o);
  } catch {
    return null; // a new folder
  }
  if (!entries.length || entries.includes(SITE_MARKER)) return null;
  return `${o} is not empty and no earlier build_static wrote it (no ${SITE_MARKER}) - its files would be replaced; name a new or empty folder`;
}

export async function buildStatic({ dir, startClass, out, ui5 = null, minify = true, onLine = () => {}, signal } = {}) {
  const timeoutMs = timeoutOf('A2UI5_MCP_BUILD_TIMEOUT_MS');
  const scan = folderObjects(dir);
  const refused = outProblem(out, scan.root);
  if (refused) return { ok: false, stage: 'out', reason: refused };
  if (startClass && !scan.objects.some((o) => o.type === 'clas' && o.name === String(startClass).toLowerCase())) {
    return { ok: false, stage: 'start', reason: `${String(startClass).toLowerCase()} is no class of ${scan.root}` };
  }
  // 1. the project's objects into an input folder of the workspace
  const input = path.join(workspaceRoot(), 'static-input');
  fs.rmSync(input, { recursive: true, force: true });
  fs.mkdirSync(input, { recursive: true });
  for (const o of scan.objects) for (const f of o.files) fs.copyFileSync(f.path, path.join(input, f.name));
  // 2. the transpile - the framework and the project, one runtime
  const built = await buildNpm({ inputDir: input, appsName: 'static', withLint: false, onLine, signal, timeoutMs });
  if (!built.ok) return { ok: false, stage: 'transpile', aborted: Boolean(built.aborted), reason: built.reason };
  if (!fs.existsSync(path.join(built.apps, 'boot.mjs'))) {
    return { ok: false, stage: 'transpile', reason: `@abap2ui5/node-runtime ${built.version} transpiles apps beside the framework, not with it - a static site needs one runtime (a release from 1.149 on)` };
  }
  // 3. the tools and the bundle
  const tools = await ensureTools({ onLine, signal, timeoutMs });
  if (!tools.ok) return { ok: false, stage: 'tools', aborted: Boolean(tools.aborted), reason: tools.reason };
  const outDir = path.resolve(out);
  // the site is written whole: what an earlier build left goes first
  if (fs.existsSync(path.join(outDir, SITE_MARKER))) {
    for (const e of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, e), { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const esbuild = createRequire(path.join(tools.dir, 'package.json'))('esbuild');
  onLine(`static: bundling ${built.apps} into ${outDir}/app.js`);
  try {
    await esbuild.build(bundleOptions({
      target: built.apps,
      tools: path.join(tools.dir, 'node_modules'),
      runtime: path.join(built.dir, 'node_modules'),
      outfile: path.join(outDir, 'app.js'),
      startClass, ui5, minify,
    }));
  } catch (e) {
    const errs = (e && e.errors) || [];
    return { ok: false, stage: 'bundle', reason: errs.length ? errs.slice(0, 5).map((x) => `${x.text}${x.location ? ` (${x.location.file}:${x.location.line})` : ''}`).join('; ') : String((e && e.message) || e) };
  }
  // 4. the files beside it
  const wasm = createRequire(path.join(built.dir, 'node_modules', '@abaplint', 'database-sqlite', 'package.json')).resolve('sql.js/dist/sql-wasm-browser.wasm');
  fs.copyFileSync(wasm, path.join(outDir, 'sql-wasm-browser.wasm'));
  const title = startClass ? String(startClass).toLowerCase() : 'abap2UI5';
  fs.writeFileSync(path.join(outDir, 'index.html'), fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').replace('__TITLE__', title));
  // the frontend's manifest names css/style.css; a missing file is a 404 in every boot
  fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });
  if (!fs.existsSync(path.join(outDir, 'css', 'style.css'))) fs.writeFileSync(path.join(outDir, 'css', 'style.css'), '');
  // GitHub Pages runs Jekyll otherwise, which drops files starting with _
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  // the BSPs of the project, as a system serves them
  const index = bspIndex([scan.root]);
  for (const [key, file] of index) {
    const to = path.join(outDir, 'sap', 'bc', 'ui5_ui5', 'sap', ...key.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, bspBody(key, fs.readFileSync(file)));
  }
  fs.writeFileSync(path.join(outDir, SITE_MARKER), JSON.stringify({
    note: 'Written by the abap2UI5 MCP server (build_static). The whole folder is replaced by the next build into it.',
    project: scan.root, startClass: startClass ? String(startClass).toLowerCase() : null, runtime: built.version, ui5, builtAt: new Date().toISOString(),
  }, null, 2) + '\n');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push({ file: path.relative(outDir, p).split(path.sep).join('/'), bytes: fs.statSync(p).size });
    }
  };
  walk(outDir);
  return {
    ok: true,
    out: outDir,
    startClass: startClass ? String(startClass).toLowerCase() : null,
    runtime: built.version,
    objects: built.objects,
    bsp: [...new Set([...index.keys()].map((k) => k.split('/')[0]))],
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    bundleBytes: (files.find((f) => f.file === 'app.js') || {}).bytes,
    url: pathToFileURL(path.join(outDir, 'index.html')).href,
  };
}

