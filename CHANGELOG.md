# Changelog

All notable changes to `@zakkster/lite-table` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
