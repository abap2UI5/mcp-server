/*
 * The tool surface of the SYSTEM MODE (lib/system.mjs) - what tools/list
 * answers instead of the TOOLS array of lib/tools.mjs when
 * A2UI5_MCP_SYSTEM_URL is set. One source, like TOOLS: the README's
 * system-mode table and test/tool-surface.test.mjs are checked against it.
 *
 * The app tools keep the sandbox's names, arguments and snapshot - an agent
 * that learned them on the local backend operates a real system the same
 * way - and the VS Code extension's system server uses the same names too.
 * What differs is said in every description, because the description is
 * the only documentation the agent reads: these act FOR REAL.
 */

const REAL = 'Runs FOR REAL on the configured SAP system as the configured user - an event may save, post or delete data; '
  + 'only do what the user asked for.';

const FORMAT = {
  type: 'string',
  enum: ['snapshot', 'adaptive-card'],
  description: 'optional: "adaptive-card" adds the screen as an Adaptive Card 1.5 (an embedded resource, '
    + 'application/vnd.microsoft.card.adaptive) after the snapshot - for hosts that render cards; default "snapshot" '
    + '(or the server\'s A2UI5_MCP_APP_FORMAT)',
};

export const SYSTEM_TOOLS = [
  {
    name: 'system_status',
    description:
      'Which SAP system this server is connected to and whether it works: the abap2UI5 endpoint and user from the '
      + 'configuration (never the password), then ONE request to the endpoint that shows whether the host answers, '
      + 'the certificate is accepted and the logon works - each failure as a sentence that says what to change. '
      + 'Call it first, and whenever app_list or app_start says the system did not answer. A rejected logon is sent '
      + 'once and then refused here too, so a wrong password cannot lock the user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'app_list',
    description:
      'The classes on the SAP system that app_start can start - an ADT class-name search (the system counterpart of '
      + 'the sandbox\'s app_list). `filter`: the start of the class name, `*` as a wildcard (default "Z"); at most 50 '
      + 'names, with description and package. Names only: whether a class implements z2ui5_if_app is not checked - '
      + 'app_start says so. Needs the ADT services and the user\'s authorization for them; starts nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'class-name pattern: the start of the name, * as wildcard (e.g. "z2ui5_cl_smp_app_00", "*travel")' },
      },
    },
  },
  {
    name: 'app_start',
    description:
      'Start an abap2UI5 app class on the SAP system and get its screen as an AGENT SNAPSHOT (v1): the fields you can '
      + 'fill (id, model path, label, kind, current value, editable, choice values), the actions you can fire (the event '
      + 'name and arguments of each button/link/row/value-help wire), the tables (columns, the first rows, selection), '
      + 'the messages (toast, message box, MessageStrip, field value states) and some static text - read from the real '
      + 'abap2UI5 JSON protocol, no browser. Continue with app_act using the snapshot\'s `session`. Optional `values` '
      + 'are applied as pending edits right after the start. In a chat host that renders MCP Apps the screen is also '
      + 'shown to the user, who can operate it - what they do arrives as app_act calls, so re-read the session if it '
      + `moved on. ${REAL}`,
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'the app class to start, e.g. z2ui5_cl_smp_app_009, zcl_my_app or /ns/cl_app (app_list searches the system)' },
        values: { type: 'object', description: 'optional { "<field id, model path or name>": value } kept as pending edits (sent with the next app_act event)' },
        max_rows: { type: 'number', description: 'table rows per table in the snapshot (default 20, max 200)' },
        format: FORMAT,
      },
      required: ['app'],
    },
  },
  {
    name: 'app_describe',
    description:
      'The current agent snapshot of a running app session (see app_start) - answered from the last response this '
      + 'server kept, no roundtrip, so it sends nothing to the system. Pending edits (values sent without an event) '
      + 'show as the fields\' values and are listed under `pending`.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'the `session` of the last snapshot (the draft id to continue with)' },
        max_rows: { type: 'number', description: 'table rows per table (default: what app_start used)' },
        format: FORMAT,
      },
      required: ['session'],
    },
  },
  {
    name: 'app_act',
    description:
      'Operate a running app session on the SAP system semantically: fill fields and fire an event, then get the new '
      + 'agent snapshot. `values` { "<field id | model path | name>": value } (table cells as "<table path or '
      + 'id>/<row>/<COLUMN>", e.g. "/T_TAB/2/SELKZ" to select a row) go out as the model delta of the roundtrip; '
      + '`event` is an action\'s event name or its id ("a3"); `row` (0-based) fills the row-dependent arguments of a row '
      + 'action; on a SelectDialog/TableSelectDialog the `confirm` action is the pick: `row` selects that row; `args` '
      + '(positional, null = let the client fill it) supplies arguments the browser would compute ("$expr:...", '
      + '"$parameters:...", a message box\'s "$action"). Without `event` the values stay pending, as typing does in the '
      + 'browser - nothing is sent. Strict: an event that is not among the snapshot\'s actions, a field that is not on '
      + 'the screen or not editable, a choice outside its values is refused - the error names what is allowed - and '
      + `nothing is sent. "@CLOSE_POPUP" / "@CLOSE_POPOVER" actions close the dialog locally. ${REAL}`,
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'the `session` of the last snapshot' },
        values: { type: 'object', description: '{ "<field id, model path or name>": value, "<table path>/<row>/<COLUMN>": value }' },
        event: { type: 'string', description: 'the action to fire: its event name (e.g. "SAVE") or its id ("a3")' },
        args: { type: 'array', description: 'event arguments, positional to the action\'s `args`; null where the client fills the value in' },
        row: { type: 'number', description: 'for a row action: the row index (0-based) in its table - for a selection dialog\'s confirm, the row to pick' },
        max_rows: { type: 'number', description: 'table rows per table in the answer (default: what app_start used)' },
        format: FORMAT,
      },
      required: ['session'],
    },
  },
];

/** Every system tool name, sorted - derived, never written out. */
export const SYSTEM_TOOL_NAMES = SYSTEM_TOOLS.map((t) => t.name).sort();
