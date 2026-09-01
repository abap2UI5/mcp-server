/*
 * fixview — apply the linter's mechanical fixes to one source, and hand the
 * corrected source BACK.
 *
 * The linter attaches `fixes: [{ start, end, text }]` to a finding when, and
 * only when, the correction is mechanical (its own ./fix module applies
 * them); a finding whose correction needs a decision deliberately carries
 * none. This module runs the property gate over the source, applies what can
 * be applied, and repeats until nothing more applies — the same
 * run-until-clean contract the linter's own `--fix` documents, needed here
 * because overlapping spans are deferred to the next pass rather than
 * resolved by guesswork.
 *
 * DELIBERATELY WRITES NOTHING. validate_view's input is source, not a path
 * into a checkout this server may touch, and the corrected source belongs to
 * whoever sent it — the agent decides where it goes. The temp file below
 * exists only because checkFiles takes files (the same shape validate_view
 * and screenshot_view use, for the same reason).
 *
 * The linter functions arrive as parameters (checkFiles from '.', applyFixes
 * from './fix'), so this module stays importable and testable without a
 * linter checkout on the module path — server.mjs resolves them through the
 * exports map and reports an old checkout in its own words.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// enough for a fix chain (each pass applies at least one span or stops);
// a cap because a pathological rule pair must never loop a tool call forever
const MAX_PASSES = 5;

const brief = (f) => ({
  type: f.type,
  message: f.message,
  ...(f.line !== undefined ? { line: f.line } : {}),
});

/**
 * Run the property-gate findings over `xml || abapSource`, apply every fix
 * they carry, re-check, repeat. Returns:
 *   { source, applied, passes, fixed, remaining }
 * where `fixed` briefs the findings whose fixes were applied (type, message,
 * line — as reported against the source of their pass) and `remaining` is
 * the final check's findings, untouched.
 */
export async function fixSource({ checkFiles, applyFixes, abapSource, xml, opt = {} }) {
  let source = xml || abapSource;
  const fileName = xml ? 'source.view.xml' : 'source.clas.abap';

  const check = async (text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2ui5-fix-'));
    const file = path.join(dir, fileName);
    try {
      fs.writeFileSync(file, text);
      // render OFF whatever the options say: fixes ride on the property gate,
      // and a render pass here would cost seconds for findings with no fixes
      const [r] = await checkFiles([file], { ...opt, render: false });
      return r;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  let applied = 0;
  let passes = 0;
  const fixed = [];
  let result = await check(source);
  while (passes < MAX_PASSES) {
    const carrying = result.findings.filter((f) => f.fixes && f.fixes.length);
    if (!carrying.length) break;
    const out = applyFixes(source, result.findings);
    if (!out.applied) break; // every span overlapped or was unusable — report, do not spin
    passes += 1;
    applied += out.applied;
    fixed.push(...carrying.map(brief));
    source = out.output;
    result = await check(source);
  }
  /* A finding still standing at the end was not fixed, however many passes
   * carried it (an overlapping span defers, a malformed one is dropped) —
   * subtract the survivors so `fixed` only claims what actually went away. */
  const still = new Set(result.findings.map((f) => `${f.type}\n${f.message}`));
  const seen = new Set();
  const trulyFixed = fixed.filter((f) => {
    const key = `${f.type}\n${f.message}`;
    if (still.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { source, applied, passes, fixed: trulyFixed, remaining: result.findings };
}
