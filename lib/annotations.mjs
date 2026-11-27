/*
 * annotations — the MCP tool annotations (readOnlyHint, destructiveHint,
 * idempotentHint, openWorldHint) of every tool, by surface.
 *
 * WHY: a client decides from these whether a call needs the user's approval.
 * Without them every call is treated as a possible write - in a cloud session
 * each `examples` or `app_guide` lookup went through the permission check, the
 * same as `remove_app`. About half the surface only reads, and saying so is
 * what lets a client run those unasked.
 *
 * A hint, not a guarantee (the spec says so): it describes the EFFECT on what
 * the user owns, the way the tool's description does. Caches do not count -
 * the mirror under the OS temp dir, the npm workspace a lint installs into, a
 * screenshot file - they are this server's own and rebuilt on demand. What
 * counts: the dev sandbox (deploy_app, remove_app), the project directory
 * (add_agent_setup), the running backend (backend stop), and on the system
 * surface the SAP system itself.
 *
 * Two maps, because a few names exist on both surfaces without sharing their
 * effect: the sandbox's app_act runs an app against a local backend nobody
 * else uses, the system's app_act runs it on a real system, where an event can
 * post a document. test/tool-surface.test.mjs fails when a tool of either
 * surface has no entry here, or an entry names no tool.
 */

const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/* Reads, and may fetch what it reads from GitHub when there is no checkout. */
const READ_REMOTE = Object.freeze({ ...READ, openWorldHint: true });
/* Changes local state this server owns for the user (the sandbox, the
 * backend, an app session) without deleting anything they wrote. */
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
/* Replaces or deletes something the user put there. */
const DESTRUCTIVE = Object.freeze({ ...WRITE, destructiveHint: true });

export const TOOL_ANNOTATIONS = Object.freeze({
  setup_status: READ,
  capabilities: READ_REMOTE,
  examples: READ_REMOTE,
  read_example: READ_REMOTE,
  app_guide: READ_REMOTE,
  api_reference: READ_REMOTE,
  generation_rules: READ_REMOTE,
  scaffold_app: READ_REMOTE, // returns the files; writes nothing itself
  docs_search: READ_REMOTE,
  addons: READ_REMOTE,
  pitfalls: READ_REMOTE,
  scope_of: READ,
  read_app: READ,
  validate_view: READ,
  fix_view: READ, // returns the corrected source; writes nothing
  screenshot_view: READ,
  build_log: READ,
  app_list: READ,
  app_describe: READ,
  // never overwrites a file and only ever adds to package.json / .gitignore; re-running changes nothing
  add_agent_setup: { ...WRITE, idempotentHint: true, openWorldHint: true },
  deploy_app: DESTRUCTIVE, // replaces a deployed class of the same name
  deploy_folder: DESTRUCTIVE, // a redeployed object loses the files the folder no longer has
  remove_app: DESTRUCTIVE,
  migrate_report: { ...WRITE, openWorldHint: true }, // writes only with deploy: true
  build_backend: { ...WRITE, openWorldHint: true }, // installs from the registry
  run_app: WRITE, // starts the backend
  interact_app: WRITE,
  app_start: WRITE,
  app_act: WRITE,
  call_handler: WRITE, // a POST can change what the handler keeps; starts the backend
  run_unit_tests: WRITE,
  verify_app: DESTRUCTIVE, // deploys, as deploy_app
  backend: WRITE, // start / stop / restart
});

export const SYSTEM_TOOL_ANNOTATIONS = Object.freeze({
  system_status: { ...READ, openWorldHint: true },
  app_list: { ...READ, openWorldHint: true },
  app_describe: READ, // the last kept response, nothing sent
  // an app on a real system: an event can post, change or delete its data
  app_start: { ...DESTRUCTIVE, openWorldHint: true },
  app_act: { ...DESTRUCTIVE, openWorldHint: true },
  system_write_class: { ...DESTRUCTIVE, openWorldHint: true },
  system_activate: { ...WRITE, openWorldHint: true },
  system_unit_tests: { ...WRITE, openWorldHint: true },
});

/** The tools of one surface with their annotations attached; a tool already
 *  carrying `annotations` keeps its own fields over the map's. Pure. */
export function annotate(tools, map) {
  return tools.map((t) => (map[t.name] ? { ...t, annotations: { ...map[t.name], ...(t.annotations || {}) } } : t));
}
