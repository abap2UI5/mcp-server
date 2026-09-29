// A fake npm-backend workspace for the tests of the npm backend's wiring
// (test/npm-runtime.test.mjs, test/npm-host.test.mjs): one release installed
// the way lib/npm-backend.mjs leaves it - the package with a host module and
// an output/ to point imports at, a transpiler, abaplint, express, the
// install marker - and open-abap-core fetched. Every tool is a small script
// that does what the real one does to the files this server reads, so no
// registry, no git and no real transpile is involved. Not a test file itself
// (npm test runs test/*.test.mjs only).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const VERSION = '1.145.0';
export const CORE_SHA = 'b2d219df61f8c077df7a038bc43d168f9f280fbf';

/* The package: initialize() counts boots, accelerate() is optional,
 * serve() answers every request with the classes registered at that moment
 * (so a GET proves the host imported the dev apps), compress optional too. */
function hostModule({ accelerate, compress }) {
  return `
import http from 'node:http';
export const HANDLER_CLASS = 'ZCL_SICF';
export async function initialize() { globalThis.__boots = (globalThis.__boots || 0) + 1; globalThis.abap = globalThis.abap || { Classes: {} }; }
${accelerate ? 'export async function accelerate() { globalThis.__accelerated = true; }' : ''}
${compress ? `export function compress() { return (req, res, next) => { res.setHeader('x-fake-compress', 'yes'); next(); }; }` : ''}
const answer = (req, res) => res.end(JSON.stringify({ classes: Object.keys(globalThis.abap.Classes).sort(), accelerated: Boolean(globalThis.__accelerated), boots: globalThis.__boots }));
export async function createApp() { return (req, res) => answer(req, res); }
export async function serve({ port, host }) {
  await initialize();
  return new Promise((resolve, reject) => { const s = http.createServer(answer); s.listen(port, host, () => resolve(s)); s.on('error', reject); });
}
`;
}

/* The transpiler: per input object a module that imports cx_root the way the
 * real output does and registers itself in abap.Classes, a testclasses
 * module per test include, the dependency output the real one writes too,
 * a runner over the dev tests (a test include containing FAIL throws) and
 * an init.mjs. */
const TRANSPILER = `
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const lib of cfg.libs) if (!fs.existsSync(path.join(process.cwd(), lib.folder))) { console.log('Error: Library folder not found: ' + lib.folder); process.exit(1); }
const filter = new RegExp(cfg.input_filter[0], 'i');
const files = fs.existsSync(cfg.input_folder) ? fs.readdirSync(cfg.input_folder).filter((f) => filter.test(path.join(cfg.input_folder, f))) : [];
const text = (f) => fs.readFileSync(path.join(cfg.input_folder, f), 'utf8');
const bad = files.find((f) => text(f).includes('BROKEN'));
if (bad) { console.log('Error: check_syntax, Method "nope" not found, methodCallChain, ' + bad + ':2'); process.exit(1); }
const objs = [...new Set(files.map((f) => f.split('.').slice(0, 2).join('.').toLowerCase()))];
const out = cfg.output_folder;
fs.writeFileSync(path.join(out, 'cx_root.clas.mjs'), 'export class cx_root {}');
fs.writeFileSync(path.join(out, 'z2ui5_cl_util.clas.mjs'), 'export class z2ui5_cl_util {}');
let init = 'await initializeABAP();\\nawait import("./cx_root.clas.mjs");\\n';
let data = '';
for (const o of objs) {
  const name = o.split('.')[0];
  fs.writeFileSync(path.join(out, o + '.mjs'), [
    'const {cx_root} = await import("./cx_root.clas.mjs");',
    'class ' + name + ' extends cx_root {}',
    'abap.Classes[' + JSON.stringify(name.toUpperCase()) + '] = ' + name + ';',
    'export {' + name + '};',
  ].join('\\n') + '\\n');
  init += 'await import("./' + o + '.mjs");\\n';
  const tests = o + '.testclasses.abap';
  if (files.includes(tests)) {
    const fail = text(tests).includes('FAIL');
    fs.writeFileSync(path.join(out, o + '.testclasses.mjs'), [
      'const {' + name + '} = await import("./' + o + '.mjs");',
      'export class ltcl { async constructor_() { return this; } async check() { ' + (fail ? 'throw new Error("assert_equals failed: exp 1 act 2");' : '') + ' } }',
    ].join('\\n') + '\\n');
    data += '  ret.push({objectName: "' + name.toUpperCase() + '", localClass: "ltcl", methods: [{"name":"check","skip":false}], riskLevel: "HARMLESS", filename: "./' + o + '.testclasses.mjs"});\\n';
  }
}
fs.writeFileSync(path.join(out, 'index.mjs'), [
  '/* eslint-disable curly */',
  'import "./init.mjs";',
  'function getData() {',
  '  const ret = [];',
  data + '  return ret;',
  '}',
  'async function run() {',
  '  for (const st of getData()) {',
  '    const imported = await import(st.filename);',
  '    const localClass = imported[st.localClass];',
  '    for (const m of st.methods) {',
  '      console.log(st.objectName + ": running " + st.localClass + "->" + m.name);',
  '      const test = await (new localClass()).constructor_();',
  '      await test[m.name]();',
  '    }',
  '  }',
  '}',
  'run().then(() => process.exit(0)).catch((err) => { console.log(err); process.exit(1); });',
].join('\\n') + '\\n');
fs.writeFileSync(path.join(out, 'init.mjs'), init);
console.log((objs.length + 2) + ' objects written to disk');
`;

/* abaplint: records the config it was handed (and where it ran), answers
 * clean. */
const ABAPLINT = `
const fs = require('fs');
if (process.env.LINT_RECORD) fs.writeFileSync(process.env.LINT_RECORD, JSON.stringify({ cwd: process.cwd(), config: JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) }));
console.log('[]');
`;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Install the fake release into `<workspace>/runtime/<version>` and fetch
 *  the fake open-abap-core; returns the runtime directory. */
export function fakeRelease(workspace, { version = VERSION, accelerate = true, compress = false } = {}) {
  const dir = path.join(workspace, 'runtime', version);
  const nm = path.join(dir, 'node_modules');
  const pkg = path.join(nm, '@abap2ui5', 'node-runtime');
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'abap2ui5-mcp-runtime', private: true, dependencies: {} }));
  write(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@abap2ui5/node-runtime',
    version,
    type: 'module',
    exports: { '.': './srv/host.mjs', './package.json': './package.json', './output/*': './output/*', './downport/*': './downport/*' },
    peerDependencies: { express: '^5.0.0' },
    abap2ui5: { transpiler: '2.13.91' },
  }));
  write(path.join(pkg, 'srv', 'host.mjs'), hostModule({ accelerate, compress }));
  write(path.join(pkg, 'output', 'init.mjs'), 'export async function initializeABAP() {}\n');
  write(path.join(pkg, 'output', 'cx_root.clas.mjs'), 'export class cx_root {}\nglobalThis.abap = globalThis.abap || { Classes: {} };\nglobalThis.abap.Classes.CX_ROOT = cx_root;\n');
  write(path.join(pkg, 'downport', '02', 'z2ui5_if_app.intf.abap'), 'INTERFACE z2ui5_if_app PUBLIC. ENDINTERFACE.\n');
  const cli = path.join(nm, '@abaplint', 'transpiler-cli');
  write(path.join(cli, 'package.json'), JSON.stringify({ name: '@abaplint/transpiler-cli', version: '2.13.91', bin: { abap_transpile: './abap_transpile' } }));
  write(path.join(cli, 'abap_transpile'), TRANSPILER);
  const lint = path.join(nm, '@abaplint', 'cli');
  write(path.join(lint, 'package.json'), JSON.stringify({ name: '@abaplint/cli', version: '2.120.60', bin: { abaplint: './abaplint' } }));
  write(path.join(lint, 'abaplint'), ABAPLINT);
  // express: the real one this repository has installed (the compress path imports it)
  const express = path.dirname(createRequire(import.meta.url).resolve('express/package.json'));
  fs.mkdirSync(nm, { recursive: true });
  try {
    fs.symlinkSync(express, path.join(nm, 'express'), 'junction');
  } catch {
    write(path.join(nm, 'express', 'package.json'), JSON.stringify({ name: 'express', version: '5.2.1' }));
  }
  write(path.join(dir, '.abap2ui5-mcp-runtime.json'), JSON.stringify({
    version,
    installedAt: new Date().toISOString(),
    dependencies: { '@abap2ui5/node-runtime': version, '@abaplint/transpiler-cli': '2.13.91', express: '5.2.1', '@abaplint/cli': '2.120.60' },
  }));
  const core = path.join(workspace, 'open-abap-core', CORE_SHA);
  write(path.join(core, 'src', 'cl_abap_unit_assert.clas.abap'), '* fake\n');
  write(path.join(core, '.abap2ui5-mcp-sha'), `${CORE_SHA}\n`);
  return dir;
}

/** A fake app-template: the probe file, a config with the rules this server
 *  retargets, and the lockfile that pins the lint's abaplint. */
export function fakeTemplate(root) {
  write(path.join(root, 'abaplint.jsonc'), `{
    // the template's own comments
    "global": { "files": "/src/**/*.*" },
    "dependencies": [{ "url": "https://github.com/abap2UI5/abap2UI5", "branch": "1.145.0", "files": "/src/**/*.*" }],
    "syntax": { "version": "v750", "errorNamespace": "^(Z|Y)" },
    "rules": { "check_syntax": true, "object_naming": { "clas": "^ZCL_", "intf": "^ZIF_" } }
  }`);
  write(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@abaplint/cli': { version: '2.120.60' } } }));
  return root;
}

export const APP = (cls) => `CLASS ${cls} DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES z2ui5_if_app. ENDCLASS.\nCLASS ${cls} IMPLEMENTATION. METHOD z2ui5_if_app~main. ENDMETHOD. ENDCLASS.`;
export const TESTS = (fail = false) => `CLASS ltcl DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT. ENDCLASS. " ${fail ? 'FAIL' : 'ok'}`;
