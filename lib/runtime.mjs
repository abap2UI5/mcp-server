/*
 * runtime — the deploy/run half of the MCP loop, no SAP system needed.
 *
 * Wraps the ecosystem's existing Node pipeline: an app class is written into
 * a dev sandbox, the transpiled backend is rebuilt, a Node host serves it on
 * 127.0.0.1 (BACKEND_HOST), and Playwright boots the app via ?app_start=<class> exactly like
 * samples-controls' scripts/e2e-smoke.mjs does — collecting real page errors
 * and returning a screenshot.
 *
 * Two backends, decided per call (backendKind): a framework CHECKOUT -
 * build = its prebuilt asset, its own transpile or the corpus' e2e-build,
 * serve = its express shim - or, with no checkout, the npm package
 * @abap2ui5/node-runtime (lib/npm-backend.mjs) - build = only the dev apps
 * transpiled against it, serve = lib/npm-host.mjs. Nothing here re-invents
 * the pipeline, and the boot/error rules are the e2e-smoke gate's either way
 * (UI5 booted, >3 rendered controls, no non-benign page error, no backend
 * HTTP >= 400).
 */

/*
 * This module is the door, not the room: the runtime is split along its
 * seams into the modules below, and everything they export is exported from
 * here as it always was - server.mjs, scripts/ and the tests import
 * lib/runtime.mjs and nothing else changed for them. The modules import
 * each other directly (never this file):
 *
 *   sandbox.mjs          which checkout, which backend (backendKind), the dev
 *                        sandbox, the screenshot dir, the port
 *   deploy.mjs           deployApp/removeApp, the dev copies, the checkout
 *                        build fingerprint, readAppSource, listDevApps
 *   lint.mjs             the dev apps' abaplint config and lintApp; scope_of
 *   build.mjs            planBuild/buildBackend and the build log (build_log)
 *   prebuilt.mjs         the framework clone, its release asset (download,
 *                        sha256 sidecar, unpack) and its own transpile
 *   backend-process.mjs  the backend child: start, stop, liveness, its
 *                        environment, the app classes it serves
 *   ui5-routing.mjs      the benign console rules, UI5 from the local
 *                        packages, the CDN cache
 *   browser.mjs          Chromium, run_app and interact_app
 *   unit.mjs             run_unit_tests: the runner, filtered, and its output
 *   setup-status.mjs     setup_status
 */
export * from './sandbox.mjs';
export * from './deploy.mjs';
export * from './lint.mjs';
export * from './build.mjs';
export * from './prebuilt.mjs';
export * from './backend-process.mjs';
export * from './ui5-routing.mjs';
export * from './browser.mjs';
export * from './unit.mjs';
export * from './setup-status.mjs';

// the child-process helpers live in lib/spawn.mjs now; exported from here as
// they always were, so nothing that imports them from this module changes
export { TIMEOUT_DEFAULTS, timeoutOf, spawnWithTimeout, killChildren, localBin, missingBinMessage } from './spawn.mjs';
