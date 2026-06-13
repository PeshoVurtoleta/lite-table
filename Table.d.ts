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

    // ---- Reactive: sort / focus / selection ----
    readonly sortChain: Signal<readonly SortEntry[]>;
    readonly focusedCell: Signal<FocusedCell | null>;
    /** Predicate-based selection state. Reading `.set.has(id)` directly is
     *  wrong in all-mode -- use `isSelected(id)` for membership. */
    readonly selection: Signal<SelectionState>;
    readonly selectionAnchor: Signal<string | number | null>;
    /** Reactive O(1) selected count. In all-mode this is
     *  `rowCount() - blacklist.size`; otherwise `whitelist.size`. */
    readonly selectedCount: Computed<number>;

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

    // ---- Methods: focus ----
    moveFocus(direction: FocusDirection, opts?: { pageSize?: number }): void;

    // ---- Lifecycle ----
    dispose(): void;
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
