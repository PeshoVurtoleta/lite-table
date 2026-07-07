# Changelog

All notable changes to `@zakkster/lite-table` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-07-03

Row grouping, per-column aggregation, sticky group headers, and a sticky grand-total row. All feature additions are opt-in; consumers of 1.1.0 who don't pass `groupBy` are on the identical fast path they had in 1.1.0.

### Added — Row grouping

- **`CreateTableConfig.groupBy?: string | string[] | null`** — group rows by one or more column keys. `null` (default) or `[]` is the ungrouped fast path — byte-identical to 1.1.0. A bare string is normalized to `[string]`. Unknown column keys are silently dropped so persisted state that outlives a column config survives without crashes.
- **`CreateTableConfig.initialCollapsedGroups?: string[][]`** — pre-seed the collapsed set. Each entry is a group path (e.g., `[["Europe"], ["Asia", "Books"]]`). Unknown paths become no-ops when their groups don't exist.

- **`table.groupBy: Signal<readonly string[]>`** — the raw group-key signal. Read-only for consumers; use `setGroupBy` to mutate.
- **`table.collapsedGroups: Signal<ReadonlySet<string>>`** — path-strings (U+001F separator) of currently-collapsed groups. Read-only for consumers; mutate via `toggleGroup` / `collapseGroup` / `expandGroup` / `expandAllGroups` / `collapseAllGroups`.
- **`table.groupedRows: Computed<GroupNode[] | null>`** — tree of `GroupNode`s (recursive `subGroups` at internal nodes, `rows` at leaves) sorted by group key ascending. Returns `null` when ungrouped, so consumers can branch on it to render a flat list without walking the tree.
- **`table.visibleEntries: Computed<Entry[]>`** — flat interleaved list of `{type: "data" | "group-header" | "grand-total"}` entries. Drives the mount layer's slot rendering. Length matches `entryCount()`.
- **`table.entryCount: Computed<number>`** — total entry count including group headers + grand total. Drives the virtual axis in the mount layer. `rowCount()` (data-only) is kept as a separate consumer stat.

- **Methods:**
  - `setGroupBy(v)` — idempotent; unknown keys dropped.
  - `toggleGroup(path)` / `expandGroup(path)` / `collapseGroup(path)` — mutate the collapsed set for one path.
  - `expandAllGroups()` — clears the collapsed set.
  - `collapseAllGroups()` — walks `groupedRows()` once to add every group path to the collapsed set.
  - `isGroupCollapsed(path)` — O(1) predicate.
  - `groupAncestryAt(entryIndex)` — the group headers that CONTAIN the entry at `entryIndex`, deepest last. Empty when ungrouped or when the target is a group header itself (its ancestors are strictly shallower). Used by consumers implementing their own sticky group-header overlays.

### Added — Aggregation

- **`ColumnDef.aggregate?: AggregateSpec | null`** — opt-in per column. Built-ins: `"sum"`, `"avg"`, `"min"`, `"max"`, `"count"`. Custom function: `(rows, col) => any` — receives the leaf-row array for the fold and returns any value. Aggregates always fold over LEAF rows at every depth (safe default for reducers that don't compose associatively — median, last-value-wins, `distinct-count`). Nullish values are skipped for `sum` / `avg` / `min` / `max`; `count` counts rows unconditionally.
- **`ColumnDef.aggregateFormat?: (value, col, count) => string`** — display formatter for group-header and grand-total cells. `entry.aggregates.get(key)` still returns the raw value so exports and custom renderers stay authoritative. Errors thrown by the formatter are caught and logged; the raw value is displayed as fallback.
- **`CreateTableConfig.showGrandTotal?: boolean`** — append a grand-total entry at the tail of `visibleEntries`. Grand-total aggregates fold over `filteredRows()` and are stable across collapse operations.

### Added — Sticky group headers + sticky grand total

Both are built into `mountTable` and render automatically when their prerequisites are met (any `groupBy`, any `showGrandTotal`). Zero-flow-space `position: sticky` containers holding absolute-positioned rows:

- **`.lt-sticky-groups`** — direct child of `.lt-viewport`, before `.lt-inner`. Sticks at `top: rowHeight` (below the column header). Contains one `.lt-sticky-group` row per active depth level; each row is a `<div class="lt-row-group-header lt-sticky-group" data-depth="N" data-collapsed="...">`. Reactively updates from `groupAncestryAt(axis.firstIndex())` — using `firstIndex` (not `start`) so sticky reflects what's actually visible at the top of the viewport, not the overscan-inflated slot window.
- **`.lt-sticky-grand-total`** — direct child of `.lt-viewport`, after `.lt-inner`. Sticks at `bottom: 0`. Contains one `.lt-sticky-grand-total-row` (a `<div class="lt-row-grand-total lt-sticky-grand-total-row">`).
- **Click on a sticky group header** toggles its group's collapsed state — same UX as clicking the inline pool-rendered header.
- **Sticky rows do NOT carry the `.lt-row` base class**, so `querySelectorAll(".lt-row")` still counts only pool slots (backwards-compatible with any 1.0/1.1 consumer inspecting the DOM this way). Their layout comes from inlined `display: grid; grid-template-columns: var(--lt-cols)`.

### Pipeline

```
rowsGetter() -> filteredRows -> groupedRows -> visibleEntries -> pool + sticky
                                       │              │
                                       │              └── mount renders per entry.type
                                       └── sort applies WITHIN each leaf group
```

- Filter runs BEFORE grouping. Empty groups vanish — no dead headers.
- Sort chain applies WITHIN leaves. Groups themselves are ordered by group key ascending; `null` values bucket last.
- The ungrouped fast path (`groupBy: []`) short-circuits `groupedRows` to `null` and `visibleRows` returns the sort-applied rows directly — one signal read of overhead vs 1.1.0.

### DOM

Rendered under `mountTable`:

- **Group header row** — `<div class="lt-row lt-row-group-header" data-depth="N" data-collapsed="true|false">` with one cell per column matching the data-row grid template.
  - **First visible cell** holds the chevron (`▼` when expanded, `▶` when collapsed) + the group's identifying value + `(N)` row count.
  - **Other cells** hold the column's aggregate value if configured, empty otherwise.
  - **Indent per depth** via CSS (`padding-left: 12px / 28px / 44px / 60px / 76px` for depths 0-4).
  - **First cell overflows visibly** (`overflow: visible; white-space: nowrap`) so the label + chevron + count aren't truncated in narrow first columns.
  - **Aggregate cells** right-align with `font-variant-numeric: tabular-nums` for cross-header column alignment.
- **Grand-total row** — `<div class="lt-row lt-row-grand-total">` with the same cell structure. First cell reads `Total (N)`.
- **Sticky elements** — see the "Sticky group headers + sticky grand total" section above.

### Interaction

- **Click on a group-header cell** (inline or sticky) toggles the group's collapse. The delegated `pointerdown` on `.lt-root` dispatches on `entry.type` and calls `toggleGroup(entry.path)` for headers.
- **Click on a grand-total row** is ignored (no selection change, no side effect).
- **Selection and edit machinery** are gated on `entry.type === "data"`. Clicking a header does not clear the row selection, and editable cells stay non-editing on headers.
- **Focus / keyboard nav** stays inside data rows — `moveFocus` reads `visibleRows()` (data-only) so arrow-up/down skip over headers, matching the 1.1.0 focus model.

### Reactive column state carries over

- Column reorder, hide, resize, and pin ALL apply to sticky rows: sticky cells register the same `colPlacement` + `pin` effects that pool cells do, so hiding the first-visible column shifts the chevron+label to the next one, reordering keeps sticky and pool aligned, and pinning applies to sticky cells too.

### Zero-GC preservation

- Scroll fast path unchanged: 1 transform write per pool slot per boundary cross. `slotEntry` (the new per-slot computed added by M3) is allocated once at mount and re-read reactively — no new allocation per scroll.
- Grouped 100k-row / 10k boundary scrolls with sticky overlays active: **signal-node delta 0, link delta 2 (noise floor), pool delta 0** — verified via `bench/03-heap-grouped.js`.

### Fixed — Stale `.lt-row` count in mount DOM

Consumers reading `mount.root.querySelectorAll(".lt-row").length` (as the 1.1.0 test suite does to count pool slots) previously would have picked up the sticky rows too. Sticky rows now carry only their discriminator classes (`.lt-sticky-group`, `.lt-sticky-grand-total-row`, plus their `.lt-row-group-header` / `.lt-row-grand-total` styling class). Grid layout is inlined on sticky rows so the missing `.lt-row` base rule doesn't affect them.

### Types

`Table.d.ts` extended with:

- `AggregateSpec<Row>` type
- `GroupNode<Row>` interface
- `Entry<Row>` union — `DataEntry` | `GroupHeaderEntry` | `GrandTotalEntry`
- `ColumnDef.aggregate`, `ColumnDef.aggregateFormat`
- `CreateTableConfig.groupBy`, `initialCollapsedGroups`, `showGrandTotal`
- `TableCore.groupBy`, `collapsedGroups`, `groupedRows`, `visibleEntries`, `entryCount`
- `TableCore.setGroupBy`, `toggleGroup`, `expandGroup`, `collapseGroup`, `expandAllGroups`, `collapseAllGroups`, `isGroupCollapsed`, `groupAncestryAt`

### Tests

- **44 headless tests** in `test/grouping.test.js`: config parsing, tree structure (single- and multi-level), aggregate types with null handling and custom-function support, leaf-fold correctness, `visibleEntries` interleave, backwards compat with the ungrouped fast path, sort within groups, filter-then-group interaction, collapse/expand/all, grand-total stability across collapse, `groupAncestryAt`, reactive propagation via signal-backed rows, edge cases.
- **17 DOM tests** in `test/grouping.dom.test.js` (happy-dom): row classes, first-cell chevron+count, aggregate cell rendering, click-to-toggle, click preserves selection, grand-total class + content, chevron flip via `data-collapsed`, `entryCount` drives virtual axis, data-row selection interleaved with headers, collapse hides data rows immediately, dispose cleanup, sticky containers in the correct viewport slots, sticky hidden when ungrouped, sticky grand-total hidden when unconfigured, hiding the first column shifts chevron to the next, column reorder keeps sticky + pool aligned, filter-row + grouping coexist.
- **All 196 pre-existing tests in the 1.1.0 suite pass unchanged.** Total: **257 tests across 14 files.**

### Benchmarks

- **`bench/03-heap-grouped.js`** — the M3 companion to `03-heap.js`. Same 100k-row / 10k boundary-scroll shape but with `groupBy: "status"` + `showGrandTotal: true` + sticky overlays active. Signal-node delta 0, link delta 2 (noise), pool delta 0.

### Documentation

- New **"Grouping and aggregation"** section in README with a full pipeline diagram, config tables, API surface, methods list, sticky-headers note, DOM structure, and performance notes.
- "What this is not" bullet updated: "no cell editing yet, no row groups, no aggregations" struck; only "no in-place pagination" remains (as always, all three are buildable on top).
- Testing strategy section updated: 251 → 257 tests across 14 files, plus the new `grouping.test.js` and `grouping.dom.test.js` enumerated.
- Benchmarks section adds `03-heap-grouped.js` to the bench table.
- `llms.txt` extended with the M3 grouping / aggregation surface, sticky DOM contract, and updated file inventory.

### Demo

`demo/index.html` picks up an M3 "Group & Aggregate" panel between the Sort/Filter and Columns panels:

- **Three grouping targets** — `None` (ungrouped fast path), `By status` (single-level, 4 groups), `Region → Status` (two-level, 5 × 4 = 20 leaf groups). Active target is highlighted via a reactive `.is-active` class bound to `table.groupBy()`.
- **Expand all / Collapse all** buttons — one-click walk over `groupedRows()` to seed / clear the entire collapsed set.
- **Live group status line** — reads `groupBy()` + `entryCount()` + `collapsedGroups().size` reactively, e.g. `group: region → status · entries: 100,026 · collapsed: 0`.

The demo dataset gains a fifth `region` field (`Europe`, `Asia`, `Africa`, `Americas`, `Oceania`) to make multi-level grouping visibly meaningful. The `value` column carries an `aggregate: "sum"` with a `$X,XXX` formatter; the `id` column uses `aggregate: "count"` (renders as `N rows` in group headers). `showGrandTotal: true` pins a `Total (100,000) · $49,999,991` row to the bottom of the viewport across all grouping modes -- when a filter narrows the data, the sticky footer recomputes reactively.

The dark-theme overrides for `.lt-row-group-header` / `.lt-row-grand-total` / sticky rows are in the demo's stylesheet (the built-in library palette is tuned for a light background). Existing consumers with a dark theme can copy the same block.

Footer picks up an `Entries: N` stat next to `Rows: N` so the grouping overhead is visible at a glance (100k rows → 100,026 entries at `region → status`).

### Compatibility

Drop-in for 1.1.0. Every M3 feature is opt-in: no `groupBy` config → no grouping, no `aggregate` on any column → no aggregation, no `showGrandTotal` → no grand total. Peer dependencies unchanged: `@zakkster/lite-signal ^1.2.1`, `@zakkster/lite-signal-dom ^1.0.1`, `@zakkster/lite-virtual ^1.1.0` (M3 uses `axis.firstIndex()` from lite-virtual 1.1.0).

### Known limitations

- **Sticky-header vertical offset** is hard-coded to `rowHeight` (32px by default) as the column-header height. If a consumer restyles `.lt-header-cell` to a different height, sticky group headers may occlude or leave a gap below the header. A future release will surface this as a CSS variable.
- **Sticky group headers stack vertically inside `.lt-sticky-groups`**; there is no horizontal breadcrumb variant. At depth > 3, the stack starts eating meaningful viewport area. Consumers with deep hierarchies can override the sticky styling (`display: none` on `.lt-sticky-groups`) and build a compact breadcrumb using `groupAncestryAt(axis.firstIndex())`.

---

## [1.1.0] — 2026-06-14

Sort: plain click on a column already in a multi-column chain now cycles just that entry's direction instead of replacing the entire chain. Plain click on an un-chained column still resets to single-column sort. Shift+click semantics unchanged.

Two feature additions and two bug fixes since 1.0.0. All API additions are
opt-in; all consumers of 1.0.0 are unaffected unless they enable the new
features per-column.

### Added — Export

- **`table.exportCsv(opts)`** — RFC-4180-compliant CSV string.
  - `rows`: `"visible"` (default) / `"all"` / `"selected"` / explicit array
  - `columns`: `"visible"` (default) / `"all"` / array of keys (projection + reordering)
  - `delimiter`, `quote`, `headers`, `newline`, `bom` for format control
  - `formatter: (row, col) => unknown` per-cell hook (runs before CSV escaping)
  - Numbers stringify naturally; null/undefined become empty fields; embedded
    quotes are doubled; fields containing the delimiter, the quote, CR, or LF
    are quoted. UTF-8 BOM via `bom: true` for Excel-on-Windows.

- **`table.exportJson(opts)`** — JSON string or array.
  - Same `rows` + `columns` selectors as `exportCsv`
  - `format: "string"` (default) returns a JSON string; `"array"` returns the
    projected array directly (skip `JSON.stringify`, useful for piping into
    IndexedDB / postMessage / structured clone)
  - `indent`, `formatter` options
  - Fast path: `columns: "all"` + no formatter returns a shallow `rows.slice()`,
    not deep copies — row identity preserved.

### Added — Cell editing

- **`ColumnDef.editable?: boolean`** — opt-in per column.
- **`CreateTableConfig.onCellEdit?: ({ row, columnKey, oldValue, newValue }) => void`**
  — commit hook. lite-table never mutates rows itself; the handler is the
  consumer's hook to write to a row, a backend, or a store.
  - **`newValue` is always a string** (from contenteditable / `editingDraft`).
    Consumers editing non-string columns are responsible for coercion in their
    handler (e.g. `row.value = Number(newValue)`).
  - Skipped when the change would be a no-op: the guard compares
    `String(oldValue) !== newValue`, so pressing Enter on a numeric column
    without typing doesn't spuriously fire the hook.
  - Errors thrown by the handler are caught + logged.

- **`table.editingCell: Signal<{ rowId, columnKey } | null>`** — current edit
  target. Keyed on row identity so edits survive scroll, sort, filter, and
  slot recycling.
- **`table.editingDraft: Signal<string>`** — in-progress edit value
  (mountTable writes to this from `input` events).
- **`table.startEdit(rowId, columnKey)`** — start editing. No-op on
  non-editable columns. Auto-commits any in-flight edit on a different cell.
  Idempotent on the same cell.
- **`table.commitEdit(value?)`** — commit. With no argument, reads from
  `editingDraft`. Skips `onCellEdit` when value unchanged (string-coerced).
- **`table.cancelEdit()`** — discard the in-flight edit.
- **`table.isEditing(rowId, columnKey)`** — O(1) predicate.

- **DOM wiring** (when mounted via `mountTable`):
  - Double-click on an editable cell starts editing.
  - F2 / Enter on the focused cell starts editing if the column is editable.
  - Enter commits + moves focus down (spreadsheet idiom).
  - Tab / Shift+Tab commit + move focus right / left.
  - Escape cancels + restores root focus.
  - Blur on the cell commits.
  - The active editing cell gets `contenteditable="true"`, the
    `.lt-cell.is-editing` class (default style: orange outline + white-space
    normal), and its `textContent` write binding is suspended while editing
    so user keystrokes aren't clobbered by reactive paint.

### Added — Per-column filtering

- **`ColumnDef.filterable?: boolean`** — opt-in per column.
- **`ColumnDef.filter?: (value, query, row) => boolean`** — custom predicate.
  Defaults to case-insensitive substring match on the stringified value.
- **`ColumnDef.filterPlaceholder?: string`** — placeholder text for the
  filter input. Default `"Filter…"`.

- **`table.columnFilters: Signal<ReadonlyMap<string, string>>`** — reactive
  filter state.
- **`table.filteredRows: Computed<readonly Row[]>`** — rows post-filter,
  pre-sort. `visibleRows` reads from here.
- **`table.setColumnFilter(key, value)`** — pass `null`/`undefined`/`""`/
  whitespace-only to clear that column. No-op on non-filterable or unknown
  columns.
- **`table.clearColumnFilters()`** — clear all. No notify if already empty.

- **DOM wiring** (when mounted via `mountTable`):
  - A `.lt-filter-row` is mounted between header and viewport if any column
    has `filterable: true`. One `<input>` per filterable column, two-way
    bound to `columnFilters`.
  - Escape on a filter input clears that column.
  - The filter row participates in the grid layout (shares `--lt-cols` with
    header and rows) and respects pin offsets + hidden state.
  - Sticky `top: var(--lt-header-height, 32px)` so the row stays visible
    during vertical scroll. Override `--lt-header-height` on the root if you
    restyle the header to a different height.

### Pipeline

```
rowsGetter() → filteredRows → visibleRows → exports / mount / etc.
                  ▲              ▲
                  │              └─ sort applied here
                  └─ filters applied here
```

This means `exportCsv({ rows: "visible" })` is already filtered + sorted,
which is the expected "what the user sees" semantic.

### Fixed — `createScope` dispose leak (M1.0 latent bug)

`createScope` no longer leaks signals/computeds on `dispose()`. The v1.0.0
cleanup loop pushed signal/computed handles (which are callable) and then
iterated calling `c()` — which READS the signal, not disposes it. Every
`createTable` + `dispose()` cycle was leaving its ~24 reactive nodes pinned
in the lite-signal registry, eventually exhausting capacity in long-running
test runs or apps that create/destroy tables. The fix discriminates entries
by kind (`KIND_NODE` for handles → lite-signal `dispose()`; `KIND_THUNK` for
effect disposers, event removers, user `onCleanup`).

Verified: a `createTable` allocates 24 nodes; after `t.dispose()` the count
returns to 0. 50 create+dispose cycles round-trip cleanly with `activeNodes`
flat.

### Fixed — `commitEdit` unchanged-guard coerces oldValue

`commitEdit` compares `String(oldValue) !== newValue` before firing
`onCellEdit`. Earlier drafts used strict `!==`, which fired the handler on
no-op Enter for any non-string column (a `100` cell compared to `"100"`
fails strict equality and looked like a change).

### Demo

A new `demo/` directory ships with the package source (not published to
npm). The demo is a 5000-row paginated grid driven entirely by reactive
signals:

- **Page-size dropdown** (10 / 25 / 50 / 100 / all)
- **Pagination via reactive row source**: `rows: () => allRows.slice(...)`
  where the slice is driven by `pageIndex()` and `pageSize()` signals
- **Three export buttons**: visible page (with role-titlecasing formatter),
  selection across master, all 5000 as JSON
- **Per-column filter inputs** on name/email/role/team/value, with the value
  column demonstrating a custom predicate (`>N` / `<N` / exact / substring)
- **Editable cells** on name/email/role/team/value with an `onCellEdit`
  hook that mutates the master array + bumps a `rowsVersion` signal that
  the rowsGetter reads (the documented pattern for "consumer mutates row
  data, wants the table to repaint without changing pagination/filter
  state")
- **Clear filters** + **edit log** showing the last commit
- Larger lite-signal registry configured up front (4096 nodes, growth
  policy) — documented pattern for any non-trivial table app

### Tests

- **80 unit tests** across `test/export.test.js` (41: RFC-4180 escaping, all
  option combinations, edge cases including 10k-row dataset finishing <
  500ms), `test/scope-dispose.test.js` (5: the leak fix, dispose idempotency,
  50-cycle round trip), and `test/m2.test.js` (34: filtering basics, case
  insensitivity, multi-column AND, custom predicates, predicate receiving
  the full row, filter+sort interaction, filter+export, null/undefined
  handling, edit state transitions, all startEdit/commitEdit/cancelEdit
  semantics, onCellEdit handler error containment, edit+filter interaction,
  edit+dispose, numeric column unchanged-guard).
- **32 browser tests** across `test-browser/demo.spec.js` (14: pagination
  behavior, page-size dropdown, export buttons, leak-free across 50
  createTable+dispose cycles in the browser) and `test-browser/m2.spec.js`
  (18: filter row rendering, two-way input binding, Escape clearing,
  custom predicate, multi-filter AND, double-click editing, F2, Enter to
  commit, Tab to commit + move, Escape to cancel, blur to commit,
  unchanged-value skip, second-cell auto-commit).

### Documentation

- New "Export" section in README with full `rows` / `columns` selector
  tables, per-format option tables, paginated-getter pitfall note, and a
  copy-pasteable `downloadFile` helper.
- New "Cell editing" section with commit semantics, programmatic editing
  pattern, reactive surface, and a note that `newValue` is always a string.
- New "Per-column filtering" section with predicate contract, pipeline
  diagram, reactive surface, keyboard, and the `--lt-header-height`
  customization point.
- New "Client-side pagination via a reactive row source" recipe in the
  Integration recipes section.
- TOC updated.
- Types: `ExportRowsSource`, `ExportColumnsSelector`, `ExportCsvOptions`,
  `ExportJsonOptions`, `EditingCell`, `CellEditPayload` interfaces added to
  `Table.d.ts`. `ColumnDef`, `ColumnState`, `CreateTableConfig`, `TableCore`
  all extended with the new surfaces.

### Compatibility

Drop-in for v1.0.0 consumers. The new methods are additive; both editing
and filtering are opt-in per column. The scope-dispose fix only changes
lifecycle behavior (more thorough cleanup, no leaks). Peer dependencies
unchanged (`@zakkster/lite-signal ^1.2.0`).

### Known limitations

- Editing during scroll: if the edited row scrolls out of view, the edit
  state survives (it's keyed on rowId) but the `contenteditable` cell
  unmounts as the slot recycles. When the row scrolls back, editing
  resumes with the draft preserved. To force a commit on scroll, call
  `table.commitEdit()` from your scroll handler.

---

## [1.0.0] — 2026-06 (M1 stable)

First public release. The headless core + DOM mount, virtualized rows on a
pooled-slot CSS Grid, full keyboard + ARIA, single-key + chained sort, single +
range + all-mode selection, draggable column resize / reorder, pinned columns
with sticky offsets, flex columns.

### Public API

- **`createTable(config)`** — headless reactive state (renderer-agnostic, SSR-safe).
  Returns a `TableCore` with reactive `visibleRows`, `visibleColumns`,
  `colTemplate`, `colPlacement`, `leftOffsets`, `rightOffsets`, `sortChain`,
  `focusedCell`, `selection`, `selectedCount`, plus imperative
  `setSort`/`addSort`/`toggleSort`/`clearSort`,
  `selectRow`/`selectRowRange`/`selectAll`/`clearSelection`/`isSelected`/
  `selectedIds`/`selectedRows`/`forEachSelected`,
  `setColumnWidth`/`setColumnHidden`/`setColumnPin`/`setColumnFlex`/
  `setColumnOrder`/`moveColumn`,
  `moveFocus`,
  `cellId`, and `dispose`.
- **`mountTable(host, table, options?)`** — CSS Grid renderer with pooled slot
  virtualization. Returns a `TableMount` with `root`, `viewport`, `axis`,
  `scrollToIndex(index, "start"|"center"|"end")`, `poolSize()`, and `dispose()`.

### Architecture invariants

- **No `<table>`.** CSS Grid layout; `role=grid` / `row` / `columnheader` /
  `gridcell`. The root container is the only focusable element; logical focus
  is the `focusedCell` signal, and `aria-activedescendant` tracks it.
- **Position-keyed slot pool.** DOM topology never changes during scroll,
  sort, filter, hide, reorder, or pin. Sub-row scroll = 0 DOM writes
  (Object.is cutoff on the truncated start index). Pool size is bounded by
  viewport, not dataset.
- **Identity follows the row, not the slot.** Every cell's id is reactively
  bound to `lt_<rowId>__<columnKey>`. Focus, selection, edit state, and
  `aria-activedescendant` are all keyed on row identity — they survive scroll,
  sort, filter, recycling, and even row-removal-then-re-add.
- **Reactive columns.** Each column has its own `width` / `hidden` / `pin` /
  `flex` signals. `visibleColumns` is a computed derived from a
  `columnOrder` signal. Reorder mutates the order array; resize mutates one
  width signal; hide flips one boolean; pin moves between buckets.
- **Single grid for pinning.** Pinned columns live in the same CSS Grid as
  the body, with `position: sticky` plus a reactive `left` or `right` offset
  equal to the cumulative width of their bucket up to that column.
- **Pinning suspends flex.** When a column is pinned, its `flex` is ignored —
  pinned columns must render at exactly `width()px` so sticky offsets line
  up. Unpin re-engages flex.
- **Predicate-based selection.** `selection.mode === "all"` is a blacklist;
  Ctrl+A is O(1) (flip the mode, empty the set). Materialization to a list
  of IDs happens on demand via `selectedIds()` / `selectedRows()` /
  `forEachSelected()`.

### Performance

Empirical (Node 22 + happy-dom + signal-graph stats):

- **Scroll sub-row**: 0 DOM allocations, 0 updates.
- **Scroll boundary**: 0 allocations; ~484 in-place updates per boundary crossed.
- **Scroll 1000 rows**: 0 allocations, ~504 in-place updates total.
- **10,000 boundary scrolls**: signal-node delta 0, link delta 0, pool delta 0.
- **Mount cost is constant** versus dataset size: pool ~24 slots whether
  1K or 1M rows.

### Tests

110 tests across 9 files (node:test, `--expose-gc`):

- `alloc.test.js` — write counts, signal-graph stability, pool invariants.
- `columns.test.js` — width/hide/pin/flex/reorder, `colPlacement` and
  `colTemplate` consistency, the pinning-suspends-flex invariant.
- `core.test.js` — `createTable` shape + validation.
- `dom.test.js` — mount structure, ARIA wiring, reactive cell text, pool sizing.
- `keyboard.test.js` — every direction of `moveFocus` + Space/Esc/Ctrl+A.
- `recycle.test.js` — slot identity stability, cell IDs follow rows, focus
  survives scroll-out + filter-out.
- `selection.test.js` — every mode + anchor + DOM aria-selected + Ctrl/Shift
  click + all-mode + materialization paths.
- `sort.test.js` — chain semantics, stable multi-key sort, DOM click-sort.
- `extras.test.js` — `scrollToIndex` align modes, pointer-driven resize +
  reorder, `injectStyles:false`, mount-disposes-table lifecycle, null / 0 /
  string-id cells, `addSort(null)`, `moveFocus` from null, 50-col stress,
  steady-state graph stability under 1000+ sort/select/resize loops.

### License

MIT (c) Zahary Shinikchiev
