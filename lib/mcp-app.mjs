/*
 * mcp-app - the app tools' screen as an MCP Apps UI resource.
 *
 * MCP Apps (SEP-1865, the extension `io.modelcontextprotocol/ui`, stable
 * spec 2026-01-26 in modelcontextprotocol/ext-apps) lets a tool name a
 * `ui://` resource that the chat host renders as a sandboxed iframe next to
 * the tool's result. app_start, app_describe and app_act name
 * ui://abap2ui5/app-screen: the snapshot they answer becomes a screen the
 * USER can see and operate - fields to fill, buttons to press, rows to act
 * on - while the agent keeps reading the same text snapshot it always got.
 * What the user does goes back as an app_act call through the host, so it
 * passes the same validation as the agent's own acts and the agent sees it.
 *
 * The page is lib/mcp-app-view.mjs inlined into one HTML document: no
 * external URL, no network, which is exactly what the spec's restrictive
 * default CSP allows when a resource declares no `_meta.ui.csp`
 * (`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
 * 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`). The UI5 Web
 * Components frontend (abap2UI5/frontend-webcomponent) was the other option
 * and does not fit: it is a second protocol client with its own draft and
 * session (it would bypass app_act and its validation), and its build is
 * 106 files and 14.7 MB loaded through dynamic imports of chunk files - a
 * single inline document has no origin to import them from, and declaring a
 * CDN in `resourceDomains` would put the page on the network.
 *
 * Declaring the UI follows the spec's "Server Behavior": a server SHOULD
 * check the client's capabilities first. `A2UI5_MCP_UI` decides:
 *   auto (default)  declare it when the client's initialize advertised
 *                   `capabilities.extensions["io.modelcontextprotocol/ui"]`
 *                   with `text/html;profile=mcp-app` among its mimeTypes
 *   on              always declare it (a host that renders MCP Apps without
 *                   advertising the extension)
 *   off             never
 * A host without MCP Apps support ignores the metadata either way (the spec:
 * the tool "behaves as standard tool"); the tool's text answer never changes.
 */
import fs from 'node:fs';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const UI_MIME = 'text/html;profile=mcp-app';
export const APP_SCREEN_URI = 'ui://abap2ui5/app-screen';
/** The tools whose results the screen renders. */
export const UI_TOOLS = ['app_start', 'app_describe', 'app_act'];
export const UI_MODES = ['auto', 'on', 'off'];

/** `_meta.ui` of the resource: a border, and no csp - the restrictive default is what the page needs. */
export const APP_SCREEN_META = { ui: { prefersBorder: true } };

/** A2UI5_MCP_UI, read per call; anything unknown is `auto`. */
export function uiMode(env = process.env) {
  const v = String(env.A2UI5_MCP_UI || '').trim().toLowerCase();
  if (['on', '1', 'true', 'always'].includes(v)) return 'on';
  if (['off', '0', 'false', 'never'].includes(v)) return 'off';
  return 'auto';
}

/** Whether the client's initialize capabilities advertise MCP Apps with the HTML profile. */
export function clientRendersUi(capabilities) {
  const ext = capabilities && capabilities.extensions && capabilities.extensions[UI_EXTENSION];
  return Boolean(ext && Array.isArray(ext.mimeTypes) && ext.mimeTypes.includes(UI_MIME));
}

export function uiEnabled(capabilities, env = process.env) {
  const mode = uiMode(env);
  return mode === 'on' || (mode === 'auto' && clientRendersUi(capabilities));
}

/**
 * The tool list as tools/list serves it: with `enabled`, the app tools carry
 * `_meta.ui.resourceUri` (and the deprecated flat `ui/resourceUri`, which the
 * spec's own SDK still writes for older hosts) and are visible to the model
 * and to the app. The TOOLS array itself stays untouched.
 */
export function toolsWithUi(tools, enabled) {
  if (!enabled) return tools;
  return tools.map((t) => (UI_TOOLS.includes(t.name)
    ? { ...t, _meta: { ...(t._meta || {}), ui: { resourceUri: APP_SCREEN_URI, visibility: ['model', 'app'] }, 'ui/resourceUri': APP_SCREEN_URI } }
    : t));
}

const CSS = `
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--fg:var(--color-text-primary,#1d1d1f);
--muted:var(--color-text-secondary,#5f6368);--line:var(--color-border-primary,#d0d4d9);--accent:var(--color-text-info,#0a6ed1);
--err:#b00020;--warn:#8a5300;--ok:#256f3a;--font:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:var(--color-background-primary,#1e1f22);--fg:var(--color-text-primary,#e8eaed);
--muted:var(--color-text-secondary,#a0a4aa);--line:var(--color-border-primary,#3c4043);--accent:var(--color-text-info,#8ab4f8);--err:#f28b82;--warn:#fdd663;--ok:#81c995}}
:root[data-theme=dark]{--bg:var(--color-background-primary,#1e1f22);--fg:var(--color-text-primary,#e8eaed);--muted:var(--color-text-secondary,#a0a4aa);
--line:var(--color-border-primary,#3c4043);--accent:var(--color-text-info,#8ab4f8);--err:#f28b82;--warn:#fdd663;--ok:#81c995}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--font)}
main{padding:12px 16px;max-width:100%}h1{font-size:16px;margin:0}h2{font-size:14px;margin:12px 0 4px}
.meta,.note,.wait,.busy{color:var(--muted);margin:2px 0}.meta code{font-size:12px}.error{color:var(--err);white-space:pre-wrap;margin:6px 0}
.messages,.texts{list-style:none;padding:0;margin:8px 0}.msg{border-left:3px solid var(--accent);padding:2px 8px;margin:4px 0}
.msg-error{border-color:var(--err)}.msg-warning{border-color:var(--warn)}.msg-success{border-color:var(--ok)}.msg strong{text-transform:uppercase;font-size:11px;margin-right:4px}
.texts li{color:var(--muted)}.fields{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 12px;align-items:center;margin:8px 0}
.field{display:contents}.fmsg{grid-column:2;font-size:12px}.fmsg-error{color:var(--err)}.fmsg-warning{color:var(--warn)}.fmsg-success{color:var(--ok)}
input[type=text],select,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:4px 6px;width:100%;min-width:0}
input:disabled,select:disabled,textarea:disabled{opacity:.6}.field-bool input{justify-self:start}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.secondary button{color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600}td input[type=text]{min-width:6em}.rowacts{white-space:nowrap}.sr{position:absolute;left:-9999px}
details{margin:8px 0;color:var(--muted)}
`;

let viewSource = null;
/** The page module's source, read once (it ships in lib/, next to this file). */
export function viewModuleSource() {
  if (viewSource === null) viewSource = fs.readFileSync(new URL('./mcp-app-view.mjs', import.meta.url), 'utf8');
  return viewSource;
}

/** The whole UI resource: one self-contained HTML5 document. */
export function appScreenHtml() {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>abap2UI5 app screen</title>\n'
    + `<style>${CSS}</style>\n</head>\n<body>\n<main id="app"><p class="wait">Waiting for the app screen...</p></main>\n`
    + `<script type="module">\n${viewModuleSource()}\nboot(window);\n</script>\n</body>\n</html>\n`;
}

/** resources/read of the UI resource. */
export function readAppScreen() {
  return { mimeType: UI_MIME, text: appScreenHtml(), _meta: APP_SCREEN_META };
}
