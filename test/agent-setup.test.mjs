// add_agent_setup - app-template's agent setup, added to a project that
// already exists (lib/agent-setup.mjs).
//
// Sibling-free: the template is a fake checkout built in a temp dir (the
// shape of app-template's template.json, `agentSetup` included) and pointed
// at through APP_TEMPLATE_HOME, and every project is a temp dir. The tool is
// driven over stdio, so the handler's argument handling, refusals and result
// shape are what is tested. The last test holds this planner against the
// template's own (create/agent-setup.mjs) over the same projects, and skips
// itself without an app-template checkout beside this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  startingFolder, adaptSourceFolder, mergePackageJson, mergeLines, planAgentSetup, checkSetupPaths, packageNameFor,
  agentTargetProblem, pathWithin,
} from '../lib/agent-setup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const write = (base, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `a2ui5-agent-setup-${tag}-`));

const TEMPLATE_PKG = {
  name: 'abap2ui5-app',
  private: true,
  version: '1.0.0',
  description: 'the template',
  scripts: {
    check: 'npm run check:abap && npm run check:abap2ui5',
    'check:abap': 'abaplint abaplint.jsonc',
    'check:abap2ui5': 'abap2ui5lint',
    'check:pin': 'node scripts/check-pin.mjs',
    'test:unit': 'npx --yes -p @abap2ui5/mcp-server abap2ui5-unit src',
  },
  license: 'MIT',
  devDependencies: { '@abap2ui5/linter': '^0.8.3', '@abaplint/cli': '^2.120.60' },
  engines: { node: '>=22' },
};

const AGENT_FILES = [
  'AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.claude/skills/build-an-app/SKILL.md', '.mcp.json',
  'abaplint.jsonc', 'abap2ui5lint.jsonc', 'package.json', '.gitignore', '.github/workflows/check.yml',
];

/** A fake app-template checkout: template.json in the real shape, and the
 *  files it lists. `edit` changes the spec before it is written. */
function fakeTemplate(edit = (s) => s) {
  const base = tmp('template');
  const spec = edit({
    placeholderClass: 'zcl_app_001',
    files: {
      shared: [...AGENT_FILES, 'package-lock.json'],
      named: ['.abapgit.xml', 'src/package.devc.xml', 'src/zcl_app_001.clas.abap'],
    },
    substitutions: { class: { files: [], renamesPath: true }, packageText: [], repo: [] },
    agentSetup: {
      files: Object.fromEntries(AGENT_FILES.map((f) => [f, 'why'])),
      leftOut: { 'package-lock.json': 'locks the template' },
      merge: {
        'package.json': { how: 'json', keys: ['scripts', 'devDependencies', 'engines'] },
        '.gitignore': { how: 'lines' },
      },
      sourceFolder: {
        placeholder: 'src',
        edits: [
          { file: 'abaplint.jsonc', text: '"files": "/src/**/*.*"' },
          { file: 'abap2ui5lint.jsonc', text: '"paths": ["src"]' },
          { file: '.github/workflows/check.yml', text: 'paths: src' },
          { file: 'package.json', text: 'abap2ui5-unit src' },
        ],
      },
      existingVariants: { files: { 'abaplint.jsonc': ['abaplint.json'] } },
    },
  });
  write(base, 'template.json', JSON.stringify(spec, null, 2));
  write(base, 'AGENTS.md', '# AGENTS.md\n\nThe template\'s app-building reference.\n');
  write(base, 'CLAUDE.md', 'Read AGENTS.md.\n');
  write(base, '.claude/settings.json', '{ "permissions": { "allow": ["Bash(npm run check)"] } }\n');
  write(base, '.claude/skills/build-an-app/SKILL.md', '---\nname: build-an-app\n---\n');
  write(base, '.mcp.json', '{ "mcpServers": { "abap2ui5": { "command": "npx" } } }\n');
  write(base, 'abaplint.jsonc', '{\n  "global": {\n    "files": "/src/**/*.*"\n  },\n  "dependencies": [\n    {\n      "url": "https://github.com/abap2UI5/abap2UI5",\n      "files": "/src/**/*.*"\n    }\n  ]\n}\n');
  write(base, 'abap2ui5lint.jsonc', '{\n  "paths": ["src"],\n  "ui5": "1.71"\n}\n');
  write(base, 'package.json', `${JSON.stringify(TEMPLATE_PKG, null, 2)}\n`);
  write(base, '.gitignore', '# the gates\nnode_modules/\n\n# the browser\n.playwright/\n');
  write(base, '.github/workflows/check.yml', 'jobs:\n  unit:\n    with:\n      paths: src\n');
  write(base, 'package-lock.json', '{}\n');
  write(base, '.abapgit.xml', '<STARTING_FOLDER>/src/</STARTING_FOLDER>\n');
  write(base, 'src/package.devc.xml', '<CTEXT>x</CTEXT>\n');
  write(base, 'src/zcl_app_001.clas.abap', 'CLASS zcl_app_001 DEFINITION PUBLIC.\nENDCLASS.\n');
  return base;
}

/** An existing abapGit project: classes in `folder`, plus whatever `files`. */
function fakeProject(folder = 'src', files = {}) {
  const base = tmp('project');
  fs.mkdirSync(path.join(base, '.git'));
  write(base, '.abapgit.xml', `<?xml version="1.0"?>\n<asx:abap><STARTING_FOLDER>/${folder}/</STARTING_FOLDER></asx:abap>\n`);
  write(base, `${folder}/zcl_mine.clas.abap`, 'CLASS zcl_mine DEFINITION PUBLIC.\nENDCLASS.\n');
  for (const [rel, text] of Object.entries(files)) write(base, rel, text);
  return base;
}

/** Every file under `dir` with its bytes - to prove what a call did not touch. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

async function withServer(template, fn, { cwd } = {}) {
  const nowhere = path.join(template, 'nowhere');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'server.mjs')],
    cwd,
    env: {
      ...process.env,
      APP_TEMPLATE_HOME: template,
      A2UI5_HOME: nowhere,
      SAMPLES_HOME: nowhere,
      SAMPLES_CONTROLS_HOME: nowhere,
      AI_DEMOKIT_HOME: '',
      SAMPLES_STACK_HOME: nowhere,
      AI_VIEW_CHECK_HOME: nowhere,
      DOCS_HOME: nowhere,
      A2UI5_MCP_REMOTE: '0',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'agent-setup', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(async (args) => {
      const r = await client.callTool({ name: 'add_agent_setup', arguments: args });
      const t = r.content[0].text;
      return r.isError ? { error: t } : JSON.parse(t);
    });
  } finally {
    await client.close();
  }
}

const paths = (list) => list.map((e) => e.path).sort();

// ------------------------------------------------------------- the units ----

test('STARTING_FOLDER: the folder, the root, or nothing said', () => {
  assert.equal(startingFolder('<STARTING_FOLDER>/abap/src/</STARTING_FOLDER>'), 'abap/src');
  assert.equal(startingFolder('<STARTING_FOLDER>/src/</STARTING_FOLDER>'), 'src');
  assert.equal(startingFolder('<STARTING_FOLDER>/</STARTING_FOLDER>'), '');
  assert.equal(startingFolder('<asx:abap/>'), null);
  assert.equal(startingFolder(undefined), null);
});

test('the source folder is replaced inside the FIRST occurrence only', () => {
  const sf = { placeholder: 'src', edits: [{ file: 'abaplint.jsonc', text: '"files": "/src/**/*.*"' }] };
  const text = '{ "global": { "files": "/src/**/*.*" }, "dependencies": [{ "files": "/src/**/*.*" }] }';
  const out = adaptSourceFolder('abaplint.jsonc', text, sf, 'abap/src');
  assert.equal(out, '{ "global": { "files": "/abap/src/**/*.*" }, "dependencies": [{ "files": "/src/**/*.*" }] }');
  assert.equal(adaptSourceFolder('abaplint.jsonc', text, sf, 'src'), text, 'the template\'s own folder changes nothing');
  assert.equal(adaptSourceFolder('other.json', text, sf, 'abap'), text, 'a file no edit names changes nothing');
  assert.match(adaptSourceFolder('abaplint.jsonc', text, sf, 'a$&b'), /"\/a\$&b\/\*\*/, 'the folder is a value, never a replacement pattern');
});

test('package.json only gains entries, keeps every value it has, and keeps its indentation', () => {
  const existing = `${JSON.stringify({ name: 'mine', scripts: { check: 'my own' }, dependencies: { '@abaplint/cli': '2.0.0' } }, null, 4)}\n`;
  const r = mergePackageJson(existing, JSON.stringify(TEMPLATE_PKG), ['scripts', 'devDependencies', 'engines']);
  const pkg = JSON.parse(r.text);
  assert.equal(pkg.scripts.check, 'my own', 'a script the project has keeps its value');
  assert.equal(pkg.scripts['check:abap'], 'abaplint abaplint.jsonc');
  assert.equal(pkg.devDependencies['@abap2ui5/linter'], '^0.8.3');
  assert.equal(pkg.devDependencies['@abaplint/cli'], undefined, 'a runtime dependency counts as present');
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.license, undefined, 'only the merge keys are taken - the license is the template\'s');
  assert.match(r.text, /^ {4}"name"/m, 'four spaces stay four spaces');
  assert.deepEqual(r.kept.map((k) => k.entry).sort(), ['devDependencies.@abaplint/cli', 'scripts.check']);
  assert.equal(mergePackageJson(r.text, JSON.stringify(TEMPLATE_PKG), ['scripts', 'devDependencies', 'engines']).text, null,
    'a second merge adds nothing');
  assert.throws(() => mergePackageJson('{ nope', '{}', ['scripts']));
});

test('.gitignore gains the missing patterns with their comments, nothing reordered', () => {
  const tpl = '# the gates\nnode_modules/\n\n# the browser\n.playwright/\n';
  const r = mergeLines('/node_modules\n*.log', tpl);
  assert.equal(r.text, '/node_modules\n*.log\n\n# the browser\n.playwright/\n');
  assert.deepEqual(r.added, ['.playwright/']);
  assert.equal(mergeLines(r.text, tpl).text, null);
});

test('a project without package.json is named after its directory', () => {
  assert.equal(packageNameFor('/x/My Project'), 'my-project');
  assert.equal(packageNameFor('/x/.hidden'), 'hidden');
});

test('the template\'s paths are checked before anything is read', () => {
  const spec = (files, extra = {}) => ({
    files: { shared: ['AGENTS.md', ...Object.keys(files)], named: ['src/zcl_app_001.clas.abap'], ...extra },
    agentSetup: { files },
  });
  assert.doesNotThrow(() => checkSetupPaths(spec({ 'AGENTS.md': '' }), 'src'));
  assert.throws(() => checkSetupPaths(spec({ '../escape': '' }), 'src'), /not a plain path/);
  assert.throws(() => checkSetupPaths(spec({ '/etc/passwd': '' }), 'src'), /not a plain path/);
  assert.throws(() => checkSetupPaths({ files: { shared: [], named: [] }, agentSetup: { files: { 'AGENTS.md': '' } } }, 'src'),
    /not one of the template's shared files/);
  assert.throws(() => checkSetupPaths(spec({ 'src/x.txt': '' }), 'src'), /source folder/);
  assert.throws(() => checkSetupPaths(spec({ 'abap/x.txt': '' }), 'abap'), /source folder/);
});

// ------------------------------------------------------- over stdio ----

test('a fresh directory gets the whole agent setup, package.json under its own name', async () => {
  const template = fakeTemplate();
  const project = tmp('fresh');
  fs.mkdirSync(path.join(project, '.git'));
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: project });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.dryRun, false);
      assert.equal(r.project, path.resolve(project));
      assert.deepEqual(paths(r.written), [...AGENT_FILES].sort());
      assert.deepEqual(r.merged, []);
      assert.deepEqual(r.skipped, []);
      assert.equal(r.sources.folder, 'src/');
      assert.match(r.sources.from, /no \.abapgit\.xml/);
      assert.ok(r.warnings.some((w) => /src\/ does not exist/.test(w)), 'a missing source folder is said');
      assert.ok(r.next.some((n) => /npm install/.test(n)) && r.next.some((n) => /npm run check/.test(n)));
      assert.ok(r.next.some((n) => /AGENTS\.md's first section/.test(n)), 'a written AGENTS.md comes with the rewrite note');

      const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
      assert.equal(pkg.name, packageNameFor(project));
      assert.equal(pkg.private, true);
      assert.equal(pkg.description, undefined, 'not the template\'s package.json');
      assert.equal(pkg.scripts['check:abap'], 'abaplint abaplint.jsonc');
      assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(template, 'AGENTS.md'), 'utf8'));
      assert.ok(!fs.existsSync(path.join(project, 'package-lock.json')), 'a leftOut file is not written');
      assert.ok(!fs.existsSync(path.join(project, 'src')), 'nothing named, nothing in the source folder');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('an existing project: its files are skipped, package.json and .gitignore merged, every kept value named', async () => {
  const template = fakeTemplate();
  const ownAgents = '# My own AGENTS.md\n';
  const project = fakeProject('src', {
    'AGENTS.md': ownAgents,
    'abaplint.json': '{}\n',
    'package.json': `${JSON.stringify({ name: 'mine', scripts: { check: 'my own check' }, devDependencies: { '@abap2ui5/linter': '^0.7.0' } }, null, 2)}\n`,
    '.gitignore': 'node_modules\n',
  });
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: project });
      assert.equal(r.error, undefined, r.error);
      assert.deepEqual(paths(r.skipped), ['AGENTS.md']);
      assert.match(r.skipped[0].reason, /already there/);
      assert.deepEqual(paths(r.merged), ['.gitignore', 'package.json']);
      const pkgMerge = r.merged.find((m) => m.path === 'package.json');
      assert.ok(pkgMerge.added.includes('scripts.check:abap') && !pkgMerge.added.includes('scripts.check'));
      assert.deepEqual(r.merged.find((m) => m.path === '.gitignore').added, ['.playwright/']);
      assert.ok(!r.next.some((n) => /AGENTS\.md's first section/.test(n)), 'no rewrite note for an AGENTS.md left alone');

      assert.ok(r.warnings.some((w) => /kept your scripts\.check "my own check"/.test(w)));
      assert.ok(r.warnings.some((w) => /kept your devDependencies\.@abap2ui5\/linter "\^0\.7\.0"/.test(w)));
      assert.ok(r.warnings.some((w) => /has abaplint\.json, and now abaplint\.jsonc/.test(w)));
      assert.equal(r.sources.from, '.abapgit.xml STARTING_FOLDER');

      assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), ownAgents, 'never overwritten');
      const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
      assert.equal(pkg.name, 'mine');
      assert.equal(pkg.scripts.check, 'my own check');
      assert.equal(pkg.devDependencies['@abap2ui5/linter'], '^0.7.0');
      assert.equal(pkg.devDependencies['@abaplint/cli'], '^2.120.60');
      assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), 'node_modules\n\n# the browser\n.playwright/\n');
      assert.equal(fs.readFileSync(path.join(project, 'src/zcl_mine.clas.abap'), 'utf8'), 'CLASS zcl_mine DEFINITION PUBLIC.\nENDCLASS.\n');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('another STARTING_FOLDER: the gates, the CI job and the unit script point there, the dependency folder stays', async () => {
  const template = fakeTemplate();
  const project = fakeProject('abap/src');
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: project });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.sources.folder, 'abap/src/');
      for (const f of ['abaplint.jsonc', 'abap2ui5lint.jsonc', '.github/workflows/check.yml', 'package.json']) {
        assert.equal(r.written.find((w) => w.path === f)?.detail, 'sources: abap/src/', `${f} says it was adapted`);
      }
      assert.ok(!r.warnings.some((w) => /does not exist/.test(w)));
      const lint = fs.readFileSync(path.join(project, 'abaplint.jsonc'), 'utf8');
      assert.match(lint, /"files": "\/abap\/src\/\*\*\/\*\.\*"/);
      assert.equal(lint.match(/"files": "\/src\/\*\*\/\*\.\*"/g).length, 1, 'the framework dependency keeps its own folder');
      assert.match(fs.readFileSync(path.join(project, 'abap2ui5lint.jsonc'), 'utf8'), /"paths": \["abap\/src"\]/);
      assert.match(fs.readFileSync(path.join(project, '.github/workflows/check.yml'), 'utf8'), /paths: abap\/src/);
      assert.match(JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).scripts['test:unit'], /abap2ui5-unit abap\/src$/);
      assert.ok(!fs.existsSync(path.join(project, 'src')), 'the template\'s src/ is not created');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a STARTING_FOLDER at the repository root leaves the gates on src/ and says so', async () => {
  const template = fakeTemplate();
  const project = tmp('rootfolder');
  write(project, '.abapgit.xml', '<STARTING_FOLDER>/</STARTING_FOLDER>\n');
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: project });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.sources.folder, 'src/');
      assert.ok(r.warnings.some((w) => /repository root/.test(w)));
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('idempotent: a second run writes nothing and changes no byte; dry_run writes nothing either', async () => {
  const template = fakeTemplate();
  const project = fakeProject('src', { '.gitignore': 'dist/\n' });
  try {
    await withServer(template, async (call) => {
      const before = snapshot(project);
      const dry = await call({ project_dir: project, dry_run: true });
      assert.equal(dry.error, undefined, dry.error);
      assert.equal(dry.dryRun, true);
      assert.deepEqual(snapshot(project), before, 'dry_run touched the project');
      assert.match(dry.next[0], /without dry_run/);

      const first = await call({ project_dir: project });
      assert.deepEqual(paths(first.written), paths(dry.written), 'dry_run announced exactly what the run wrote');
      assert.deepEqual(paths(first.merged), paths(dry.merged));
      const after = snapshot(project);

      const second = await call({ project_dir: project });
      assert.deepEqual(second.written, []);
      assert.deepEqual(second.merged, []);
      assert.equal(second.skipped.length, AGENT_FILES.length);
      assert.match(second.summary, /already complete, nothing to do/);
      assert.deepEqual(snapshot(project), after, 'the second run changed a file');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('refusals leave everything as it was', async () => {
  const template = fakeTemplate();
  const notDir = path.join(template, 'nowhere-file');
  fs.writeFileSync(notDir, 'x');
  const broken = fakeProject('src', { 'package.json': '{ not json' });
  const bare = tmp('bare'); // no .git, .abapgit.xml or package.json
  try {
    await withServer(template, async (call) => {
      assert.match((await call({ project_dir: path.join(template, 'missing') })).error, /does not exist .*scaffold_app/);
      assert.match((await call({ project_dir: notDir })).error, /not a directory/);
      assert.match((await call({ project_dir: path.parse(process.cwd()).root })).error, /file system root/);
      assert.match((await call({ project_dir: os.homedir() })).error, /home directory/);
      assert.match((await call({ project_dir: ROOT })).error, /MCP server's own installation/);
      assert.match((await call({ project_dir: template })).error, /app-template checkout/);

      const before = snapshot(broken);
      const r = await call({ project_dir: broken });
      assert.match(r.error, /package\.json is not valid JSON.*nothing was written/);
      assert.deepEqual(snapshot(broken), before, 'a refused plan wrote something');

      // a directory the agent NAMED is taken at its word, as by the create package
      assert.equal((await call({ project_dir: bare, dry_run: true })).error, undefined);
    });
    // the default - the server's working directory - has to look like a project
    await withServer(template, async (call) => {
      assert.match((await call({})).error, /does not look like a project.*project_dir/);
      assert.deepEqual(fs.readdirSync(bare), []);
    }, { cwd: bare });
    fs.mkdirSync(path.join(bare, '.git'));
    await withServer(template, async (call) => {
      const r = await call({ dry_run: true });
      assert.equal(r.error, undefined, r.error);
      assert.equal(fs.realpathSync(r.project), fs.realpathSync(bare));
    }, { cwd: bare });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

/* Windows compares names case-insensitively, and the realpath and homedir
 * it hands back keep whatever case they were given - the home and
 * installation checks compared the strings and let `C:\\USERS\\ME` through
 * as "not the home directory". Judged with path.win32 over a fake Windows
 * disk, so the Windows semantics are pinned on every machine. */
test('the home and forbidden-directory checks fold case under Windows path semantics', () => {
  const win = path.win32;
  const dirs = new Set(['c:\\', 'c:\\users', 'c:\\users\\me', 'c:\\users\\me\\proj', 'c:\\tools', 'c:\\tools\\mcp', 'c:\\tools\\mcp\\lib']);
  const has = (p) => dirs.has(win.normalize(p).toLowerCase().replace(/\\$/, '') || 'c:\\') || dirs.has(win.normalize(p).toLowerCase());
  const host = {
    path: win,
    exists: has,
    isDirectory: has,
    realpath: (p) => { if (!has(p)) throw new Error(`ENOENT ${p}`); return win.normalize(p); }, // keeps the case it was given, as Node's does
    homedir: () => 'C:\\Users\\Me',
    lexists: has,
  };
  const forbidden = [{ dir: 'C:\\Tools\\MCP', what: 'inside this MCP server\'s own installation' }];
  assert.match(agentTargetProblem('c:\\users\\me', { host, forbidden }), /home directory/);
  assert.match(agentTargetProblem('C:\\USERS\\ME\\', { host, forbidden }), /home directory/);
  assert.match(agentTargetProblem('c:\\tools\\mcp\\LIB', { host, forbidden }), /own installation/);
  assert.match(agentTargetProblem('C:\\', { host, forbidden }), /file system root/);
  assert.equal(agentTargetProblem('c:\\Users\\me\\Proj', { host, forbidden }), null);

  assert.equal(pathWithin('C:\\Tools\\MCP', 'c:\\tools\\mcp\\x', win), true);
  assert.equal(pathWithin('C:\\Tools\\MCP', 'c:\\tools\\mcpx', win), false, 'a sibling with a longer name is not inside');
  // POSIX names are case-sensitive: /home/Me is another directory than /home/me
  assert.equal(pathWithin('/home/Me', '/home/me/proj', path.posix), false);
  assert.equal(pathWithin('/home/me', '/home/me/proj', path.posix), true);
});

test('a template that names a path outside the project, or in its source folder, is refused whole', async () => {
  for (const bad of ['../escaped.md', 'src/planted.abap']) {
    const template = fakeTemplate((s) => {
      s.files.shared.push(bad);
      s.agentSetup.files[bad] = 'planted';
      return s;
    });
    const project = fakeProject('src');
    const before = snapshot(project);
    try {
      await withServer(template, async (call) => {
        const r = await call({ project_dir: project });
        assert.match(r.error, /nothing was written/, bad);
        assert.deepEqual(snapshot(project), before, `${bad}: the project was touched`);
        assert.ok(!fs.existsSync(path.join(project, '..', 'escaped.md')));
      });
    } finally {
      fs.rmSync(template, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }
});

test('a symbolic link is never written through', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const template = fakeTemplate();
  const project = fakeProject('src');
  const outside = tmp('outside');
  fs.symlinkSync(outside, path.join(project, '.claude'));
  fs.symlinkSync(path.join(outside, 'dangling.md'), path.join(project, 'CLAUDE.md'));
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: project });
      assert.equal(r.error, undefined, r.error);
      const skipped = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
      assert.match(skipped['CLAUDE.md'], /symbolic link/);
      assert.match(skipped['.claude/settings.json'], /outside the project/);
      assert.match(skipped['.claude/skills/build-an-app/SKILL.md'], /outside the project/);
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing landed outside the project');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the pin check runs the template\'s own check-pin.mjs over the finished project, and only that file', async () => {
  const template = fakeTemplate((s) => {
    s.files.shared.push('scripts/check-pin.mjs');
    s.agentSetup.files['scripts/check-pin.mjs'] = 'check.yml runs it';
    return s;
  });
  write(template, 'scripts/check-pin.mjs', [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'export function readPinSites(root) {',
    '  const ok = /"branch"/.test(fs.readFileSync(path.join(root, "abaplint.jsonc"), "utf8"));',
    '  return { problems: ok ? [] : ["abaplint.jsonc: no release number found"] };',
    '}',
    '',
  ].join('\n'));
  const fresh = fakeProject('src');
  const own = fakeProject('src', { 'scripts/check-pin.mjs': 'throw new Error("never imported");\n' });
  try {
    await withServer(template, async (call) => {
      const r = await call({ project_dir: fresh });
      assert.equal(r.error, undefined, r.error);
      const pin = r.warnings.find((w) => /check:pin/.test(w));
      assert.match(pin, /the first step of check\.yml.*no release number found/, 'the template\'s check:pin, the project\'s problem');
      const dry = await call({ project_dir: own, dry_run: true });
      assert.ok(!dry.warnings.some((w) => /check:pin/.test(w)), 'a dry run checks no pin');
      const kept = await call({ project_dir: own });
      assert.equal(kept.error, undefined, kept.error);
      assert.ok(!kept.warnings.some((w) => /check:pin/.test(w)), 'a project\'s own check-pin.mjs is never run');
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.rmSync(own, { recursive: true, force: true });
  }
});

test('a template checkout without agentSetup is reported, not guessed at', async () => {
  const template = fakeTemplate((s) => {
    delete s.agentSetup;
    return s;
  });
  const project = fakeProject('src');
  try {
    await withServer(template, async (call) => {
      assert.match((await call({ project_dir: project })).error, /without agentSetup.*git pull/);
    });
  } finally {
    fs.rmSync(template, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

// ------------------------------------------- against the template's own ----

/* The create package (create/agent-setup.mjs) is the template's own executor
 * of agentSetup; this server is a second one. Same template, same project,
 * same plan - action by action and byte by byte, warnings included. */
test('the plan is the one `npm create abap2ui5-app -- --agent-setup` makes', async (t) => {
  const root = path.join(ROOT, '..', 'app-template');
  const theirs = path.join(root, 'create', 'agent-setup.mjs');
  if (!fs.existsSync(theirs) || !fs.existsSync(path.join(root, 'template.json'))) {
    t.skip('no app-template checkout with create/agent-setup.mjs beside this repository');
    return;
  }
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'template.json'), 'utf8'));
  if (!spec.agentSetup) {
    t.skip('the app-template checkout predates agentSetup');
    return;
  }
  const create = await import(pathToFileURL(theirs).href);
  const read = async (rel) => fs.readFileSync(path.join(root, rel));
  const projects = [
    tmp('parity-fresh'),
    fakeProject('src'),
    fakeProject('abap/src', {
      'AGENTS.md': '# mine\n',
      'abaplint.json': '{}\n',
      'package.json': '{\n    "name": "mine",\n    "scripts": { "check": "x" },\n    "dependencies": { "@abaplint/cli": "1.0.0" }\n}\n',
      '.gitignore': 'node_modules/\n',
    }),
  ];
  const root2 = tmp('parity-rootfolder');
  write(root2, '.abapgit.xml', '<STARTING_FOLDER>/</STARTING_FOLDER>\n');
  projects.push(root2);
  const shape = (plan) => ({
    folder: plan.folder,
    from: plan.from,
    warnings: plan.warnings,
    actions: plan.actions.map((a) => ({ path: a.path, kind: a.kind, detail: a.detail, added: a.added, bytes: a.bytes?.toString('base64') })),
  });
  try {
    for (const dir of projects) {
      assert.deepEqual(shape(await planAgentSetup(spec, read, dir)), shape(await create.planAgentSetup(spec, read, dir)), dir);
    }
  } finally {
    for (const dir of projects) fs.rmSync(dir, { recursive: true, force: true });
  }
});
