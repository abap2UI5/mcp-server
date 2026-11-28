/*
 * instructions — the server's `instructions` in the initialize result.
 *
 * WHY: a tool description is read when the agent is already choosing a tool.
 * The instructions are read before that: Claude Code, Cursor and the other
 * clients put them into the agent's system prompt, so they decide whether the
 * agent reaches for this server at all, and in which order. Without them an
 * agent with a few dozen tools and no AGENTS.md (the plugin, `claude mcp add`, a
 * project that never started from app-template) wrote the app from memory and
 * never called one - and what a model remembers of abap2UI5 is mostly the API
 * from before 1.143.0. So: the order of the loop, and the renames a model gets
 * wrong most.
 *
 * Short on purpose (a client may cut long instructions, and every agent pays
 * for them in every turn): the tool descriptions carry the details. Every tool
 * named here is checked against the surface by test/instructions.test.mjs.
 */

const SANDBOX = [
  'abap2UI5 builds SAP UI5 apps as ONE ABAP class implementing z2ui5_if_app. Use these tools instead of '
    + 'what you remember of abap2UI5 - most of that predates its current API.',
  '',
  'The loop, without an SAP system:',
  '1. setup_status first: what resolves and what is missing.',
  '2. Before writing: capabilities (can abap2UI5 express it?), examples then read_example (a working app '
    + 'that already does it), addons (does an installable addon?), app_guide (how an app is built), '
    + 'api_reference (z2ui5_if_client - look a method up, do not guess it), docs_search.',
  '3. After every change: lint_abap (abaplint, deploys nothing) and validate_view (the view; fix_view applies the '
    + 'mechanical fixes); screenshot_view to see it.',
  '4. To run it: deploy_app, build_backend, then run_app (screenshot) or app_start / app_act (fill fields, '
    + 'fire events) or interact_app (click, drag, read, save files; a kept browser for a long flow); run_unit_tests for '
    + 'the test classes. verify_app does all of it in one call - verify_project for a folder (deploy_folder, the '
    + 'project\'s own abaplint.jsonc, every test class, the boot).',
  '5. Before finishing: pitfalls - what a green check still misses on a real system.',
  '',
  'Found a defect in abap2UI5 or in these tools - not in your own code - and shown it with a minimal app '
    + '(verify_app reproduces it)? Call report_issue: it drafts the issue, finds open ones like it, and gives the '
    + 'user a link to file it. It posts nothing; tell the user and let them decide. A report with a reproduction '
    + 'is how the next agent does not hit the same thing.',
  '',
  'Names a model often remembers wrong (old -> current):',
  '- z2ui5_cl_xml_view=>factory( )->shell( )->page( ) -> z2ui5_cl_ui5_view_builder=>factory( ) with ele / tag / a / end / stringify',
  '- client->_bind_edit( x ) -> client->_bind( x ) (always two-way)',
  '- client->view_model_update( ) -> delete it; changed bound data is sent automatically',
  '- a check_initialized flag -> IF client->check_on_init( ). ELSEIF client->check_on_navigated( ). ELSEIF client->check_on_event( ).',
  '- client->get( )-event -> client->get_event( ); client->_event_client( ) -> client->follow_up_action( )',
].join('\n');

const SYSTEM = [
  'This server is connected to a REAL SAP system running abap2UI5 (system mode). system_status first: '
    + 'which system, which user, whether the logon works.',
  'app_list finds the app classes; app_start opens one as an agent snapshot, app_act fills fields and fires '
    + 'events, app_describe re-reads the last snapshot for free. An event runs on the real system and can '
    + 'change its data: act only as the user asked.',
  'With writes enabled: system_write_class, system_activate, system_unit_tests - only for a class the user '
    + 'asked you to put on the system.',
].join('\n');

/** The instructions for the surface this process serves. Pure. */
export function serverInstructions({ system = false } = {}) {
  return system ? SYSTEM : SANDBOX;
}
