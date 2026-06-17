/**
 * @zakkster/lite-table - type declarations (M1)
 */

import type { Signal, Computed } from "@zakkster/lite-signal";
import type { VirtualAxis, ScrollAlign } from "@zakkster/lite-virtual";

// --- Column types -----------------------------------------------------------

export type PinSide = "left" | "none" | "right";
export type SortDir = "asc" | "desc";

export interface ColumnDef<Row = any, Value = unknown> {
    /** Field key on the row. Used for `row[key]` access and cell ids. */
    key: string;
    /** Header label. Defaults to `key`. */
    header?: string;
    /** Initial pixel width. Default 120. */
    width?: number;
    /** Resize lower bound. Default 40. */
    minWidth?: number;
    /** Resize upper bound. Default 1600. */
    maxWidth?: number;
    /** Initially hidden. Default false. */
    hidden?: boolean;
    /** Initial pin side. Default "none". */
    pin?: PinSide;
    /** Initial flex weight. Default 0 (fixed width). Set > 0 to make the
     *  column share leftover horizontal space proportionally: it renders as
     *  `minmax(<minWidth>px, <flex>fr)`. When any column has flex > 0, the
     *  trailing 1fr filler is dropped so flex columns absorb the space. */
    flex?: number;
    /** Feature flags -- disable per-column interactions. All default true. */
    sortable?: boolean;
    resizable?: boolean;
    pinnable?: boolean;
    hideable?: boolean;
    reorderable?: boolean;
    /** M2: enable double-click / F2 cell editing for this column. Default false. */
    editable?: boolean;
    /** M2: enable the per-column filter input above this column. Default false. */
    filterable?: boolean;
    /** M2: custom filter predicate. Receives the column's value (post-accessor),
     *  the current (trimmed) filter query string, and the full row. Return
     *  true to keep the row in the result. Defaults to case-insensitive
     *  substring match on the stringified value. */
    filter?: (value: Value, query: string, row: Row) => boolean;
    /** M2: placeholder text for the filter input. Default "Filter…". */
    filterPlaceholder?: string;
    /** Computed value override; if absent, `row[key]` is used. */
    accessor?: (row: Row) => Value;
    /** Sort comparator; default is null-safe number-or-string compare. */
    compare?: (a: Value, b: Value) => number;
}

/** Live reactive state for a column, exposed on `table.columns[i]`. */
export interface ColumnState<Row = any> {
    readonly key: string;
    readonly header: string;
    readonly accessor: ((row: Row) => unknown) | null;
    readonly compare: (a: unknown, b: unknown) => number;
    readonly sortable: boolean;
    readonly resizable: boolean;
    readonly pinnable: boolean;
    readonly hideable: boolean;
    readonly reorderable: boolean;
    /** M2 */
    readonly editable: boolean;
    readonly filterable: boolean;
    readonly filter: ((value: unknown, query: string, row: Row) => boolean) | null;
    readonly filterPlaceholder: string | null;
    readonly minWidth: number;
    readonly maxWidth: number;
    readonly width: Signal<number>;
    readonly hidden: Signal<boolean>;
    readonly pin: Signal<PinSide>;
    readonly flex: Signal<number>;
}

// --- Focus / sort / selection types -----------------------------------------

export interface FocusedCell {
    rowId: string | number;
    columnKey: string;
}

/** M2: cell currently being edited. Keyed on row identity so the edit
 *  state survives slot recycling / scroll / sort / filter -- same model
 *  as `FocusedCell`. */
export interface EditingCell {
    rowId: string | number;
    columnKey: string;
}

/** M2: payload passed to `onCellEdit` on commit.
 *
 *  `newValue` is `string` when the commit came from the DOM editing path
 *  (double-click / F2 → contenteditable → Enter / Tab / blur). The
 *  consumer is responsible for coercion when editing typed columns. When
 *  the consumer calls `commitEdit(explicitValue)` with a non-string,
 *  `newValue` carries that value through unchanged (typed as unknown).
 *  `oldValue` is whatever the cell holds pre-edit (post-accessor).
 *
 *  The unchanged-guard compares `String(oldValue) !== newValue` for string
 *  `newValue`s -- so a no-op Enter on a numeric column doesn't fire this
 *  handler. For non-string explicit values it falls back to strict
 *  equality. */
export interface CellEditPayload<Row = any> {
    row: Row;
    columnKey: string;
    oldValue: unknown;
    newValue: string | unknown;
}

export interface SortEntry {
    key: string;
    dir: SortDir;
}

export type SelectMode = "set" | "add" | "toggle" | "range";

/** Selection state is a PREDICATE, not a list of IDs.
 *  - `mode: "whitelist"`: `set` contains the selected IDs.
 *  - `mode: "all"`: `set` is a blacklist -- every row is selected EXCEPT
 *    those in `set`. This makes Ctrl+A across 1M rows O(1) -- no walk of
 *    the row source, no per-ID allocation. Materialization (e.g. for
 *    Submit/Copy/Export) is on demand via `selectedIds` / `selectedRows`
 *    / `forEachSelected`. */
export interface SelectionState<RowId = string | number> {
    mode: "whitelist" | "all";
    set: Set<RowId>;
}

export type FocusDirection =
    | "up" | "down" | "left" | "right"
    | "home" | "end" | "rowStart" | "rowEnd"
    | "pageUp" | "pageDown";

// --- Config -----------------------------------------------------------------

export interface CreateTableConfig<Row = any> {
    rows: readonly Row[] | (() => readonly Row[]);
    columns: readonly ColumnDef<Row>[];
    getRowId: (row: Row) => string | number;
    rowHeight?: number;
    overscan?: number;
    initialFocus?: FocusedCell | null;
    initialSort?: readonly SortEntry[];
    /** M2: commit hook for cell edits. Receives the row + column key + old +
     *  new value. The table does NOT mutate rows itself; consumer is
     *  responsible for the data write (in-memory mutation, backend POST,
     *  optimistic update, etc.). Skipped when newValue === oldValue.
     *  Errors thrown by the handler are caught + logged. */
    onCellEdit?: (payload: CellEditPayload<Row>) => void | Promise<unknown>;
}

// --- Export option types ----------------------------------------------------

/** Row source for export.
 *
 *  - `"visible"` (default): the current post-sort view that the user sees.
 *  - `"all"`: the original master `rows` array, ignoring sort.
 *  - `"selected"`: the current selection materialized against the master
 *    array (so the export order matches insertion order, not the sorted
 *    order the user is looking at). Pass an explicit array if you want
 *    a different source.
 *  - Array: an explicit row array (e.g. a paginated page snapshot).
 */
export type ExportRowsSource<Row = any> = "visible" | "all" | "selected" | readonly Row[];

/** Column projection for export.
 *
 *  - `"visible"` (default): column order matches the current visible order
 *    and skips hidden columns.
 *  - `"all"`: all declared columns in declaration order, including hidden.
 *  - Array: explicit list of column keys (projection + ordering).
 */
export type ExportColumnsSelector = "visible" | "all" | readonly string[];

export interface ExportCsvOptions<Row = any> {
    rows?: ExportRowsSource<Row>;
    columns?: ExportColumnsSelector;
    delimiter?: string;
    quote?: string;
    headers?: boolean;
    newline?: string;
    bom?: boolean;
    formatter?: (row: Row, col: ColumnState<Row>) => unknown;
}

export interface ExportJsonOptions<Row = any> {
    rows?: ExportRowsSource<Row>;
    columns?: ExportColumnsSelector;
    indent?: number;
    format?: "string" | "array";
    formatter?: (row: Row, col: ColumnState<Row>) => unknown;
}

// --- Headless core ----------------------------------------------------------

export interface TableCore<Row = any> {
    // ---- Static ----
    readonly columns: readonly ColumnState<Row>[];
    readonly rowHeight: number;
    readonly overscan: number;
    getRowId(row: Row): string | number;
    cellId(rowId: string | number, columnKey: string): string;

    // ---- Reactive: data ----
    rowsGetter(): readonly Row[];
    /** M2: filtered rows BEFORE sort. `visibleRows` reads from this; consumers
     *  can read it directly when they want filter-aware row materializers
     *  (e.g. count of pre-sort matches, export of filtered-but-not-sorted). */
    readonly filteredRows: Computed<readonly Row[]>;
    readonly visibleRows: Computed<readonly Row[]>;
    readonly rowCount: Computed<number>;

    // ---- Reactive: columns ----
    readonly columnOrder: Signal<readonly string[]>;
    readonly visibleColumns: Computed<readonly ColumnState<Row>[]>;
    /** 0-indexed position of each column within `visibleColumns`. */
    readonly displayIndexByKey: Computed<Map<string, number>>;
    /** 1-indexed CSS grid-column placement for each column. Accounts for the
     *  1fr filler that lives between unpinned and right-pinned columns so
     *  right-pinned cells sit flush against the right edge. */
    readonly colPlacement: Computed<Map<string, number>>;
    readonly colTemplate: Computed<string>;
    readonly contentWidth: Computed<number>;
    readonly leftOffsets: Computed<Map<string, number>>;
    readonly rightOffsets: Computed<Map<string, number>>;

    // ---- Reactive: sort / filter / focus / selection / editing ----
    readonly sortChain: Signal<readonly SortEntry[]>;
    /** M2: per-column filter state. Map<columnKey, queryString>. Mutated
     *  via `setColumnFilter` -- direct .set on the signal works but always
     *  pass a fresh Map (Object.is-equal mutations would not notify). */
    readonly columnFilters: Signal<ReadonlyMap<string, string>>;
    readonly focusedCell: Signal<FocusedCell | null>;
    /** Predicate-based selection state. Reading `.set.has(id)` directly is
     *  wrong in all-mode -- use `isSelected(id)` for membership. */
    readonly selection: Signal<SelectionState>;
    readonly selectionAnchor: Signal<string | number | null>;
    /** Reactive O(1) selected count. In all-mode this is
     *  `rowCount() - blacklist.size`; otherwise `whitelist.size`. */
    readonly selectedCount: Computed<number>;
    /** M2: current cell being edited, or null. Keyed on row identity so it
     *  survives scroll / sort / filter / slot recycling. */
    readonly editingCell: Signal<EditingCell | null>;
    /** M2: in-progress edit value (the contenteditable's textContent).
     *  mountTable writes to this from `input` events; consumers can also
     *  set it programmatically to drive an external input. `commitEdit`
     *  without an explicit value reads this. */
    readonly editingDraft: Signal<string>;

    // ---- Methods: sort ----
    setSort(key: string, dir: SortDir | null): void;
    addSort(key: string, dir: SortDir | null): void;
    toggleSort(key: string, opts?: { additive?: boolean }): void;
    clearSort(): void;

    // ---- Methods: selection ----
    selectRow(rowId: string | number, mode?: SelectMode): void;
    selectRowRange(anchorId: string | number | null, targetId: string | number): void;
    /** Select every row. O(1) -- flips to all-mode with an empty blacklist. */
    selectAll(): void;
    clearSelection(): void;
    /** O(1) predicate. Handles both whitelist and all-mode transparently. */
    isSelected(rowId: string | number): boolean;
    /** Materialize the selected IDs. O(N) in the row source. Defaults to
     *  `visibleRows()`; pass a source for export against the unsorted master. */
    selectedIds<R = Row>(source?: readonly R[]): (string | number)[];
    /** Materialize the selected row objects. O(N) in the row source. */
    selectedRows<R = Row>(source?: readonly R[]): R[];
    /** Stream selected rows without materializing the full list. Returning
     *  `false` from `fn` stops iteration. Use this for CSV / network export. */
    forEachSelected<R = Row>(
        fn: (row: R, id: string | number, index: number) => boolean | void,
        source?: readonly R[]
    ): void;

    // ---- Methods: columns ----
    setColumnWidth(key: string, w: number): void;
    setColumnHidden(key: string, hidden: boolean): void;
    setColumnPin(key: string, side: PinSide): void;
    setColumnFlex(key: string, flex: number): void;
    setColumnOrder(keys: readonly string[]): void;
    moveColumn(fromKey: string, toKey: string, opts?: { before?: boolean }): void;

    // ---- Methods: filters (M2) ----
    /** Set or clear a column's filter. Pass `null`/`undefined`/`""` to clear.
     *  No-op on non-filterable or unknown columns. */
    setColumnFilter(key: string, value: string | null | undefined): void;
    /** Clear all filters. No-op + no notify if the filter map is already empty. */
    clearColumnFilters(): void;

    // ---- Methods: editing (M2) ----
    /** Start editing the (rowId, columnKey) cell. No-op on non-editable
     *  columns. Auto-commits any in-flight edit of a different cell. Idempotent
     *  on the same cell (does not re-seed the draft). */
    startEdit(rowId: string | number, columnKey: string): void;
    /** Commit the in-flight edit. With no argument, reads from `editingDraft`.
     *  Fires `onCellEdit` only when `newValue !== oldValue`. Clears edit state. */
    commitEdit(value?: string): void;
    /** Discard the in-flight edit without firing `onCellEdit`. */
    cancelEdit(): void;
    /** O(1) predicate. */
    isEditing(rowId: string | number, columnKey: string): boolean;

    // ---- Methods: export ----
    exportCsv(opts?: ExportCsvOptions<Row>): string;
    exportJson(opts?: ExportJsonOptions<Row> & { format?: "string" }): string;
    exportJson<R = Row>(opts: ExportJsonOptions<Row> & { format: "array" }): object[];

    // ---- Methods: focus ----
    moveFocus(direction: FocusDirection, opts?: { pageSize?: number }): void;

    // ---- Lifecycle ----
    dispose(): void;

    /**
     * @internal
     * Reactive scope used internally to track signals/computeds/effects
     * created by this table. Exposed so tests can register additional
     * effects whose disposal is tied to `table.dispose()`. Not for
     * application use -- the public surface above covers all intended
     * patterns.
     */
    readonly _scope: {
        effect(fn: () => void): () => void;
        onCleanup(fn: () => void): void;
    };
}

export function createTable<Row = any>(
    config: CreateTableConfig<Row>
): TableCore<Row>;

// --- DOM mount --------------------------------------------------------------

export interface MountOptions {
    injectStyles?: boolean;
    initialViewportHeight?: number;
}

export interface TableMount {
    readonly root: HTMLElement;
    readonly viewport: HTMLElement;
    readonly axis: VirtualAxis;
    scrollToIndex(index: number, align?: ScrollAlign): void;
    poolSize(): number;
    dispose(): void;
}

export function mountTable<Row = any>(
    host: HTMLElement,
    table: TableCore<Row>,
    options?: MountOptions
): TableMount;

export function _resetStylesForTest(): void;
