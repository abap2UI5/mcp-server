/*
 * project — the abap2UI5 project this server was started in, and what it pins.
 *
 * WHY: an MCP client starts a stdio server in the project directory (Claude
 * Code, Cursor and VS Code all do), and that project says which framework
 * release its code is written against: the `branch` of the abap2UI5
 * dependency in its abaplint.jsonc - the release its lint resolves against -
 * and which @abaplint/cli its gate runs (package-lock.json). `abap2ui5-unit`
 * always read the first; the server did not, so build_backend and run_app
 * took the registry's latest: a project pinned to 1.149.0 was linted against
 * 1.149.0 and booted on 1.151.0. Now both read the pin here.
 *
 * The directory: A2UI5_MCP_PROJECT_DIR, else the working directory the client
 * started the server in. No abaplint.jsonc there (a framework checkout, a
 * home directory) or no abap2UI5 dependency in it: no pin, and everything is
 * as before.
 */

import fs from 'fs';
import path from 'path';
import { stripJsonc } from './lint.mjs';

/** The first release @abap2ui5/node-runtime was published for. A project
 *  pinned to an older one runs on the registry's latest (setup_status says
 *  so) - the npm backend has nothing older to install. */
export const FIRST_RUNTIME_RELEASE = '1.145.0';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** The directory of the project: A2UI5_MCP_PROJECT_DIR, else the cwd. */
export function projectDir(env = process.env) {
  const explicit = String(env.A2UI5_MCP_PROJECT_DIR || '').trim();
  return path.resolve(explicit || process.cwd());
}

/** The release tag the project pins the framework at, out of its
 *  abaplint.jsonc: the `branch` of the dependency whose url names
 *  abap2UI5/abap2UI5. Null when unpinned or absent. Pure. */
export function frameworkPinOf(abaplintJsonc) {
  let cfg;
  try {
    cfg = JSON.parse(stripJsonc(abaplintJsonc));
  } catch {
    return null;
  }
  const dep = ((cfg && cfg.dependencies) || []).find((d) => /github\.com\/abap2ui5\/abap2ui5(\.git)?\/?$/i.test(String((d && d.url) || '')));
  const branch = dep && dep.branch;
  return typeof branch === 'string' && VERSION_RE.test(branch) ? branch : null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Numeric X.Y.Z order; negative when a < b. Pure. */
function compare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The framework release the project pins, for the npm backend:
 * `{ value, file }` for a pin the package exists for, `{ tooOld, file }` for
 * one before FIRST_RUNTIME_RELEASE, `{}` when the project pins nothing.
 */
export function projectRuntimePin(env = process.env) {
  const file = path.join(projectDir(env), 'abaplint.jsonc');
  const text = readText(file);
  const pin = text === null ? null : frameworkPinOf(text);
  if (!pin) return {};
  return compare(pin, FIRST_RUNTIME_RELEASE) < 0 ? { tooOld: pin, file } : { value: pin, file };
}

/** The project's package-lock.json and package.json as text (null when
 *  absent) - where its @abaplint/cli pin is read from. */
export function projectPinFiles(env = process.env) {
  const dir = projectDir(env);
  return { lockText: readText(path.join(dir, 'package-lock.json')), pkgText: readText(path.join(dir, 'package.json')) };
}
