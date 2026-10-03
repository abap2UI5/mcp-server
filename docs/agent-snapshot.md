# Agent snapshot v1 and the app tools

**Every abap2UI5 app is agent-operable.** An agent fills fields, fires events
and reads results *semantically* — by model path, label and event name — over
the same JSON protocol the browser's UI5 frontend speaks, with no browser and
no CSS selector. This page is the reference for the **snapshot v1** data shape
and the four operations on it. Three implementations share it:

| Implementation | Where | Status |
| --- | --- | --- |
| MCP server (Node) | this repository: `lib/snapshot.mjs` (snapshot), `lib/viewxml.mjs` (parsers), `lib/appclient.mjs` (protocol client), the tools `app_list`, `app_start`, `app_describe`, `app_act` | implemented |
| VS Code extension | abap2UI5/vscode-extension | follows this page |
| ABAP agent addon | abap2UI5-addons/agent | follows this page |

The shape is "Contract B" of the 2026-10-03 brainstorm. Where the real
protocol forced a difference, it is listed under
[Deviations and extensions](#deviations-and-extensions) — implementations
follow this page, not the original contract text.

## How it works

The browser frontend (abap2UI5 `app/webapp/core/Server.js`,
`controller/View1.controller.js`, `core/actions/Slots.js`) does three things
per roundtrip, and so does every implementation:

1. **Send** `POST { "value": { "S_FRONT": {…}, "MODEL": {…} } }`:
   - app start: `S_FRONT = { ORIGIN, PATHNAME, SEARCH: "?app_start=<CLASS>" }`
   - event: `S_FRONT = { ID: <draft id of the last response>, EVENT: "SAVE", T_EVENT_ARG: [...] }`,
     `MODEL` = the **delta** of the model owned by the view the event was fired
     from: a scalar or structure edit ships the whole top-level attribute, a
     table cell ships `{ "T_TAB": { "__delta": { "<row>": { "COL": value } } } }`
     (nested tables recursively; `buildDeltaFromPaths` in `core/Lib.js`).
2. **Receive** `{ "S_FRONT": { "ID", "APP", "PROTOCOL": 2, "S_ACTION": { "T_SYSTEM": [...], "T_CUSTOM": [...] } }, "MODEL"? }`.
   `MODEL`, when present, is the full model of the app that answered; absent
   means "nothing bound changed" — the client keeps its model, including
   what the user typed.
3. **Fold** the answer into the screen state:
   - `T_SYSTEM` `["VIEW_SLOTS","display",<slot>,<xml>,<options>]` fills one of
     five slots — `MAIN`, `NEST`, `NEST2` (nested views, part of the page),
     `POPUP`, `POPOVER`; `["VIEW_SLOTS","destroy",<slot>]` empties one. A MAIN
     display also drops the nested views, the popup and the popover.
   - `MAIN`/`NEST`/`NEST2` share one model; `POPUP` and `POPOVER` own a copy.
     A slot displayed by this response takes this response's `MODEL`; a
     `MODEL` is pushed into an open slot only when the slot belongs to the app
     that answered — a popup app (`nav_app_call` of a `z2ui5_cl_pop_*`) never
     overwrites the caller's page behind it.
   - `T_CUSTOM` is client work: toasts, message boxes, timers, focus, ….

The snapshot is derived from the folded state: the view XML of every open slot
plus its model. Bindings in the current protocol are plain model paths
(`{/S_SCREEN/NAME}`); every binding of the default model is two-way, so whether
a field is editable is decided by the **control**, not by the path.

## Snapshot v1

JSON, lower-camel keys. Keys in this order; `pending` only when non-empty.

```json
{
  "snapshotVersion": 1,
  "session": "B9D27C42CDAB45558097FD6F95E77BAD",
  "app": "Z2UI5_CL_SMP_APP_009",
  "title": "abap2UI5 - Value Help",
  "layer": "popup",
  "fields": [],
  "actions": [
    { "id": "a1", "event": "POPUP_TABLE_VALUE_CONTINUE", "args": [], "label": "continue",
      "control": "sap.m.Button", "trigger": "press", "enabled": true, "scope": "screen", "layer": "popup" }
  ],
  "tables": [
    { "id": "t1", "path": "/T_SUGGESTION_SEL", "name": "T_SUGGESTION_SEL", "label": "T_SUGGESTION_SEL",
      "control": "sap.m.Table", "columns": [ { "name": "VALUE", "label": "Color" }, { "name": "DESCR", "label": "Description" } ],
      "rowCount": 6, "rows": [ { "VALUE": "GREEN", "DESCR": "this is the color Green", "SELKZ": false } ],
      "truncated": true, "selectionMode": "Single", "editableCells": ["SELKZ"], "layer": "popup", "selectionField": "SELKZ" }
  ],
  "messages": [],
  "texts": [],
  "unsupported": []
}
```

| Key | Meaning |
| --- | --- |
| `snapshotVersion` | `1` |
| `session` | the draft id to continue with (the last response's `S_FRONT.ID`) — the `session` argument of `app_describe`/`app_act` |
| `app` | the class that answered last (`S_FRONT.APP`), upper case |
| `title` | the title of the topmost layer: a Dialog/Popover `title`, else the Page `title`, else a `sap.f.DynamicPageTitle` heading |
| `layer` | the topmost active layer: `popover` when one is open, else `popup`, else `main` |
| `fields`, `actions`, `tables`, `messages`, `texts`, `unsupported` | below |
| `pending` | *(extension)* model paths changed by `app_act` without an event, not sent yet |

**Which layers are described.** A popup (Dialog) is modal: while one is open,
only the popup (and a popover on top of it) is described — the page behind it
is not actionable in the browser either. A popover is not modal: the page
stays described beside it. Nested views (`NEST`, `NEST2`) are part of `main`.
Every field, action and table carries its own `layer`.

Ids (`f1…`, `a1…`, `t1…`) are assigned in document order and are stable
**within one snapshot** only — re-read them after every act.

### fields

One per input-like control whose value property is bound to a default-model
path:

| Key | Derivation |
| --- | --- |
| `id` | `f<n>` |
| `path` | the binding path as in the view (`/S_SCREEN/NAME`) |
| `name` | the path as an ABAP-ish name: segments joined with `-` (`S_SCREEN-NAME`); a leading `XX` segment (the old two-way prefix) is dropped |
| `label` | first of: a `Label` whose `labelFor` is the control's id; the form label — in a SimpleForm (or any container) the closest preceding `Label`, in a `form:FormElement` its `label`; the control's own `text` (CheckBox, RadioButton, ToggleButton); `placeholder`; `tooltip`; `ariaLabel`; `title`; else `name`. When one form label precedes several fields, the second and later ones get ` (<placeholder>)` appended |
| `control` | the full UI5 name (`sap.m.Input`) |
| `kind` | from the control (table below); a model type in the binding (`type: 'sap.ui.model.type.Integer'`) refines it to `number`/`date`/`time`/`datetime`/`boolean` |
| `value` | the model value at `path` (typed as the model holds it), `null` when absent |
| `required` | `required="true"` on the control (literal, bound or expression), or on its label |
| `editable` | `false` when `editable`, `enabled` is false or `displayOnly` is true (literal, bound or a simple expression binding) |
| `values` | `choice`/`multichoice` only: `[{ key, text }]` from static items (`core:Item`, `core:ListItem`, `SegmentedButtonItem`) or from bound items resolved against the model; a RadioButtonGroup is keyed by index. At most 100 (the cut is noted in `unsupported`) |
| `layer` | `main`, `popup` or `popover` |

| Control | Value property | kind |
| --- | --- | --- |
| `sap.m.Input` | `value` | `text`; `number`/`date`/`time`/`datetime` by `type` |
| `sap.m.TextArea` | `value` | `textarea` |
| `sap.m.MaskInput`, `SearchField`, `MultiInput` | `value` | `text` |
| `sap.m.StepInput`, `Slider`, `RangeSlider`, `RatingIndicator` | `value` | `number` |
| `sap.m.DatePicker`, `DateRangeSelection` | `value` (or `dateValue`) | `date` |
| `sap.m.TimePicker` | `value` (or `dateValue`) | `time` |
| `sap.m.DateTimePicker` | `value` (or `dateValue`) | `datetime` |
| `sap.m.CheckBox`, `RadioButton` | `selected` | `boolean` |
| `sap.m.Switch` | `state` | `boolean` |
| `sap.m.ToggleButton` | `pressed` | `boolean` |
| `sap.m.Select`, `SegmentedButton` | `selectedKey` | `choice` |
| `sap.m.ComboBox` | `selectedKey` (or `value`) | `choice` |
| `sap.m.MultiComboBox` | `selectedKeys` | `multichoice` |
| `sap.m.RadioButtonGroup` | `selectedIndex` | `choice` (keys are indexes) |

With the linter's UI5 metadata (`@abap2ui5/linter/properties`,
`loadSnapshot()`) a control missing from the table inherits the entry of its
nearest mapped ancestor (anything below `sap.m.InputBase` is a `text` field).
Implementations without that metadata use the table alone.

Not fields: controls inside a table template (they are `editableCells`),
values bound to a named model (`{device>/…}`), to a relative path outside a
table (an element binding), or to a formatter/composite (listed in
`unsupported` where relevant).

### actions

One per abap2UI5 event wire in a visible control's attribute —
`.eB(['EVENT', flags…], arg…)` and `.eBP($event, cond, ['EVENT', …], arg…)`:

| Key | Derivation |
| --- | --- |
| `id` | `a<n>` |
| `event` | the first element of the event array |
| `args` | the further arguments, in order: static ones as their value (string, number, boolean), dynamic ones as a descriptor string (below) |
| `label` | Page `navButtonPress` → `Back`; a wire on a field → `<field label>: <trigger>`; else the control's literal `text`, `title`, `tooltip`, `headerText`, `ariaLabel`, else the icon name, else `row <trigger> (<type>)` in a row template, else the trigger |
| `control` | the control the wire sits on |
| `trigger` | the UI5 event (`press`, `change`, `valueHelpRequest`, `selectionChange`, …) |
| `enabled` | the control's `enabled` (literal, bound, expression) |
| `scope` | `row` when the wire sits in a table's row template (`items`/`rows` template, `rowActionTemplate`, `rowSettingsTemplate`) or is a row event on the table itself (`itemPress`, `selectionChange`, `rowSelectionChange`, `cellClick`, `rowPress`, `delete`, `beforeOpenContextMenu`); else `screen` |
| `table` | the table id, only when `scope` is `row` |
| `layer` | the layer of the control |

A wire whose trigger is not shown is skipped: `navButtonPress` needs
`showNavButton`, `valueHelpRequest` needs `showValueHelp`. Controls with
`visible` false (literal, bound, expression) are skipped with their subtree.

**Argument descriptors** (dynamic arguments; the value is filled in by the
client at act time, or passed explicitly in `args`):

| Descriptor | Wire | Filled from |
| --- | --- | --- |
| `$row:<PATH>` | `${PATH}` (relative) | the row given as `row` |
| `$model:/<PATH>` | `${/PATH}` | the model at act time |
| `$source:<prop>` | `${$source>/prop}` | the control's property (resolved in the row for a row action) |
| `$parameters:<path>` | `${$parameters>/path}` | must be passed in `args` |
| `$event` | `$event` | must be passed in `args` |
| `$expr:<raw>` | any other expression (`${QTY} * 10`, an object literal, a formatter call) | must be passed in `args` |
| `$action` | the pressed action of a message box with `onClose` | `args`, default: its first choice |

**Actions that are not view wires** (from the last response's `T_CUSTOM`):
a toast with `onClose` → `trigger: "close"`, `control: "sap.m.MessageToast"`;
a message box with `onClose` → `args: ["$action"]`, the choices in the label
(`close message box (YES | NO)`); `START_TIMER` → `trigger: "timer"`,
`control: "timer"`. They live for one snapshot, as the toast does.

**Frontend actions the client performs itself:** the close wire
`.eF('CONTROL_GLOBAL','VIEW_SLOTS','destroy','POPUP'|'POPOVER')` (what
`_event_client( cs_event-popup_close )` writes) is the action `@CLOSE_POPUP` /
`@CLOSE_POPOVER`. Acting on it closes the slot locally and drops that slot's
unsent edits; nothing goes to the backend, the draft id stays. Every other
`.eF(...)` wire is listed in `unsupported`.

### tables

One per `sap.m.Table`, `List`, `Tree`, `GridList` (and below `ListBase`),
`sap.ui.table.Table`, `TreeTable`, `AnalyticalTable` whose `items`/`rows` is
bound to an absolute default-model path:

| Key | Derivation |
| --- | --- |
| `id`, `path`, `name` | as for fields (`t<n>`) |
| `label` | `headerText`, `title`, the first `Title` in `headerToolbar`/`extension`/`infoToolbar`, else `name` |
| `control` | the table control |
| `columns` | `[{ name, label }]`: sap.m.Table — the cells of the `ColumnListItem` template in order, the label from the column header; list items (`StandardListItem`, …) — their bound properties (label = property name); sap.ui.table — each column's `template`, the label from `label` or the column's label control. `name` is the cell's relative binding path (`TITLE`), else `COL<n>` |
| `rowCount` | length of the bound array |
| `rows` | the first `maxRows` rows (default 20, max 200): per column the cell's main property resolved in the row (`text`, `value`, `selected`, …); plus `selectionField` when there is one |
| `truncated` | `rowCount > rows.length` |
| `selectionMode` | `None`/`Single`/`Multi` from `mode` (sap.m) or `selectionMode` (sap.ui.table, default `MultiToggle` → `Multi`) |
| `editableCells` | columns whose cell is an input-like control bound to a row property and not disabled in every row; plus `selectionField` |
| `layer` | as above |
| `selectionField` | *(extension)* the row property the template's `selected` is bound to (`SELKZ`), when the table selects at all — selecting a row is setting it: `"/T_TAB/2/SELKZ": true` |

Header controls that are more than text (a select-all CheckBox, a sort
Button) and toolbars are described like any control on the screen.

### messages

`{ type, text, source, field? }`, `type` one of `success`, `info`,
`warning`, `error`:

| source | From |
| --- | --- |
| `toast` | `MESSAGE_TOAST show` in the last response (`message_toast_display`, or `CONTROL_GLOBAL`) |
| `box` | `MESSAGE_BOX <method>` in the last response; the method gives the type (`error`, `warning`, `success`, `information` → `info`; `show`, `alert`, `confirm` → `info`) |
| `strip` | a visible `sap.m.MessageStrip` (its `type`) |
| `field` | a field's `valueState` (`Error`/`Warning`/`Success`/`Information`) with `valueStateText`; `field` is the field id. Also a row of the app's message table (`z2ui5.cc.MessageManager items`) whose `TARGET` is a path: `field` is the field id when a field has that path, else the target path |
| `model` | *(extension)* a row of the app's message table without a target |

### texts

Up to 30 distinct strings for context: visible `Text`, `Title`,
`ObjectStatus`, `ObjectAttribute`, `ObjectIdentifier`, `ObjectNumber`,
`ObjectHeader`, `FormattedText` (tags stripped), `ExpandableText`,
`GenericTag`, `core:Title`, `IllustratedMessage` outside tables, resolved
against the model. A text that follows a form label is `"<label>: <text>"`.
The title and table labels are not repeated. Each at most 200 characters.

### unsupported

Free text, at most 30 entries, for what the snapshot saw and cannot
describe: custom controls (any namespace outside `sap.*`, except
`z2ui5.cc.MessageManager`), `sap.ui.core.HTML`, frontend actions (`.eF`
wires other than the popup/popover close, `T_CUSTOM` entries other than
messages, timers and benign ones such as `SET_FOCUS`), tables or fields
bound to a named model, element-bound fields, cut choice lists, unreadable
event handlers.

## Operations

All errors are ordinary tool results with `isError: true` and a sentence
naming what was wrong **and what is allowed**. A refused operation sends
nothing and changes nothing.

### `app_list({ filter? })`

The classes that implement `z2ui5_if_app` **in the build** —
`{ count, apps: [{ app, source: "dev" | "framework" }] }`. Node reads the
transpiled output (a module defining `async z2ui5_if_app$main(`), so an app
deployed after the last build is not listed. ABAP: the implementers of
`z2ui5_if_app`, filtered by the addon's opt-in rules.

### `app_start({ app, values?, max_rows? })` → snapshot

Starts the class (the app-start POST). `values` are applied as pending edits
afterwards (validated against the first snapshot). Node starts the local
backend first, like `run_app`.

### `app_describe({ session, max_rows? })` → snapshot

The current state from the last response kept — no roundtrip.

### `app_act({ session, values?, event?, args?, row?, max_rows? })` → snapshot

1. **Validate**, before anything changes:
   - `values` keys resolve to a field by `id`, `path` or `name`
     (case-insensitive), or to a table cell `"<table path or id>/<row>/<COLUMN>"`.
     Unknown → error listing the editable fields and cells; a field that is
     not `editable`, a column not in `editableCells`, a row out of range, a
     cell disabled in that row → error. Booleans take `true`/`false` (or the
     strings); a `choice` takes one of its `values` keys, a `multichoice` an
     array of them. A value is stored in the type the model holds there (a
     Number input bound to a string attribute stays a string).
   - `event` is an action's `event` or its `id`. Unknown → error listing the
     enabled actions; a disabled action → error. When several actions share
     the event name, the first enabled one wins (the row-scope one when `row`
     is given) — use the id to pick another.
   - A row action whose arguments read the row needs `row` (0-based, within
     `rowCount`); a `$parameters`/`$event`/`$expr` argument needs its value in
     `args` (positional, `null` where the client fills in); a static argument
     cannot be overridden.
   - While a popup is open, the page's fields and actions are refused with
     that reason.
2. **Apply** the values to the client's model.
3. **Without `event`**: the values stay pending (as typing does in the
   browser) and are listed under `pending`; no roundtrip.
4. **With `event`**: the pending edits **of the model the event's view owns**
   go out as `MODEL` delta with `EVENT` and `T_EVENT_ARG`; the answer is
   folded in; the new snapshot carries the new `session`. Pending edits of
   another slot's model stay pending, as in the browser.
5. A backend error (HTTP status, no JSON) → error with the backend's text;
   the session stays at its draft id and the edits are rolled back.

### Sessions

The client keeps the last response per session in memory (Node: the 20 most
recent sessions). Only the **current** draft id of a session is accepted: an
earlier one is refused naming the current one. A session started on a backend
process that has since stopped or restarted is refused (its drafts lived in
that process).

## Deviations and extensions

What differs from Contract B as first written, and why:

- **No `/XX/` two-way prefix.** The current protocol (PROTOCOL 2) binds every
  attribute as `{/NAME}`, and the backend accepts a delta for every bound
  attribute (`z2ui5_cl_ui5_srv_model main_json_to_attri`); `_bind_edit` is an
  alias of `_bind`. Editability is decided by the control. A leading `XX`
  segment is still dropped from `name` for older backends.
- **Values without an event stay pending.** The frontend never sends a
  roundtrip without an event (and apps branch on `check_on_event`), so the
  contract's "else values are kept pending" branch is the one taken; the
  snapshot lists them under the optional `pending` key.
- **`@CLOSE_POPUP` / `@CLOSE_POPOVER`** — event names starting with `@` are
  frontend actions the client performs itself; without them the most common
  popup close (`_event_client( cs_event-popup_close )`) would be unreachable.
- **`selectionField`** on tables — row selection in abap2UI5 is model-bound
  (`selected="{SELKZ}"`), so selecting is a cell edit; the key says which.
- **`source: "model"`** for untargeted messages of the app's message table
  (`z2ui5.cc.MessageManager`), and `field` holds the target path when no
  field has it.
- **Argument descriptors** are spelled `$row:`, `$model:`, `$source:`,
  `$parameters:`, `$event`, `$expr:`, `$action` (the contract named `$row`
  and `$source` as examples).
- **A modal popup hides the page** — only the topmost modal layer is
  described (the contract defined `layer` but not which layers to list).
- **`event` also takes an action id**, and **`max_rows`** is an extra input.
- **Actions from `T_CUSTOM`** (toast/box `onClose`, `START_TIMER`) are
  actions with triggers `close` and `timer`.

## What the snapshot cannot see (yet)

- Anything computed in the browser: formatters, composite and `parts`
  bindings (resolved as text where possible, never editable), expression
  bindings beyond the simple operators (treated as unknown), the values of
  `$parameters`/`$event`/`$expr` arguments.
- Client-only state: a table's selection without a `selected` binding, a
  growing table's loaded page, the open tab of an IconTabBar (all tabs'
  content is described), scroll position, focus.
- Named models (`i18n`, `device`, `message`, OData models in switch mode),
  XML templating (`template:repeat`), element bindings (`bindElement`).
- Custom controls (`z2ui5.cc.*` other than the MessageManager, any
  non-`sap.*` namespace) and `sap.ui.core.HTML` — listed, not described.
- Frontend actions (`.eF` wires, `T_CUSTOM` entries such as `OPEN_NEW_TAB`,
  `CLIPBOARD_COPY`, `STORE_DATA`) — listed, not performed; a timer is an
  action the agent fires, never fired by itself.
- Nested tables and tree hierarchies below the first level, MultiInput
  tokens, file uploads, drag and drop.
