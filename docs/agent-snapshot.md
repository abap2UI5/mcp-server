# Agent snapshot v1 and the app tools

> **Normative version: the semantic profile of abap2UI5/protocol,
> [`profiles/semantic.md`](https://github.com/abap2UI5/protocol/blob/main/profiles/semantic.md)**
> (schema: [`schema/snapshot.schema.json`](https://github.com/abap2UI5/protocol/blob/main/schema/snapshot.schema.json)).
> Snapshot v1 moved there from this page (at `ea4e9fa`); where the two
> differ, the profile wins. This page stays the reference for this
> repository's implementation - the tools, the client's options, its
> deviations - and a change of the snapshot shape is a change of the
> profile too. The client's protocol behaviour is checked by the protocol's
> frontend suite: `abap2ui5-conformance frontend --adapter agent`
> (`MCP_SERVER_HOME` runs a checkout instead of the vendored copy).

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

The same snapshot can be shown to the USER in the chat - as an MCP Apps
screen or an Adaptive Card - whose actions come back as `app_act` calls:
[The screen in the chat](#the-screen-in-the-chat-mcp-apps-and-adaptive-cards).

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
| `title` | the title of the topmost layer: a Dialog/SelectDialog/TableSelectDialog/Popover `title`, else the Page `title`, else a `sap.f.DynamicPageTitle` heading |
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

**Versioning.** `snapshotVersion` stays `1` for additive changes: a new
optional key, a new enum value, a control described that was not before.
Consumers ignore keys they do not know and treat an unknown enum value as
text. A renamed or removed key, a changed type or a changed meaning of an
existing value bumps the version (and is listed here). The additions to v1
so far, all additive:

| Added | What |
| --- | --- |
| `tables[].control` `sap.m.SelectDialog`, `sap.m.TableSelectDialog` | selection dialogs are tables; their `confirm` is a row action (the pick, see [the pick](#the-pick-a-selection-dialogs-confirm)) |
| `messages[].source` `popover`, `messageview` | the items of a `sap.m.MessagePopover` / `sap.m.MessageView` |
| `messages[].subtitle`, `messages[].description` | optional, on those items |

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
| `scope` | `row` when the wire sits in a table's row template (`items`/`rows` template, `rowActionTemplate`, `rowSettingsTemplate`) or is a row event on the table itself (`itemPress`, `selectionChange`, `rowSelectionChange`, `cellClick`, `rowPress`, `delete`, `beforeOpenContextMenu`, and a selection dialog's `confirm`); else `screen` |
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
| `$parameters:<path>` | `${$parameters>/path}` | for a row event, the row given as `row` ([row event parameters](#row-event-parameters)); else must be passed in `args` |
| `$event` | `$event` | must be passed in `args` |
| `$expr:<raw>` | any other expression (`${QTY} * 10`, an object literal, a formatter call) | for a row event, the [call shapes](#row-event-parameters) on a row-valued parameter; else must be passed in `args` |
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
`sap.m.SelectDialog`, `sap.m.TableSelectDialog`, `sap.ui.table.Table`,
`TreeTable`, `AnalyticalTable` whose `items`/`rows` is bound to an absolute
default-model path:

| Key | Derivation |
| --- | --- |
| `id`, `path`, `name` | as for fields (`t<n>`) |
| `label` | `headerText`, `title`, the first `Title` in `headerToolbar`/`extension`/`infoToolbar`, else `name` |
| `control` | the table control |
| `columns` | `[{ name, label }]`: sap.m.Table and TableSelectDialog — the cells of the `ColumnListItem` template in order, the label from the column header; list items (`StandardListItem`, …, the SelectDialog's) — their bound properties (label = property name); sap.ui.table — each column's `template`, the label from `label` or the column's label control. `name` is the cell's relative binding path (`TITLE`), else `COL<n>` |
| `rowCount` | length of the bound array |
| `rows` | the first `maxRows` rows (default 20, max 200): per column the cell's main property resolved in the row (`text`, `value`, `selected`, …); plus `selectionField` when there is one |
| `truncated` | `rowCount > rows.length` |
| `selectionMode` | `None`/`Single`/`Multi` from `mode` (sap.m) or `selectionMode` (sap.ui.table, default `MultiToggle` → `Multi`); a selection dialog is `Multi` when `multiSelect` is true, else `Single` |
| `editableCells` | columns whose cell is an input-like control bound to a row property and not disabled in every row; plus `selectionField` |
| `layer` | as above |
| `selectionField` | *(extension)* the row property the template's `selected` is bound to (`SELKZ`), when the table selects at all — selecting a row is setting it: `"/T_TAB/2/SELKZ": true` |

Header controls that are more than text (a select-all CheckBox, a sort
Button) and toolbars are described like any control on the screen.

**Selection dialogs** (`SelectDialog`, `TableSelectDialog`) are tables of the
layer they are in — usually `popup` (`popup_display` of a fragment with the
dialog), or `main` for one in a view's `dependents` that a frontend action
opens. Their wires are actions of the dialog: `confirm` is a **row action**
(`scope: "row"`, `table` its id) — the pick — and `search`, `liveChange`,
`cancel` are screen actions (`${$parameters>/value}`, the search term, is an
`args` value). A value help built as a `Dialog` with a `Table` is an ordinary
table with a `selectionField`.

### messages

`{ type, text, source, field?, subtitle?, description? }` (keys in this
order, the optional ones only when set), `type` one of `success`, `info`,
`warning`, `error`:

| source | From |
| --- | --- |
| `toast` | `MESSAGE_TOAST show` in the last response (`message_toast_display`, or `CONTROL_GLOBAL`) |
| `box` | `MESSAGE_BOX <method>` in the last response; the method gives the type (`error`, `warning`, `success`, `information` → `info`; `show`, `alert`, `confirm` → `info`) |
| `strip` | a visible `sap.m.MessageStrip` (its `type`) |
| `field` | a field's `valueState` (`Error`/`Warning`/`Success`/`Information`) with `valueStateText`; `field` is the field id. Also a row of the app's message table (`z2ui5.cc.MessageManager items`) whose `TARGET` is a path: `field` is the field id when a field has that path, else the target path |
| `model` | *(extension)* a row of the app's message table without a target |
| `popover` | *(extension)* a `MessageItem` (or `MessagePopoverItem`) of a `sap.m.MessagePopover` — whether it is open or not: one in a view's `dependents` opens through a frontend action the client does not perform, and its items are the messages the app shows there |
| `messageview` | *(extension)* a `MessageItem` of a `sap.m.MessageView` (on the page, or in a dialog) |

A message list's items are static `MessageItem`s, or the one template of a
bound `items` resolved per row of an absolute default-model path (a list bound
to a named model — the `message` model — is noted in `unsupported`). Per item:
`type` from the item's `type` (`Error`/`Warning`/`Success`/`Information`;
`None` and any other value → `info`; absent or empty → `error`, UI5's
default), `text` its `title`, `subtitle` and `description` when not empty
(`description` with the tags stripped when `markupDescription` is true); an
item whose title, subtitle and description are all empty is skipped. `text`,
`subtitle` and `description` are clipped at 1000 characters. At most 50
messages per list (the cut is noted in `unsupported` as `<MessagePopover |
MessageView> (<layer>): <n> messages, the first 50 listed`). The list's own
wires (`activeTitlePress`, `beforeClose`, …) are actions like any other; its
`items` are not walked further (a MessageItem's link is not described).

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
     `rowCount`); a `$parameters`/`$expr` argument the row does not fill (see
     [row event parameters](#row-event-parameters)) and every `$event`
     argument needs its value in `args` (positional, `null` where the client
     fills in); a static argument cannot be overridden.
   - A selection dialog's `confirm` is [the pick](#the-pick-a-selection-dialogs-confirm).
   - While a popup is open, the page's fields and actions are refused with
     that reason.
2. **Apply** the values to the client's model.
3. **Without `event`**: the values stay pending (as typing does in the
   browser) and are listed under `pending`; no roundtrip.
4. **With `event`**: the pending edits **of the model the event's view owns**
   go out as `MODEL` delta with `EVENT` and `T_EVENT_ARG`; the answer is
   folded in; the new snapshot carries the new `session`. Pending edits of
   another slot's model stay pending, as in the browser.
5. A backend error (HTTP status, no JSON, another `PROTOCOL`) → error with
   the backend's text, shown verbatim (a `<b>` in it is text - the body is
   `text/plain`, protocol `spec/errors.md`; only shortened, and control
   characters shown as U+FFFD); the session stays at its draft id and the
   act's own edits are rolled back. A response declaring a `PROTOCOL` other
   than 2 is refused whole - its draft id, view and model included - naming
   both numbers; a response without `PROTOCOL` is let through.
6. **One roundtrip at a time** per session: an `app_act` with an `event`
   while another is in flight waits for it, then runs on the screen and the
   draft id that one left (so it may name the draft id the one in flight
   continues). `values` without an event start no roundtrip and apply at
   once, as typing does while the browser waits; the roundtrip in flight
   clears only the edits it carried, so these stay pending, survive its
   model push and travel with the next event.

### The pick: a selection dialog's confirm

In the browser a `SelectDialog`/`TableSelectDialog` confirms when a row is
clicked (single select) or when OK is pressed after rows were ticked (multi
select); the row items' `selected` is two-way bound (`selected="{ZZSELKZ}"`,
the table's `selectionField`), so the selection travels with the confirm as
the model delta, and the confirm's event parameters are the selected rows.
`app_act({ event: <the confirm>, row })` does the same, in this order, after
`values` are applied:

1. `row` must be within `rowCount` (else *table t1 has N row(s) - row R does
   not exist (rows are 0-based)*).
2. With a `selectionField` and `row`: single select sets every other row's
   field that is truthy to `false`, then the row's to `true` unless it is
   already `true`; multi select sets the row's to `true` unless it is already
   `true` (a pick adds to the selection; untick a row through `values`). Each
   write is a pending edit of the dialog's model and goes out with the
   confirm as its delta — only what changed, as the browser's two-way
   binding writes only changes. (The model path of a data reference ends in
   `*`, `/MR_TAB_POPUP/*/0/ZZSELKZ`; the delta then ships the whole
   attribute, as the frontend's `buildDeltaFromPaths` does.)
3. The selected rows: with a `selectionField`, every row whose field is
   truthy, in model order (a sorter of the items binding is not applied);
   without one, the row given. In single select it is the row given.
4. Single select with no row selected (no `row`, nothing truthy) is refused:
   *action aN (EVENT) picks a row of table tN (N rows) - pass `row` (0-M)*.
   Multi select without `row` confirms what is selected — possibly nothing.
5. The arguments are filled from the selected rows (below); one the client
   cannot compute is refused naming `args[i]`, and the refusal rolls the
   pick back with everything else.

### Row event parameters

`${$parameters>/…}` arguments are the UI5 event's parameters. For the events
whose parameters ARE the row, the client fills them from the row(s) — the
row given as `row`, or the selected rows of a pick:

| Event | Parameters |
| --- | --- |
| selection dialog `confirm` | `selectedItem` (the first selected row's item, `null` with none), `selectedItems` (one item per selected row), `selectedContexts` (one binding context per selected row) |
| `sap.m` list/table `itemPress`, `selectionChange`, `delete`, `beforeOpenContextMenu` (on the table) | `listItem` |
| `sap.ui.table` `rowSelectionChange` | `rowIndex` (the row), `rowContext` |
| `sap.ui.table` `cellClick` | `rowIndex`, `rowBindingContext` |
| `sap.ui.table` `beforeOpenContextMenu` | `rowIndex` |
| a wire in a grid table's `rowActionTemplate` (RowActionItem `press`) | `row` |

Any other parameter of these events (`selected`, `listItems`,
`columnIndex`, `srcControl`, …) and every parameter of other events must be
passed in `args`. A table row event never selects the row by itself — only
the pick does.

`$parameters:<path>` is resolved the way UI5 resolves it: the parameters sit
in a `JSONModel` (`EventHandlerResolver`), whose path is split at `/` and
walked key by key (`JSONModel._getObject`). So a segment with `[` or `]` reads
`undefined` (checked before anything else) — `${$parameters>/selectedContexts[0]/sPath}`, the wire of
abap2UI5's `z2ui5_cl_pop_to_select` and the popups addon's
`z2ui5_cl_popup_to_select`, is `undefined` in the browser and is sent as
`null` (the JSON of `undefined` in the argument array); write
`${$parameters>/selectedContexts/0/sPath}` to get the path. A binding context
answers `sPath` (`<table path>/<row>`, e.g. `/T_TAB/2`), an array its index
and `length`; a path that ends at an item or a context (the browser sends the
control marshalled with all its properties) or goes into one any further, or
names a parameter outside the table above, is refused naming `args[i]`.

`$expr:` arguments are filled for these shapes on a row-valued parameter `P`
(whitespace around `.` and inside `()` is allowed), and refused naming
`args[i]` otherwise:

| Shape | Value |
| --- | --- |
| `${$parameters>/P}.getBindingContext().getPath()`, `${$parameters>/P}.getPath()` (`P` a context) | `<table path>/<row>` |
| `${$parameters>/P}.getBindingContext().getProperty('X')`, `${$parameters>/P}.getProperty('X')` (`P` a context) | the row's `X` as the model holds it, `null` when absent |
| `${$parameters>/P}.get<Prop>()` (`P` an item of a sap.m list or table) | the item template's `<prop>` attribute (first letter lower case) resolved in the row like a cell value; a number becomes its string; not set or unresolvable → refused. `getId()` is refused (control ids are generated) |
| `${$parameters>/P}.getCells()[n].get<Prop>()` | the same on the n-th cell: every cell of a `ColumnListItem`, the visible columns' templates of a grid table row |
| `${$parameters>/P} ? <one of the above> : <literal>` | the shape when `P` is an item or a context (or truthy), else the literal (`'…'`, `"…"`, `null` or a number) |

Example — the abap-cloud-gui F4 popup (`z2ui5_cl_popup_to_select`, single
select, `selected="{ZZSELKZ}"`): `app_act({ event: "CONFIRM", row: 0 })`
sends `T_EVENT_ARG: [null]` and `MODEL: { "MR_TAB_POPUP": { "*": [ … the
filtered rows, row 0 with "ZZSELKZ": true … ] } }`; the popup reads
`ZZSELKZ` and hands the row back. A `SelectDialog` with
`confirm=".eB(['VH_CONFIRM'], ${$parameters>/selectedItem}.getTitle())"`
and `<StandardListItem title="{NAME}"/>` sends the picked row's `NAME`.

### Sessions

The client keeps the last response per session in memory (Node: the 20 most
recent sessions). Only the **current** draft id of a session is accepted: an
earlier one is refused naming the current one. A session started on a backend
process that has since stopped or restarted is refused (its drafts lived in
that process) — on the local backend; an embedder without a process to watch
leaves the check out (see below).

A stateful app's session id travels as the browser frontend sends it
(protocol `spec/transport.md`): every POST asks for it in a header
(`sap-contextid-accept: header`), the last `sap-contextid` response header
of a session is sent with every later POST of that session (a response
without it keeps it; it is never sent empty or as `undefined`), and another
session of the same client starts without one.

## The screen in the chat: MCP Apps and Adaptive Cards

The snapshot is the agent's view. This server can also show the same screen
to the user in the chat - and nothing here is a second protocol client: both
surfaces send what the user does as `app_act` calls, which validate exactly
like the agent's own (an action not on the snapshot, a field that is not
editable, a choice outside its values is refused, nothing is sent).

**MCP Apps** (SEP-1865, extension `io.modelcontextprotocol/ui`, stable spec
2026-01-26 of modelcontextprotocol/ext-apps). `app_start`, `app_describe` and
`app_act` carry `_meta.ui.resourceUri = "ui://abap2ui5/app-screen"` (plus the
deprecated flat `_meta["ui/resourceUri"]`, which the spec's SDK still writes)
when the client advertised the extension with `text/html;profile=mcp-app`, or
when `A2UI5_MCP_UI=on`. The resource (`lib/mcp-app.mjs`, the page logic in
`lib/mcp-app-view.mjs`) is one HTML document without any external URL, so it
declares no `_meta.ui.csp` and runs under the host's restrictive default.
Over the postMessage bridge the page:

| Step | Message |
| --- | --- |
| handshake | `ui/initialize` (`protocolVersion` 2026-01-26) -> `ui/notifications/initialized` |
| show | `ui/notifications/tool-result`: the result's text block (or `structuredContent`) parsed as snapshot v1 and rendered - fields as inputs, actions as buttons (a message box close action as one button per choice), tables with their editable cells and row actions, messages, texts, `pending`, `unsupported` |
| act | a button press -> `tools/call` `app_act { session, event: <action id>, values: { <field id or cell path>: value } of the inputs the user CHANGED, row?, args?: the box choice at the `$action` position, max_rows?: the tool input's }` - only when the host proxies tool calls (`hostCapabilities.serverTools`), one at a time |
| refresh | `tools/call` `app_describe { session }` |
| tell the model | after a successful act, `ui/update-model-context` with what was sent and the new session (when the host offers `updateModelContext`) |
| size, teardown | `ui/notifications/size-changed`; `ui/resource-teardown` and `ping` answered |

The page calls no other tool. An `app_act` the agent makes later with the
session it last saw is refused naming the current one (Sessions, above), so
an agent and a user operating the same session cannot overwrite each other.

**Adaptive Cards.** `format: "adaptive-card"` (or
`A2UI5_MCP_APP_FORMAT=adaptive-card`) appends the screen as an Adaptive Card
1.5 to the result - `{ type: "resource", resource: { uri:
"abap2ui5://app-card/<session>", mimeType:
"application/vnd.microsoft.card.adaptive", text: <card JSON> } }` - after the
unchanged snapshot. The card is rendered by abap2UI5/protocol's
`renderers/adaptive-cards` (vendored, `lib/vendor/adaptive-cards`) from the
session's folded state (`client.screen(session)`); inputs carry their binding
path as id. Each `Action.Submit`'s `data` gets `session`, and a row's action
`row`. A card host submits the action's data merged with every input; this
maps to ONE `app_act` (`cardSubmitToAct(snapshot, payload)` in
`lib/adaptive-card.mjs`):

| Submitted | app_act argument |
| --- | --- |
| `data.session` | `session` (the snapshot's when absent) |
| `data.event` | `event` (the event name: the first enabled action of that name, the row action when `row` is given) |
| `data.row` | `row` |
| `"/PATH": value`, `"/TAB/<row>/<COL>": value` (`#n` duplicates folded) | `values["/PATH"]` - only when it differs from the snapshot; `"true"`/`"false"` of a boolean become booleans, a multi-select's `"A,B"` becomes `["A","B"]` |
| `data.box: "<button>"` | `event`: the message box close action, `args`: the button at its `$action` position; a box without `onClose` maps to nothing (`null`) |
| `data.client: ["CONTROL_GLOBAL","VIEW_SLOTS","destroy","POPUP"\|"POPOVER"]` | `event: "@CLOSE_POPUP"` / `"@CLOSE_POPOVER"` |
| `data.args`, `data.refs` | dropped - app_act computes the arguments from the model at act time, after the edits |
| any other `data.client` | refused: a frontend action only a browser performs |

What the card shows is the renderer's portable profile v1 (its README lists
the mapping and its limits: no `change` events, growing tables show every
row, `sap.ui.table` and nested views are placeholders); controls outside it
are placeholders, so a row action of a grid table is on the snapshot but not
on the card.

## Embedding the client

`lib/appclient.mjs` is written to be copied: the VS Code extension vendors it
with `lib/snapshot.mjs` and `lib/viewxml.mjs`, unchanged, and runs it against
a real SAP system. This server embeds it the same way in its system mode
(`lib/system.mjs`, `createSystemClient`). Every assumption about the local backend is therefore an
option of `createAppClient`, with the local backend's behaviour as the
default:

| Option | Default (local backend) | On a real system |
| --- | --- | --- |
| `transport({ method, body, headers, signal, draftId })` → `{ status, headers?, body }` | one `fetch` of `baseUrl` (`fetchImpl`): a POST of `body`, or the CSRF token fetch's HEAD | the embedder's own request: auth, cookies, a proxy |
| `location(app)` → `{ origin, pathname, search }` (may be async) | `baseUrl` without the trailing slash, `/`, `?app_start=<app>` | the system's launch URL, never a proxy's |
| `generation()` | absent: no restart detection (the MCP server passes its backend process id) | absent |
| `backendHint` | `is it running? backend { action: "status" } says` | the embedder's own pointer, or `''` |

- **`transport`** sends ONE request, as given. `method: 'POST'` is a
  roundtrip: `body` the serialized request
  (`{"value":{"S_FRONT":…,"MODEL":…}}`), `headers` what the frontend sends
  (`content-type: application/json`, `sap-contextid-accept: header`, and -
  once the backend handed them out - the session's `sap-contextid` and the
  `x-csrf-token`). `method: 'HEAD'` is the CSRF token fetch
  (`x-csrf-token: Fetch`, no body). `signal` is the client's timeout
  (`timeoutMs`, 120 s, one for the roundtrip and its handshake), `draftId`
  the `S_FRONT.ID` the request continues — `null` for an app start. Its
  answer is `{ status, headers?, body }`; the client reads `sap-contextid`
  and `x-csrf-token` from `headers` (any case, a repeated header joined), a
  status outside 2xx is the backend's refusal (its body shown verbatim), and
  a throw is *the backend did not answer (…)*. **The client does both
  handshakes itself** — the stateful session id per session, and a token
  layer's `403` + `X-CSRF-Token: Required` answered by the HEAD and one
  re-send of the same body, the token then sent with every POST (a `403`
  without `Required` is the backend's own gate and final) — so a transport
  must not do them again: it adds what only the embedder has (credentials,
  cookies, routing). With a transport, `baseUrl` and `fetchImpl` are unused
  (unless the default `location` needs `baseUrl`).
- **`location`** builds the app start's `ORIGIN`/`PATHNAME`/`SEARCH`. The
  backend builds URLs out of them and keeps them with the app's session, so
  they must be what a browser would send; `search` has to name the class
  (`app_start=<app>`, next to whatever else the launch URL carries). A throw
  reaches the caller unchanged and sends nothing — throw an `AgentError` to
  refuse (a launch URL with the class in its path).
- **`generation`** names the backend process: a session started under
  another generation is refused (*started on a backend that has since stopped
  or restarted*). Absent, sessions are never orphaned — a real system keeps
  its drafts across the embedder's restarts of anything.
- **`backendHint`** is the pointer appended to *the backend did not answer
  (…)* after a dash; the empty string appends nothing. No other message names a
  local-backend tool.

`metadata()`, `maxSessions` and `timeoutMs` are the same for every embedder.

`screen(session)` answers a copy of a session's folded state (the views in
their slots, the models with the pending edits, the last `T_CUSTOM`) - what a
renderer other than the snapshot needs; the Adaptive Card above is one.

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
- **Selection dialogs are tables and their `confirm` is the pick** — the
  contract described table controls only; without the dialogs an agent could
  open a value help and read the model, but not choose a row.
- **`$parameters` of row events are filled from the row**, with UI5's
  JSONModel path semantics (a `[n]` segment is `null`, as in the browser).
- **`source: "popover"` / `"messageview"`** with the optional `subtitle` and
  `description` — the message lists of sap.m (abap-cloud-gui collects every
  message of a run in a MessagePopover).
- **Actions from `T_CUSTOM`** (toast/box `onClose`, `START_TIMER`) are
  actions with triggers `close` and `timer`.

## What the snapshot cannot see (yet)

- Anything computed in the browser: formatters, composite and `parts`
  bindings (resolved as text where possible, never editable), expression
  bindings beyond the simple operators (treated as unknown), the values of
  `$parameters`/`$event`/`$expr` arguments beyond the row event shapes above
  (a control-valued parameter such as a MessagePopover's
  `${$parameters>/item}` is marshalled by the browser with all its
  properties - pass what the app reads).
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
