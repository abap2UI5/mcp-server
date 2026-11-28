// verify_project's lint: the project's own abaplint.jsonc, found upwards from
// the folder, retargeted at the sandbox with its naming kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectLintConfig, frameworkLintConfig } from '../lib/lint.mjs';

const CONFIG = `{
  // a project's config
  "global": { "files": "/src/**/*.*", "exclude": ["/test/"] },
  "dependencies": [
    { "url": "https://github.com/abap2UI5/abap2UI5", "folder": "/deps", "files": "/src/**/*.*" },
    { "url": "https://github.com/abap2UI5-addons/popups", "folder": "/deps2", "files": "/src/**/*.*" },
  ],
  "syntax": { "version": "v702" },
  "rules": { "object_naming": { "clas": "^ZCL_PDF" } }
}`;

test('the config is found in the folder or above it, up to the repository root', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src', '01'), { recursive: true });
  assert.equal(projectLintConfig(path.join(repo, 'src', '01')), null, 'none up to the .git');
  fs.writeFileSync(path.join(repo, 'abaplint.jsonc'), CONFIG);
  const found = projectLintConfig(path.join(repo, 'src', '01'));
  assert.equal(found.file, path.join(repo, 'abaplint.jsonc'));
  assert.deepEqual(found.otherDependencies, ['https://github.com/abap2UI5-addons/popups']);
});

test('retargeted: the sandbox as the files, the framework as the one dependency, the naming kept', () => {
  const cfg = frameworkLintConfig(CONFIG, { files: '/sandbox/**/*.*', folder: '/rt/downport', keepNaming: true });
  assert.equal(cfg.global.files, '/sandbox/**/*.*');
  assert.equal(cfg.global.exclude, undefined);
  assert.deepEqual(cfg.dependencies, [{ folder: '/rt/downport', files: '/**/*.*' }]);
  assert.equal(cfg.syntax.version, 'v702');
  assert.equal(cfg.rules.object_naming.clas, '^ZCL_PDF');
  assert.equal(frameworkLintConfig(CONFIG, { files: '/s/**/*.*', folder: '/d' }).rules.object_naming.clas, '^[ZY]', 'the template lint relaxes it');
});
