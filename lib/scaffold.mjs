/* scaffold_app — the files a new abap2UI5 project starts from, named after the
 * app the agent is actually writing.
 *
 * `app_guide` tells an agent how to write the CLASS. That is the half it can
 * do: the guide is self-contained and the class is ABAP. The half it cannot
 * invent is everything around the class — which abaplint release the framework
 * is pinned at and under which key, what `abap2ui5lint.jsonc` has to say for
 * the render gate to run rather than skip, the `.clas.xml` sidecar whose
 * CLSNAME must match the class or the object does not import at all, and the
 * `.abapgit.xml` that decides where abapGit puts any of it.
 *
 * Those live in abap2UI5/app-template, which the ecosystem already calls the
 * place to begin. Served from the checkout rather than embedded, for the same
 * reason nothing else here is embedded: a copy in this repository would be a
 * second answer to "what does a new project look like", and the template moves.
 *
 * Renaming is part of the answer, not a follow-up step. The template's own
 * scripts/rename.mjs exists because the class name lives in the ABAP *and* in
 * the sidecar's CLSNAME, and renaming half of it produces an object that looks
 * right and does not activate.
 *
 * WHICH FILES, AND WHICH NAMES IN THEM, IS NOT DECIDED HERE. The template
 * describes that itself, in `template.json`: the placeholder class, the files
 * a project takes, and the substitutions that make them the agent's. This
 * module is one of three executors of that description — the template's own
 * `npm run rename` is another, the VS Code extension's "New Project from
 * Template" the third. The execution differs (in place, in memory, through the
 * VS Code file API); the description must not.
 */
import fs from 'fs';
import path from 'path';

/** The file the template describes itself in. */
export const SPEC_FILE = 'template.json';

/**
 * Read the template's own description of itself out of `root`.
 *
 * Returns null when the checkout does not have it — an older revision, a
 * half-finished pull. Reported by the caller rather than papered over with a
 * copy of the list kept here, which is the duplication this file exists to
 * end.
 */
export function readSpec(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, SPEC_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Every file a project takes from the template, in the template's own order:
 *  the project-independent ones, then the ones that carry a name. */
export function templateFiles(spec) {
  return [...spec.files.shared, ...spec.files.named];
}

/* The class-name rule this repository falls back to when it cannot read the
 * template's own. Kept in step with `substitutions.class.rule` in
 * template.json by a test, because it is a second copy of a rule and this file
 * exists to have only one.
 *
 * It used to read `^[zy]c[lx]_`, which admits `ycl_`/`ycx_` — and the
 * abaplint `object_naming.clas` that has to accept the scaffolded result is
 * `^ZCL_|^ZCX_`. So `scaffold_app` with `ycl_my_app` was accepted here and
 * produced a project that failed its own gate on the first run, which is the
 * one thing a scaffolding step must never do. */
const CLASS_NAME_FALLBACK = '^z(cl|cx)_[a-z0-9_]{1,26}$';
const MAX_LENGTH_FALLBACK = 30;

/**
 * Does `name` look like an ABAP class this template blesses?
 *
 * The rule belongs to the template, like the file list does — pass the spec
 * and it decides. Without one (an older checkout, a pull in flight) the
 * fallback above answers, so a missing template.json degrades to a stricter
 * check rather than to none.
 */
export function validClassName(name, spec = null) {
  const rule = spec?.substitutions?.class?.rule || CLASS_NAME_FALLBACK;
  const max = spec?.substitutions?.class?.maxLength || MAX_LENGTH_FALLBACK;
  return new RegExp(rule).test(name) && name.length <= max;
}

/** What `validClassName` is currently judging by — for the error message, so
 *  it names the rule that actually refused rather than a copy of it. */
export function classNameRule(spec = null) {
  return {
    rule: spec?.substitutions?.class?.rule || CLASS_NAME_FALLBACK,
    max: spec?.substitutions?.class?.maxLength || MAX_LENGTH_FALLBACK,
    fromSpec: Boolean(spec?.substitutions?.class?.rule),
  };
}

/* The substitution kinds template.json can ask for, executed over one file's
 * text. The class name is replaced in BOTH cases because the ABAP source
 * writes it lower case and the sidecar's CLSNAME upper case — that asymmetry
 * is the whole reason the template ships a script instead of an instruction.
 *
 * Exported for the tests. It is pure — spec in, text out, no file system — and
 * it used to be reachable only through `scaffold()`, i.e. only with an
 * app-template checkout beside this repository: all three scaffold tests
 * skipped themselves without one, so on a bare checkout a substitution bug was
 * invisible. A fixture spec exercises it now, and the checkout-dependent tests
 * still prove that the REAL template.json is a spec of this shape. */
export function rename(spec, file, text, { cls, packageText, repo }) {
  const subs = spec.substitutions;
  const old = spec.placeholderClass;
  let out = text;

  if (cls && cls !== old && subs.class.files.includes(file)) {
    out = out.split(old).join(cls).split(old.toUpperCase()).join(cls.toUpperCase());
  }
  if (packageText) {
    for (const t of subs.packageText) {
      if (t.file === file) {
        out = out.replace(new RegExp(`<${t.element}>[^<]*</${t.element}>`), `<${t.element}>${packageText}</${t.element}>`);
      }
    }
  }
  if (repo) {
    for (const t of subs.repo) {
      if (t.file !== file) continue;
      out = t.element
        ? out.replace(new RegExp(`<${t.element}>[^<]*</${t.element}>`), `<${t.element}>${repo}</${t.element}>`)
        : out.replace(new RegExp(`"${t.jsonKey}":\\s*"[^"]*"`), `"${t.jsonKey}": "${repo}"`);
    }
  }
  return out;
}

/** The file a class ends up in, once it is not called by the template's
 *  placeholder name any more. */
const renamePath = (spec, file, cls) =>
  (cls && cls !== spec.placeholderClass && spec.substitutions.class.renamesPath
    ? file.split(spec.placeholderClass).join(cls)
    : file);

/**
 * Read the template out of `root` and return it as `{ path, text }` entries.
 *
 * `noSpec` is set when the checkout has no `template.json` — there is nothing
 * to serve then, and saying so beats guessing at a file list.
 *
 * A file the template's own description lists and the checkout does not have
 * is reported rather than skipped: a silently shorter project is the failure
 * that would not be noticed until the first `npm run check`.
 */
export function scaffold(root, { cls, packageText, repo } = {}) {
  const spec = readSpec(root);
  if (!spec) return { files: [], missing: [], noSpec: true };

  const files = [];
  const missing = [];

  for (const file of templateFiles(spec)) {
    const at = path.join(root, file);
    if (!fs.existsSync(at)) { missing.push(file); continue; }
    files.push({
      path: renamePath(spec, file, cls),
      text: rename(spec, file, fs.readFileSync(at, 'utf8'), { cls, packageText, repo }),
    });
  }

  return { files, missing, spec };
}
