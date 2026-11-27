/*
 * deploy - an app class into the dev sandbox and out of it again (split out
 * of lib/runtime.mjs, which re-exports it): the class-name gate, deployApp /
 * removeApp, the dev copies a framework checkout's sandbox carries, the
 * fingerprint that lets an unchanged checkout build answer at once, and the
 * readers of what is deployed (readAppSource, listDevApps).
 */
import fs from 'fs';
import path from 'path';
import { downportDir, buildFingerprint, installedVersion } from './npm-backend.mjs';
import { resolvedInside, writeNoFollow } from './contain.mjs';
import { a2Local, backendKind, npmRuntimeDir, sandbox, devDir } from './sandbox.mjs';
import { builtMarkerFile } from './build.mjs';

// ---------------------------------------------------------------- deploy ----

/*
 * What a deployable app class may be called: a plain ABAP class name in the
 * CUSTOMER namespace, at most the 30 characters ABAP allows.
 *
 * It used to be `^z2ui5_cl_[a-z0-9_]+$`, which is the naming convention of the
 * demo-kit PORTS - and this server exists for an agent building its OWN app.
 * The ecosystem's own starting point, abap2UI5/app-template, ships
 * `zcl_app_001`; every tool here refused it, so an agent that followed the
 * recommended path could not deploy, build or look at the thing it had just
 * been told to write. `z`/`y` is the real rule (SAP reserves everything else),
 * and it is what the repo's abaplint config is relaxed to in devLintConfig( ).
 *
 * The safety property the regex carries is unchanged and is the reason it is a
 * whitelist rather than a blacklist: every caller-supplied name becomes a PATH
 * under the dev sandbox, and this is validated BEFORE it is joined. The
 * character class admits no `/`, `\`, `.`, null byte or space, so
 * `../../src/01/z2ui5_cl_x` is rejected as a name rather than escaping
 * src/zz_dev as a path. Shared by deploy and remove - the write path and the
 * delete path must not disagree about what a legal name is.
 */
const CLASS_RE = /^[zy][a-z0-9_]*$/;
const CLASS_MAX = 30;

/* Exported for abap2ui5-unit, which puts a project's classes and interfaces
 * into a sandbox under the same gate: a name that is a path is refused. */
export function classNameOf(className) {
  const cls = String(className || '').toLowerCase();
  if (!CLASS_RE.test(cls) || cls.length > CLASS_MAX) {
    throw new Error(
      `invalid class name '${String(className ?? '').slice(0, 80)}' — must be a plain ABAP class name in the customer namespace: `
      + `${CLASS_RE} (letters, digits and underscores only, starting z or y) and <= ${CLASS_MAX} chars. `
      + 'e.g. zcl_my_app, z2ui5_cl_my_app',
    );
  }
  return cls;
}

/*
 * Where the objects a dev app must not share its name with are defined, per
 * sandbox home. The customer namespace classNameOf( ) admits is not the dev
 * apps' alone: the framework's own z2ui5_* classes are in it, and so is the
 * ICF handler every host boots (zcl_sicf, in node/srv). A dev app of such a
 * name is no app of its own - the build puts it beside the original, where
 * the second copy either fails the transpile or quietly replaces the
 * framework's class in the output the host serves. So the name is refused at
 * deploy, where the reason can still be said:
 *
 *   npm        the release's downport/ - the ABAP its output was transpiled
 *              from, node/srv folded in
 *   framework  src/ and node/srv/ of the checkout
 *   corpus     the corpus' own src/ (zz_dev, the sandbox itself, aside) and
 *              the framework checkout beside it, when one resolves
 */
function ownObjectRoots(box) {
  const framework = (a2) => [
    { owner: 'the framework\'s', dir: path.join(a2, 'src') },
    { owner: 'the framework\'s', dir: path.join(a2, 'node', 'srv') },
  ];
  if (box.kind === 'npm') {
    const runtime = npmRuntimeDir();
    return runtime ? [{ owner: 'the framework\'s', dir: downportDir(runtime) }] : [];
  }
  if (box.kind === 'framework') return framework(box.root);
  const a2 = a2Local();
  return [{ owner: 'samples-controls\'', dir: path.join(box.root, 'src') }, ...(a2 ? framework(a2) : [])];
}

/** The file that already defines `cls` as a class or an interface, or null. */
function ownObjectOf(cls, box) {
  const names = new Map([[`${cls}.clas.abap`, 'class'], [`${cls}.intf.abap`, 'interface']]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null; // a root that is not there defines nothing
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === box.dir || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const hit = walk(p);
        if (hit) return hit;
      } else if (names.has(e.name)) {
        return { file: p, type: names.get(e.name) };
      }
    }
    return null;
  };
  for (const root of ownObjectRoots(box)) {
    const hit = walk(root.dir);
    if (hit) return { ...hit, owner: root.owner };
  }
  return null;
}

export function deployApp({ className, source, description, testclasses }) {
  const cls = classNameOf(className);
  if (!/z2ui5_if_app/i.test(source)) {
    throw new Error('source does not implement z2ui5_if_app — an abap2UI5 app is a class with `INTERFACES z2ui5_if_app.`');
  }
  if (!new RegExp(`class\\s+${cls}\\s+definition`, 'i').test(source)) {
    throw new Error(`source does not define CLASS ${cls} DEFINITION — class name and file must match`);
  }
  /* The local test classes, optional: the `.clas.testclasses.abap` include
   * abapGit keeps beside the class. Judged the way the class is - it has to
   * contain a test class - so a pasted main source does not land in the
   * include and fail three steps later inside the transpile. */
  const withTests = typeof testclasses === 'string' && testclasses.trim().length > 0;
  if (testclasses !== undefined && testclasses !== null && typeof testclasses !== 'string') {
    throw new Error('testclasses must be a string: the source of the local test classes (`CLASS ltcl_... FOR TESTING`)');
  }
  if (withTests && !/for\s+testing/i.test(testclasses)) {
    throw new Error('testclasses does not define a test class — it needs `CLASS ... DEFINITION ... FOR TESTING` (see app_guide, chapter 9)');
  }
  const box = sandbox();
  const own = ownObjectOf(cls, box);
  if (own) {
    throw new Error(`${cls} is ${own.owner} own ${own.type} (${own.file}) - a dev app of that name would be a second copy `
      + 'of it beside the original, and the build either fails on the pair or serves yours in its place. Choose another name, '
      + 'e.g. zcl_my_app');
  }
  fs.mkdirSync(box.dir, { recursive: true });
  /* The name gate stops a path in the NAME; this stops a symbolic link in
   * the sandbox itself. The corpus sandbox is src/zz_dev of a checkout, which
   * is untrusted content - a hostile checkout can ship zz_dev/x.clas.abap as a
   * link to a file elsewhere, and the write would clobber that file through
   * the link. A target that resolves outside box.dir is refused
   * (lib/remote.mjs resolvedInside). */
  const sandboxPath = (name) => {
    const at = path.join(box.dir, name);
    if (!resolvedInside(box.dir, at)) {
      throw new Error(`refusing to write ${name} - it resolves, through a symbolic link, outside the dev sandbox ${box.dir}; `
        + 'remove the link (the sandbox is meant to hold plain files this server writes)');
    }
    return at;
  };
  /* and each write opens with O_NOFOLLOW (lib/contain.mjs writeNoFollow):
   * a link in the last component - dangling, or put there after the check -
   * fails the write instead of redirecting it */
  const abapPath = sandboxPath(`${cls}.clas.abap`);
  writeNoFollow(abapPath, source.endsWith('\n') ? source : source + '\n');
  const testPath = sandboxPath(`${cls}.clas.testclasses.abap`);
  if (withTests) writeNoFollow(testPath, testclasses.endsWith('\n') ? testclasses : testclasses + '\n');
  else fs.rmSync(testPath, { force: true }); // a redeploy without tests must not keep stale ones
  /* The default names the class. It used to be the constant 'MCP dev app',
   * and abaplint's identical_descriptions (on in app-template's config, the
   * lint of the framework sandbox) then failed every second dev app - so
   * verify_app stopped at deploy for an app with nothing wrong with it. */
  const desc = String(description || `MCP dev app ${cls}`).slice(0, 60).replace(/[<>&]/g, ' ');
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">`,
    ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">`,
    `  <asx:values>`,
    `   <VSEOCLASS>`,
    `    <CLSNAME>${cls.toUpperCase()}</CLSNAME>`,
    `    <LANGU>E</LANGU>`,
    `    <DESCRIPT>${desc}</DESCRIPT>`,
    `    <STATE>1</STATE>`,
    `    <CLSCCINCL>X</CLSCCINCL>`,
    `    <FIXPT>X</FIXPT>`,
    `    <UNICODE>X</UNICODE>`,
    // what abapGit writes for a class that carries local test classes
    ...(withTests ? [`    <WITH_UNIT_TESTS>X</WITH_UNIT_TESTS>`] : []),
    `   </VSEOCLASS>`,
    `  </asx:values>`,
    ` </asx:abap>`,
    `</abapGit>`,
    ``,
  ].join('\n');
  // abapGit serializes its XML with a UTF-8 byte order mark, app-template's
  // abaplint.jsonc enables xml_bom, and the sidecar this writes used to have
  // none - the first deploy into the framework sandbox failed its own lint on
  // exactly that (the corpus config never asked)
  writeNoFollow(sandboxPath(`${cls}.clas.xml`), '\uFEFF' + xml);
  return { abapPath, class: cls, testclassesPath: withTests ? testPath : null };
}

export function removeApp(className) {
  const cls = classNameOf(className);
  let removed = 0;
  /* Every file of the class, not three suffixes: migrate_report's deploy and
   * abap2ui5-unit write a class with all of its includes (locals_imp,
   * locals_def, macros), and a removed class whose include stayed behind was
   * still an object of the sandbox - gone from the deployed-apps list, still
   * in the next build's input, an include without its class. The name passed
   * classNameOf, so it holds no dot: `<cls>.clas.` is this class alone. */
  const dir = devDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    /* no sandbox directory yet: nothing deployed */
  }
  for (const f of names) {
    if (!f.toLowerCase().startsWith(`${cls}.clas.`)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  // and the copies the incremental build made of them, so the next build
  // does not transpile a class that is no longer deployed. The npm backend
  // keeps no copies: its build reads the sandbox itself and rebuilds apps/
  // whole, which takes a removed app out of it.
  const a2 = a2Local();
  if (a2 && backendKind() === 'checkout') syncDevCopies(a2, { copy: false });
  return removed;
}

/*
 * The dev apps' copies inside the framework's node/downport - what the
 * incremental transpile actually reads.
 *
 * The build used to copy the sandbox in and never take anything out. So
 * after remove_app the class was still in node/downport and build_backend
 * kept failing on it (or kept serving it); a redeploy WITHOUT testclasses
 * left the old `.clas.testclasses.abap` there and its tests kept running;
 * and abap2ui5-unit, which promises to leave a developer's checkout as it
 * found it, left every class it had tested behind.
 *
 * node/downport is also where the framework's OWN downported sources live
 * (at its root too: zcl_sicf, the zcl_tst_* apps), so nothing is deleted by
 * name or pattern. A manifest records the files THIS server put there, and
 * only those are ever removed: a copy whose sandbox source is gone is
 * deleted, a file that was there before (the framework's) is overwritten as
 * before but never owned. A copy an older server left behind, identical to
 * what is being copied now, is adopted. The manifest is a dotfile inside
 * node/downport - the transpiler's glob skips dotfiles, and a prebuilt
 * download or a full build, which recreate the directory, take the manifest
 * away together with every copy it lists.
 */
export const DEV_COPIES = '.abap2ui5-mcp-dev-copies.json';
const COPY_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*\.(abap|xml)$/i;

export function syncDevCopies(a2, { copy = true } = {}) {
  const down = path.join(a2, 'node', 'downport');
  if (!fs.existsSync(down)) return { copied: [], removed: [] };
  const manifest = path.join(down, DEV_COPIES);
  let owned = [];
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    // a plain file name in that directory, or it is not ours to delete
    owned = (Array.isArray(m.files) ? m.files : []).filter((f) => typeof f === 'string' && COPY_NAME.test(f));
  } catch {
    /* no manifest yet */
  }
  let dir = null;
  try {
    dir = devDir();
  } catch {
    /* no sandbox at all: every copy is stale */
  }
  // the sandbox's package.devc.xml is not an app: copying it overwrote the
  // framework's own node/downport/package.devc.xml, and nothing reads it
  const present = dir && fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => COPY_NAME.test(f) && f !== 'package.devc.xml')
    : [];
  const removed = [];
  for (const f of owned) {
    if (present.includes(f)) continue;
    fs.rmSync(path.join(down, f), { force: true });
    removed.push(f);
  }
  const keep = new Set(owned.filter((f) => present.includes(f)));
  const copied = [];
  const changed = [];
  if (copy) {
    for (const f of present) {
      const src = path.join(dir, f);
      const dst = path.join(down, f);
      /* the corpus sandbox is checkout content: a file there that is a link
       * out of it is not copied into the build (its target would be read,
       * and transpiled, as an app), and a copy never writes through a link
       * in node/downport (lib/contain.mjs) */
      if (!resolvedInside(dir, src) || !resolvedInside(down, dst)) continue;
      const text = fs.readFileSync(src);
      /* a copy that already holds these bytes is left untouched - its
       * mtime is part of the build fingerprint below (checkoutFingerprint),
       * and a rewrite would make every build look like a change */
      let same = false;
      try {
        same = fs.lstatSync(dst).isFile() && fs.readFileSync(dst).equals(text);
      } catch {
        same = false;
      }
      if (!fs.existsSync(dst) || keep.has(f) || same) keep.add(f);
      if (!same) {
        writeNoFollow(dst, text);
        changed.push(f);
      }
      copied.push(f);
    }
  }
  if (keep.size) {
    fs.writeFileSync(manifest, JSON.stringify({
      note: 'Dev-app copies the abap2UI5 MCP server made from its sandbox; it removes each one again once its source is gone. Nothing else in this directory is listed or touched.',
      files: [...keep].sort(),
    }, null, 2) + '\n');
  } else {
    fs.rmSync(manifest, { force: true });
  }
  return { copied, changed, removed };
}

/* The record of the last incremental build, in the checkout's node/output
 * beside the transpiler's init.mjs: the fingerprint of what it was built
 * from, and the init.mjs it wrote (mtime and size) - a prebuilt download,
 * the framework's own build or a full e2e-build replace that file, and the
 * record is then stale whatever its fingerprint says. */
export const CHECKOUT_BUILD_RECORD = '.abap2ui5-mcp-build.json';

/* Everything the incremental transpile's output is a function of, hashed:
 * the dev sandbox by content (buildFingerprint), the transpiler version,
 * the transpile config as it is handed to it, and node/downport - the
 * framework's own sources plus the dev copies - by every file's name, size
 * and mtime (a pull, a downport run, a changed copy all move one); the
 * library folders the config names by their directory mtime (a re-clone).
 * Dotfiles are left out: the dev-copies manifest is rewritten per build. */
export function checkoutFingerprint(a2, config) {
  const down = path.join(a2, 'node', 'downport');
  const stats = [];
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${rel}${e.name}/`);
      else {
        try {
          const st = fs.statSync(full);
          stats.push(`${rel}${e.name}\0${st.size}\0${st.mtimeMs}`);
        } catch {
          /* vanished between readdir and stat: not an input */
        }
      }
    }
  };
  walk(down, '');
  const libs = (config && Array.isArray(config.libs) ? config.libs : []).map((l) => {
    if (!l || !l.folder) return String(l && l.url || '');
    try {
      return `${l.folder}@${fs.statSync(path.join(a2, l.folder)).mtimeMs}`;
    } catch {
      return `${l.folder}@missing`;
    }
  });
  const extra = [JSON.stringify(config || null), ...libs, ...stats].join('\n');
  let inputDir = null;
  try {
    inputDir = devDir();
  } catch {
    inputDir = null;
  }
  return buildFingerprint({ inputDir, transpiler: installedVersion(a2, '@abaplint/transpiler-cli'), core: 'checkout', extra });
}

const initStat = (a2) => {
  try {
    const st = fs.statSync(path.join(a2, 'node', 'output', 'init.mjs'));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
};

/** Does node/output hold the build of exactly this fingerprint? */
export function checkoutBuildUnchanged(a2, fingerprint) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(a2, 'node', 'output', CHECKOUT_BUILD_RECORD), 'utf8'));
  } catch {
    return false;
  }
  const now = initStat(a2);
  return Boolean(record && record.fingerprint === fingerprint && now && record.output
    && record.output.mtimeMs === now.mtimeMs && record.output.size === now.size);
}

export function recordCheckoutBuild(a2, fingerprint) {
  try {
    fs.writeFileSync(path.join(a2, 'node', 'output', CHECKOUT_BUILD_RECORD), JSON.stringify({
      note: 'The last incremental build the abap2UI5 MCP server made of the dev sandbox into this folder: a build_backend that finds the same fingerprint answers unchanged.',
      fingerprint,
      output: initStat(a2),
      builtAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch {
    /* no record: the next build transpiles, as before */
  }
}

/*
 * The on-disk source of a deployed dev app, plus staleness against the built
 * backend: run_app boots what the last BUILD saw, so a file newer than
 * node/output/init.mjs is a deploy the served backend does not carry yet -
 * exactly the confusion ("I fixed that line, why does the app still crash?")
 * this report exists to end. Same name gate as deploy and remove: the name is
 * validated before it becomes a path, and never steps outside src/zz_dev.
 */
export function readAppSource(className) {
  const cls = classNameOf(className);
  const file = path.join(devDir(), `${cls}.clas.abap`);
  if (!fs.existsSync(file)) return { found: false, class: cls, file };
  /* the name gate stops a path in the name; this stops a symbolic link in the
   * sandbox (a checkout is untrusted content) resolving out of it and handing
   * the client a file the sandbox does not actually hold (lib/remote.mjs) */
  if (!resolvedInside(devDir(), file)) {
    throw new Error(`refusing to read ${cls} - its file resolves, through a symbolic link, outside the dev sandbox ${devDir()}`);
  }
  const st = fs.statSync(file);
  const builtFile = builtMarkerFile();
  const builtSt = builtFile && fs.existsSync(builtFile) ? fs.statSync(builtFile) : null;
  return {
    found: true,
    class: cls,
    file,
    source: fs.readFileSync(file, 'utf8'),
    deployedAt: st.mtime.toISOString(),
    // null when there is no built backend to compare against - unknown, not fresh
    backendBuiltAt: builtSt ? builtSt.mtime.toISOString() : null,
    staleInBackend: builtSt ? st.mtimeMs > builtSt.mtimeMs : null,
    // the local test classes deployed beside it, if any (run_unit_tests runs them)
    testclasses: fs.existsSync(path.join(devDir(), `${cls}.clas.testclasses.abap`)),
  };
}

export function listDevApps() {
  if (!fs.existsSync(devDir())) return [];
  return fs
    .readdirSync(devDir())
    .filter((f) => f.endsWith('.clas.abap') && !f.endsWith('.clas.testclasses.abap'))
    .map((f) => f.replace('.clas.abap', ''));
}
