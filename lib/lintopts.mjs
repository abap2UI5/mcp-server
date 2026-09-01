/*
 * lintopts — the one option set validate_view and fix_view judge a source by.
 *
 * Explicit tool arguments win; the checked project's abap2ui5lint.jsonc
 * fills the rest — an agent must not report (or fix by) findings the
 * project's own CI has deliberately configured away. In lib/ rather than
 * server.mjs so the precedence is TESTABLE (server.mjs connects stdio at
 * module scope and may not be imported by a test).
 *
 * Which project's config applies, in order: the one named (project_dir), the
 * one the server was started in, the corpus. It used to be the corpus and
 * only the corpus, which is right for porting samples and wrong for everyone
 * else. The chosen file is reported back as `configFile`.
 *
 * `allow` is the one key with MERGE semantics rather than override: the
 * linter's applyConfig folds the config's allowances into the caller's
 * unconditionally ("a config allowance and a CLI allowance are both meant"),
 * so an explicit allow entry always survives — the project can only allow
 * MORE, never take a caller's allowance away. It is still marked as seen:
 * on the current linter that changes nothing (the allow branch never
 * consults `seen`), and on any linter whose applyConfig lacks that special
 * case it is what keeps the documented "explicit arguments win" true — the
 * sibling is unpinned, and this line is cheaper than the bug.
 */
import { importViewCheck, resolveLintConfig, resolveSamplesControls } from './repos.mjs';

/**
 * `{ opt, configFile }` for a validate_view/fix_view-shaped `args`
 * (min_ui5, allow, render, project_dir). `forceNoRender` is fix_view's
 * setting: fixes ride on the property gate, so the render pass would cost
 * seconds for findings that never carry one — forced off and marked as
 * decided so no config can switch it back on.
 */
export async function lintOptionsFor(args, { forceNoRender = false } = {}) {
  const { findConfigFrom, loadConfig, applyConfig } = await importViewCheck('./config');
  const opt = { minUi5: '1.71', allow: [], render: !forceNoRender, properties: true };
  const seen = new Set(['properties']);
  if (forceNoRender) seen.add('render');
  if (args.min_ui5) { opt.minUi5 = args.min_ui5; seen.add('minUi5'); }
  if (args.allow) { opt.allow = args.allow; seen.add('allow'); }
  if (!forceNoRender && args.render === false) { opt.render = false; seen.add('render'); }
  const configFile = resolveLintConfig(findConfigFrom, {
    projectDir: args.project_dir,
    cwd: process.cwd(),
    corpus: resolveSamplesControls(),
  });
  if (configFile) {
    const cfg = loadConfig(configFile);
    delete cfg.baseline; // baseline is a repo-workflow concern; new source has no baseline entry
    applyConfig(opt, seen, cfg);
  }
  return { opt, configFile };
}
