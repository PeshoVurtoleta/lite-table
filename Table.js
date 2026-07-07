/**
 * @zakkster/lite-table
 * -------------------
 * Headless reactive data tables on @zakkster/lite-signal.
 *
 * Architecture:
 *
 *   - No <table>. CSS Grid layout. ARIA roles: grid / row / columnheader /
 *     gridcell. The root container is the only focusable element; logical
 *     focus is the `focusedCell` signal, and aria-activedescendant tracks it.
 *
 *   - Position-keyed pool of slot rows. DOM topology never changes during
 *     scroll, sort, filter, hide, or reorder. The same slot DOM nodes carry
 *     different rows over time; their cells' bindings (text, id, gridColumn,
 *     sticky position) mutate. Sub-row scroll = zero DOM writes (Object.is
 *     cutoff on the integer-truncated start index).
 *
 *   - Identity follows the row, not the slot. Every cell's id is reactively
 *     bound to `lt_<rowId>__<columnKey>`. Focus, selection, edit state, and
 *     aria-activedescendant are all keyed on row identity, which means they
 *     survive scroll, sort, filter, recycling -- everything except actually
 *     removing the row from the dataset (and even then, logical state is
 *     preserved and rehydrates on re-add).
 *
 *   - Columns are reactive. Each column has signals for width, hidden, and
 *     pin side (left/none/right). The visible-columns ordering is a computed
 *     over a column-order signal. Reorder mutates the order array; resize
 *     mutates one width signal; hide flips one boolean; pin moves between
 *     buckets. All of these update visually without recreating any DOM.
 *
 *   - Pinned columns are placed in the same single CSS Grid as the row, but
 *     get `position: sticky` plus a reactive `left` or `right` offset that
 *     equals the cumulative width of their bucket up to that column. No
 *     three-grid split, no nested containers -- one row, one grid.
 *
 *   - Sort is a chain of `{key, dir}` entries. visibleRows applies a stable
 *     multi-key sort to the source. Headers click-to-sort, shift-click to
 *     chain.
 *
 *   - Selection is a Set<rowId>. Range selection uses an anchor and the
 *     current visible row order. Selection mutates by row id; rendering
 *     uses bindClass to highlight the slot whose current row id is in the
 *     set.
 *
 *   - Keyboard nav is a `keydown` listener on root. Arrow keys, Home/End,
 *     PgUp/PgDn move focus; Space toggles selection of focused row; Shift+
 *     click extends; Ctrl/Cmd+click toggles.
 *
 * Public surface (see Table.d.ts for canonical types):
 *
 *   createTable(config) -> TableCore
 *     Headless reactive state. Renderer-agnostic. SSR-safe.
 *
 *   mountTable(host, table, options?) -> TableMount
 *     Attaches the CSS Grid DOM and wires reactivity.
 *
 * @module @zakkster/lite-table
 */

import {
    signal, computed, effect, untrack,
    dispose as disposeNode
} from "@zakkster/lite-signal";
import { virtualAxis } from "@zakkster/lite-virtual";
import { bindText, bindAttr, bindOn, bindClass } from "@zakkster/lite-signal-dom";

// =============================================================================
// 1. INTERNAL HELPERS
// =============================================================================

function asGetter(x) {
    if (typeof x === "function") return x;
    const v = x;
    return () => v;
}

function makeCellId(rowId, columnKey) {
    return "lt_" + rowId + "__" + columnKey;
}

function defaultCompare(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const as = String(a), bs = String(b);
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
}

/**
 * Create a disposable scope. Tracks signals, computeds, effects, event
 * listeners, and arbitrary user cleanups. `dispose()` runs them in reverse
 * order, once.
 *
 * Implementation note: lite-signal returns CALLABLE handles for signals and
 * computeds. To free them we must call the lite-signal `dispose()` (imported
 * here as `disposeNode`) on the handle -- calling the handle as a function
 * just reads it. Effect disposers are themselves the cleanup function; event
 * remover thunks and user onCleanup callbacks are likewise just called.
 *
 * Cleanups are recorded as discriminated entries so the dispose loop knows
 * which path to take per entry. The previous (v1.0.0) implementation pushed
 * raw signal handles and tried to call them on cleanup -- which silently
 * read them instead of disposing, leaving the nodes pinned in the lite-signal
 * registry across createTable -> dispose() cycles (a real leak; visible only
 * when many tables are created in one process, e.g. tests).
 */
function createScope() {
    const KIND_NODE = 1;        // lite-signal handle (signal or computed)
    const KIND_THUNK = 2;       // plain function: effect disposer, remover, user cleanup
    // Two parallel arrays keep the per-entry shape allocation-free; one
    // slot per cleanup is two integers' worth of memory, no per-entry obj.
    const cleanupKinds = [];
    const cleanupTargets = [];
    let disposed = false;

    function pushNode(handle) {
        cleanupKinds.push(KIND_NODE);
        cleanupTargets.push(handle);
    }
    function pushThunk(fn) {
        cleanupKinds.push(KIND_THUNK);
        cleanupTargets.push(fn);
    }

    const scope = {
        signal(initial, opts) {
            const s = signal(initial, opts);
            pushNode(s);
            return s;
        },
        computed(fn, opts) {
            const c = computed(fn, opts);
            pushNode(c);
            return c;
        },
        effect(fn) {
            const d = effect(fn);
            pushThunk(d);
            return d;
        },
        on(el, type, handler, opts) {
            el.addEventListener(type, handler, opts);
            const off = () => el.removeEventListener(type, handler, opts);
            pushThunk(off);
            return off;
        },
        onCleanup(fn) {
            pushThunk(fn);
        }
    };
    function dispose() {
        if (disposed) return;
        disposed = true;
        for (let i = cleanupKinds.length - 1; i >= 0; i--) {
            const k = cleanupKinds[i];
            const t = cleanupTargets[i];
            try {
                if (k === KIND_NODE) disposeNode(t);
                else t();
            } catch (_e) { /* per-handler */ }
        }
        cleanupKinds.length = 0;
        cleanupTargets.length = 0;
    }
    return { scope, dispose };
}

// =============================================================================
// 2. COLUMN STATE
// =============================================================================

/**
 * One ColumnState per user-declared column. Static fields (key, header,
 * accessor, compare) come from config; the rest are signals so the user (or
 * the resize/reorder/pin/hide interactions) can mutate them.
 */
function createColumnState(def, scope, defaults) {
    const width = scope.signal(def.width || defaults.columnWidth);
    const hidden = scope.signal(def.hidden === true);
    const pin = scope.signal(def.pin === "left" || def.pin === "right" ? def.pin : "none");
    // flex = 0 (default): column has the exact width given by `width()`. The
    // trailing 1fr filler in colTemplate absorbs any leftover viewport space.
    // flex > 0: column gets `minmax(<minWidth>px, <flex>fr)` -- it can grow
    // to share leftover space proportionally with other flex columns, with
    // minWidth as a floor. When ANY column has flex > 0, the trailing 1fr is
    // dropped (flex columns absorb the space instead).
    const flex = scope.signal(typeof def.flex === "number" && def.flex > 0 ? def.flex : 0);
    const minWidth = def.minWidth || 40;
    const maxWidth = def.maxWidth || 1600;
    return {
        key: def.key,
        header: def.header != null ? def.header : def.key,
        accessor: typeof def.accessor === "function" ? def.accessor : null,
        compare: typeof def.compare === "function" ? def.compare : defaultCompare,
        sortable: def.sortable !== false,
        resizable: def.resizable !== false,
        pinnable: def.pinnable !== false,
        hideable: def.hideable !== false,
        reorderable: def.reorderable !== false,
        // M2: cell editing opt-in. False by default; columns that drive
        // computed values (accessor with no underlying field) should stay
        // false because there's nowhere to write back to.
        editable: def.editable === true,
        // M2: per-column filter opt-in. False by default.
        filterable: def.filterable === true,
        // M2: optional custom filter predicate. (value, query, row) => boolean.
        // value is the column's value (accessor-resolved). query is the trimmed
        // current filter string. row is the full row (handy for cross-field
        // filters or when the consumer wants more than the cell value).
        // Default: case-insensitive substring match on the stringified value.
        filter: typeof def.filter === "function" ? def.filter : null,
        filterPlaceholder: typeof def.filterPlaceholder === "string" ? def.filterPlaceholder : null,
        // M3: aggregate spec for grouped views. One of the built-in strings
        // "sum" | "avg" | "min" | "max" | "count", or a custom reducer
        // (rows, col) => any. `null` (default) means "no aggregate" -- the
        // column is shown blank in group-header + grand-total rows.
        aggregate: def.aggregate != null ? def.aggregate : null,
        // M3: display formatter for aggregate values in group-header +
        // grand-total rows. (value, col, count) => string. Only affects
        // display -- `entry.aggregates.get(key)` still returns the raw value
        // so consumers can format it themselves for export etc.
        aggregateFormat: typeof def.aggregateFormat === "function" ? def.aggregateFormat : null,
        minWidth,
        maxWidth,
        width,
        hidden,
        pin,
        flex
    };
}

/**
 * Read a column's value for a row.
 */
function readCell(col, row) {
    if (row == null) return undefined;
    return col.accessor ? col.accessor(row) : row[col.key];
}

// =============================================================================
// 3. HEADLESS CORE
// =============================================================================

/**
 * Create the headless reactive state for a table. Renderer-agnostic and
 * SSR-safe; mount it with {@link mountTable} or render it yourself.
 *
 * Everything reactive lives in lite-signal nodes -- `visibleRows`,
 * `visibleColumns`, `colTemplate`, `sortChain`, `focusedCell`, `selection`,
 * `selectedCount` are all live and observable. Mutations go through the
 * imperative methods (`setSort`, `selectRow`, `setColumnWidth`, ...) which
 * write into those signals. See `Table.d.ts` for the full type contract.
 *
 * @template Row
 * @param {object} config
 * @param {readonly Row[] | (() => readonly Row[])} config.rows
 *      Row source. A plain array is read once at mount; a signal getter or
 *      function is re-read on each `visibleRows` recompute -- when wrapping
 *      a signal, just pass the signal itself.
 * @param {readonly object[]} config.columns
 *      Column definitions. Non-empty; see {@link ColumnDef}. The first
 *      column with `flex > 0` becomes the space absorber on resize.
 * @param {(row: Row) => string|number} config.getRowId
 *      REQUIRED. Stable identity per row -- selection, focus, and cell IDs
 *      key off this. Returning the same id twice across the dataset breaks
 *      slot reconciliation and ARIA `aria-activedescendant`.
 * @param {number} [config.rowHeight=32]
 * @param {number} [config.overscan=4]
 *      Extra rows rendered above / below the viewport for smoother scroll.
 * @param {{rowId: string|number, columnKey: string} | null} [config.initialFocus=null]
 * @param {readonly {key: string, dir: "asc"|"desc"}[]} [config.initialSort=[]]
 *
 * @returns {object} TableCore -- the reactive state surface. See `Table.d.ts`.
 * @throws {TypeError} If `getRowId` is missing, `columns` is empty, or
 *      `rowHeight <= 0`.
 *
 * @example
 *   const table = createTable({
 *       rows: [{ id: 1, name: "Ada" }, { id: 2, name: "Linus" }],
 *       columns: [
 *           { key: "id", header: "ID", width: 60 },
 *           { key: "name", header: "Name", width: 200, flex: 1 }
 *       ],
 *       getRowId: (r) => r.id
 *   });
 *   table.setSort("name", "asc");
 *   table.selectRow(1);
 */
export function createTable(config) {
    if (!config) throw new TypeError("lite-table: config required");
    const {
        rows,
        columns: columnDefs,
        getRowId,
        rowHeight = 32,
        overscan = 4,
        initialFocus = null,
        initialSort = [],
        // M2: cell-edit hook. Fires on commit with the row + column key +
        // new + old value. Consumer mutates their row data (or stores the
        // change in a backend); the table itself does NOT mutate rows.
        onCellEdit = null
    } = config;

    if (typeof getRowId !== "function") {
        throw new TypeError("lite-table: getRowId is required and must be a function");
    }
    if (!Array.isArray(columnDefs) || columnDefs.length === 0) {
        throw new TypeError("lite-table: columns must be a non-empty array");
    }
    if (!(rowHeight > 0)) {
        throw new TypeError("lite-table: rowHeight must be > 0");
    }

    const rowsGetter = asGetter(rows);

    const { scope, dispose } = createScope();

    // --- Columns ---
    const defaults = { columnWidth: 120 };
    const columns = columnDefs.map((d) => createColumnState(d, scope, defaults));
    const columnsByKey = new Map(columns.map((c) => [c.key, c]));

    // Column display order is a Signal<string[]> of column keys. Reorder
    // mutates this array; hidden columns stay in the order (just skip on
    // render). Pin doesn't move them in this list -- pin is applied as a
    // bucket pass below.
    const columnOrder = scope.signal(columns.map((c) => c.key));

    // Bucketed + filtered: returned in render order [left, none, right].
    const visibleColumns = scope.computed(() => {
        const order = columnOrder();
        const left = [], none = [], right = [];
        for (let i = 0; i < order.length; i++) {
            const c = columnsByKey.get(order[i]);
            if (!c || c.hidden()) continue;
            const pinSide = c.pin();
            if (pinSide === "left") left.push(c);
            else if (pinSide === "right") right.push(c);
            else none.push(c);
        }
        return left.concat(none, right);
    });

    // displayIndexByKey: 0-indexed position within visibleColumns (left+unpinned+right).
    // Used externally to identify a column's logical visible position.
    const displayIndexByKey = scope.computed(() => {
        const m = new Map();
        const cols = visibleColumns();
        for (let i = 0; i < cols.length; i++) m.set(cols[i].key, i);
        return m;
    });

    // colLayout: a single source of truth for grid-template-columns and the
    // per-column grid-column placement map. Computing both from the same loop
    // guarantees that placement[key] is consistent with the segment index in
    // the template -- there's no way for a column to think it's at position 4
    // while the template only has 3 tracks.
    //
    // Three regimes per column:
    //   - flex = 0 OR pinned:  "<width>px"  -- exact width.
    //   - flex > 0 AND unpinned: "minmax(<minWidth>px, <flex>fr)" -- shares
    //                            leftover space proportionally.
    //
    // Pinned columns MUST render at exactly c.width() because leftOffsets /
    // rightOffsets are pre-computed cumulative sums of c.width(). If a pinned
    // column instead got an fr-distributed track, the rendered box width
    // would no longer match the offset arithmetic and sticky-positioned
    // cells would overlap each other (a 180px-wide-on-paper name pinned
    // right at offset 450 would render as 357px in a 1500px viewport, but
    // its sticky offset was still calculated as if it were 180px, so it
    // would slide over the adjacent right-pinned email). Flex silently
    // applies to unpinned columns only; pinning effectively suspends it,
    // and unpinning brings it back.
    //
    // The trailing "1fr" filler is appended only when NO unpinned column
    // has flex>0. With an unpinned flex column present, that column
    // absorbs leftover space directly. The 1fr is inserted BEFORE the
    // first right-pinned column so right-pinned cells sit flush against
    // the right edge instead of leaving a gap.
    const colLayout = scope.computed(() => {
        const visible = visibleColumns();
        let anyFlex = false;
        for (const c of visible) {
            // Only unpinned flex counts -- a pinned column's flex is
            // suspended (see comment above).
            if (c.flex() > 0 && c.pin() === "none") { anyFlex = true; break; }
        }
        const parts = [];
        const placement = new Map();
        let pos = 1;
        let fillerInserted = false;
        for (const c of visible) {
            if (c.pin() === "right" && !fillerInserted && !anyFlex) {
                parts.push("1fr");
                pos++;
                fillerInserted = true;
            }
            const useFlex = c.flex() > 0 && c.pin() === "none";
            if (useFlex) {
                parts.push("minmax(" + c.minWidth + "px, " + c.flex() + "fr)");
            } else {
                parts.push(c.width() + "px");
            }
            placement.set(c.key, pos);
            pos++;
        }
        if (!fillerInserted && !anyFlex) parts.push("1fr");
        return { template: parts.join(" "), placement };
    });
    const colTemplate = scope.computed(() => colLayout().template);
    const colPlacement = scope.computed(() => colLayout().placement);

    // Sum of visible column widths. Exposed as part of the public reactive
    // API for consumers that need to know the natural width (e.g. for an
    // off-screen ghost during drag). The layout no longer applies this as a
    // min-width -- inner uses `width: max-content; min-width: 100%` instead,
    // which lets the grid template size itself and only stretches to viewport
    // when the viewport is wider than the natural content.
    const contentWidth = scope.computed(() => {
        let sum = 0;
        for (const c of visibleColumns()) sum += c.width();
        return sum;
    });

    // Cumulative left offsets for left-pinned columns (relative to their bucket).
    const leftOffsets = scope.computed(() => {
        const m = new Map();
        let acc = 0;
        for (const c of visibleColumns()) {
            if (c.pin() !== "left") continue;
            m.set(c.key, acc);
            acc += c.width();
        }
        return m;
    });
    // Cumulative right offsets, walking right-to-left.
    const rightOffsets = scope.computed(() => {
        const m = new Map();
        const right = visibleColumns().filter((c) => c.pin() === "right");
        let acc = 0;
        for (let i = right.length - 1; i >= 0; i--) {
            m.set(right[i].key, acc);
            acc += right[i].width();
        }
        return m;
    });

    // --- Filters (M2) ---
    // Reactive Map<columnKey, string>. We use a Map so we can clear and add
    // without re-allocating an object literal per change, but we wrap mutations
    // in a fresh-Map .set() call (Object.is inequality is what notifies
    // downstream computeds; mutating in place would silently skip propagation).
    const columnFilters = scope.signal(new Map());

    function _filterMatchesAll(row) {
        const filters = columnFilters();
        if (filters.size === 0) return true;
        for (const [key, raw] of filters) {
            const q = typeof raw === "string" ? raw.trim() : "";
            if (q.length === 0) continue;
            const col = columnsByKey.get(key);
            if (!col || !col.filterable) continue;
            const v = readCell(col, row);
            const pred = col.filter;
            if (pred) {
                if (!pred(v, q, row)) return false;
            } else {
                // Default: case-insensitive substring on stringified value.
                // null/undefined become empty -- they fail any non-empty filter.
                const s = (v === null || v === undefined) ? "" : String(v);
                if (s.toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
            }
        }
        return true;
    }

    // Reactive: filtered source. visibleRows now sorts THIS, not raw rowsGetter.
    // When no filter is active, returns the source array as-is (identity) to
    // avoid an unnecessary O(N) allocation. When any filter has a non-empty
    // query, walks the source once and produces a fresh filtered array.
    const filteredRows = scope.computed(() => {
        const src = rowsGetter();
        const filters = columnFilters();
        // Fast path: no filters at all OR every filter is empty.
        if (filters.size === 0) return src;
        let hasActive = false;
        for (const v of filters.values()) {
            if (typeof v === "string" && v.trim().length > 0) { hasActive = true; break; }
        }
        if (!hasActive) return src;
        const out = [];
        for (let i = 0; i < src.length; i++) {
            if (_filterMatchesAll(src[i])) out.push(src[i]);
        }
        return out;
    });

    // --- Sort ---
    // Sort chain: list of {key, dir}. visibleRows applies it as a stable
    // multi-key sort to the filtered source.
    const sortChain = scope.signal(
        Array.isArray(initialSort)
            ? initialSort.filter((s) => s && columnsByKey.has(s.key))
            : []
    );

    // Sort buffer: a Uint32Array of indices, reused across sorts so a 100k-row
    // sort allocates exactly one array (the output), not 100k tuple arrays. V8's
    // Array.sort and TypedArray.sort are both stable per spec, but we also fall
    // back to comparing original indices as a tie-breaker to guarantee
    // stability across the multi-key chain regardless of engine.
    let _sortIdxBuf = null;

    // (Sort buffer + `_sortedFilteredRows` + `visibleRows` + `rowCount` are
    // defined inside the M3 grouping block below, since they now interact
    // with `groupedRows`/`visibleEntries`.)

    function toggleSort(key, opts) {
        const col = columnsByKey.get(key);
        if (!col || !col.sortable) return;
        const chain = sortChain();
        const additive = opts && opts.additive === true;
        const existing = chain.findIndex((e) => e.key === key);

        if (additive) {
            // Shift-click: 3-state cycle per chain entry.
            //   not in chain  -> append at asc
            //   in chain asc  -> flip to desc
            //   in chain desc -> remove from chain
            // This is how chain membership is MANAGED -- it can both grow
            // and shrink the chain.
            const next = chain.slice();
            if (existing < 0) {
                next.push({ key, dir: "asc" });
            } else if (chain[existing].dir === "asc") {
                next[existing] = { key, dir: "desc" };
            } else {
                next.splice(existing, 1);
            }
            sortChain.set(next);
            return;
        }

        // Plain click: drives the PRIMARY sort, never silently dismantles a
        // user-built multi-column chain.
        if (existing < 0) {
            // Column not in chain: replace whole chain with single-col asc.
            // Lets the user re-anchor primary sort with one click.
            sortChain.set([{ key, dir: "asc" }]);
        } else if (chain.length === 1) {
            // Sole entry: legacy 3-state cycle (asc -> desc -> cleared).
            // Some users rely on a third plain click to fully unsort.
            sortChain.set(chain[0].dir === "asc"
                ? [{ key, dir: "desc" }]
                : []);
        } else {
            // Column is already part of a MULTI-column chain: toggle just
            // that entry's direction (asc <-> desc). No removal -- the user
            // built this chain on purpose; one stray plain-click should not
            // tear it down. Removal is intentional via shift-click (cycle to
            // remove) or `clearSort()`.
            const next = chain.slice();
            next[existing] = {
                key,
                dir: chain[existing].dir === "asc" ? "desc" : "asc"
            };
            sortChain.set(next);
        }
    }

    function setSort(key, dir) {
        if (!columnsByKey.has(key)) return;
        if (dir == null) { sortChain.set([]); return; }
        sortChain.set([{ key, dir }]);
    }
    function addSort(key, dir) {
        if (!columnsByKey.has(key)) return;
        const chain = sortChain().slice();
        const idx = chain.findIndex((e) => e.key === key);
        if (dir == null) {
            if (idx >= 0) chain.splice(idx, 1);
        } else if (idx < 0) {
            chain.push({ key, dir });
        } else {
            chain[idx] = { key, dir };
        }
        sortChain.set(chain);
    }
    function clearSort() { sortChain.set([]); }

    // =========================================================================
    // --- Grouping + aggregation (M3) -----------------------------------------
    // =========================================================================
    //
    // Pipeline slots between filter and sort:
    //
    //   rowsGetter -> filteredRows -> [groupedRows -> visibleEntries] -> visibleRows
    //                                       |            |
    //                                       |            +-- sticky headers / grand total
    //                                       +-- sort applies WITHIN each leaf group
    //
    // When `groupBy()` is empty the pipeline short-circuits and behaves
    // identically to 1.1.0 -- `groupedRows` is `null`, `visibleEntries` is
    // built by wrapping `sortedFilteredRows` in `{type:"data", row}` cheaply,
    // and `visibleRows` is just those rows without the wrapper. Non-grouping
    // tables pay nothing beyond one signal read.
    //
    // Aggregates are pure folds over a group's data rows. Multi-level groups
    // recompute aggregates from LEAF rows at every depth rather than rolling
    // up child aggregates -- this stays correct for non-associative reducers
    // like median or "distinct count" that don't compose. For deep trees the
    // constant factor is dominated by the leaf-row walk regardless, so the
    // simpler implementation is also the faster-per-line one.

    // ---- Group-path serialization ------------------------------------------
    // Paths are arrays like ["Europe", "Books"]. We serialize with an ASCII
    // Unit Separator (U+001F) that essentially never appears in user data,
    // avoiding collisions with values that contain other punctuation. The
    // signal-side always operates on path arrays; strings are the storage
    // key for the collapsed-groups Set (Sets can't compare arrays by value).
    const GROUP_PATH_SEP = "\x1f";
    // Sentinel bucket key for null/undefined group values. Kept internal so
    // consumers never see it -- they see the group's `value` as `null`.
    const GROUP_NULL_KEY = "\x00__lt_null_group__";
    function _pathStr(pathArr) { return pathArr.join(GROUP_PATH_SEP); }

    // ---- Built-in aggregators ----------------------------------------------
    // Each takes (rows, col) and returns the folded value. Null/undefined
    // values are skipped except for `count`, which counts rows regardless.
    // `avg` / `min` / `max` return `null` for empty groups so consumers can
    // tell "no data" from "zero".
    const AGGS = {
        sum(rows, col) {
            let s = 0;
            for (let i = 0; i < rows.length; i++) {
                const v = readCell(col, rows[i]);
                if (typeof v === "number" && !isNaN(v)) s += v;
            }
            return s;
        },
        avg(rows, col) {
            let s = 0, n = 0;
            for (let i = 0; i < rows.length; i++) {
                const v = readCell(col, rows[i]);
                if (typeof v === "number" && !isNaN(v)) { s += v; n++; }
            }
            return n === 0 ? null : s / n;
        },
        min(rows, col) {
            let m = null;
            for (let i = 0; i < rows.length; i++) {
                const v = readCell(col, rows[i]);
                if (v == null) continue;
                if (m === null || v < m) m = v;
            }
            return m;
        },
        max(rows, col) {
            let m = null;
            for (let i = 0; i < rows.length; i++) {
                const v = readCell(col, rows[i]);
                if (v == null) continue;
                if (m === null || v > m) m = v;
            }
            return m;
        },
        count(rows /*, col */) { return rows.length; }
    };
    function _resolveAggregator(spec) {
        if (typeof spec === "function") return spec;
        if (typeof spec === "string" && AGGS[spec]) return AGGS[spec];
        return null;
    }
    // Pre-resolved (columnKey -> aggregator fn) map. Rebuilt lazily on first
    // read and again if columns changes -- but columns is static after
    // createTable, so this is a one-shot in practice.
    let _aggregators = null;
    function _getAggregators() {
        if (_aggregators !== null) return _aggregators;
        _aggregators = new Map();
        for (const col of columns) {
            const fn = _resolveAggregator(col.aggregate);
            if (fn) _aggregators.set(col.key, fn);
        }
        return _aggregators;
    }
    function _computeAggregates(rows) {
        const aggs = _getAggregators();
        const result = new Map();
        for (const [key, fn] of aggs) {
            const col = columnsByKey.get(key);
            if (!col) continue;
            result.set(key, fn(rows, col));
        }
        return result;
    }

    // ---- Reactive state -----------------------------------------------------
    // groupBy is a signal so consumers can flip grouping on/off at runtime.
    // Accepts a string (single level), string[] (multi-level), or null/empty
    // (no grouping). Normalized to an array of valid column keys internally.
    function _normalizeGroupBy(v) {
        const arr = v == null ? [] : (Array.isArray(v) ? v : [v]);
        // Drop unknown keys silently -- lets consumers persist their groupBy
        // to localStorage without a crash if a column was removed later.
        const out = [];
        for (const k of arr) {
            if (typeof k === "string" && columnsByKey.has(k)) out.push(k);
        }
        return out;
    }
    const groupBy = scope.signal(_normalizeGroupBy(config.groupBy));

    // collapsedGroups: Set<pathStr>. Any group whose pathStr is present is
    // rendered as a header but its subtree (subgroups + data rows) is not
    // emitted into visibleEntries. Initial set can be supplied as an array
    // of path arrays via `initialCollapsedGroups`.
    const collapsedGroups = scope.signal(
        (() => {
            const init = config.initialCollapsedGroups;
            const s = new Set();
            if (Array.isArray(init)) {
                for (const p of init) {
                    if (Array.isArray(p)) s.add(_pathStr(p.map(String)));
                }
            }
            return s;
        })()
    );

    // showGrandTotal: static bool. Making it reactive adds a fanout with
    // near-zero benefit -- if a consumer wants runtime toggling they can
    // re-mount. Guarded here to avoid accidental truthy configs.
    const showGrandTotal = config.showGrandTotal === true;

    // ---- Sort helper (used both by ungrouped path and leaf-group sort) -----
    // Factored out of the ungrouped visibleRows so leaf groups can call it
    // with their own row subset without allocating a new sort buffer.
    // Returns a NEW array of row references; the input is not mutated.
    function _sortRowsWithChain(src, chain) {
        const n = src.length;
        if (!chain.length || n < 2) return src.slice();
        if (!_sortIdxBuf || _sortIdxBuf.length < n) {
            const cap = Math.max(n, _sortIdxBuf ? _sortIdxBuf.length * 2 : 1024);
            _sortIdxBuf = new Uint32Array(cap);
        }
        const view = _sortIdxBuf.subarray(0, n);
        for (let i = 0; i < n; i++) view[i] = i;
        view.sort((iA, iB) => {
            const rowA = src[iA], rowB = src[iB];
            for (let k = 0; k < chain.length; k++) {
                const entry = chain[k];
                const col = columnsByKey.get(entry.key);
                if (!col) continue;
                const av = readCell(col, rowA);
                const bv = readCell(col, rowB);
                const c = col.compare(av, bv);
                if (c !== 0) return entry.dir === "desc" ? -c : c;
            }
            return iA - iB;
        });
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = src[view[i]];
        return out;
    }

    // ---- Group tree ---------------------------------------------------------
    // Recursive partition. At each depth, buckets by (accessor-resolved)
    // column value; group-key ordering is ascending on the raw bucket key.
    // Null values bucket under GROUP_NULL_KEY and sort last so they're
    // visually distinct.
    function _partition(rows, keys, depth, parentPath) {
        const groupKey = keys[depth];
        const col = columnsByKey.get(groupKey);
        // Insertion-order Map -> we later sort keys; using Map keeps values
        // grouped without a hashmap of arrays.
        const buckets = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const v = col ? readCell(col, row) : row[groupKey];
            const bucketKey = v == null ? GROUP_NULL_KEY : v;
            let bucket = buckets.get(bucketKey);
            if (!bucket) { bucket = []; buckets.set(bucketKey, bucket); }
            bucket.push(row);
        }
        const sortedKeys = [...buckets.keys()].sort((a, b) => {
            // Nulls last, regardless of asc/desc semantics.
            if (a === GROUP_NULL_KEY) return 1;
            if (b === GROUP_NULL_KEY) return -1;
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        });
        const nodes = new Array(sortedKeys.length);
        const isLeaf = depth + 1 >= keys.length;
        const chain = sortChain();
        for (let i = 0; i < sortedKeys.length; i++) {
            const bk = sortedKeys[i];
            const bucketRows = buckets.get(bk);
            const path = parentPath.length === 0
                ? [String(bk === GROUP_NULL_KEY ? "" : bk)]
                : parentPath.concat([String(bk === GROUP_NULL_KEY ? "" : bk)]);
            const pathStr = _pathStr(path);
            const node = {
                depth,
                key: groupKey,
                value: bk === GROUP_NULL_KEY ? null : bk,
                path,
                pathStr,
                count: bucketRows.length,
                // Aggregates always fold over LEAF rows (this bucket's
                // recursive descendants when non-leaf, or its own rows when
                // leaf -- same set at every level for pure aggregators).
                aggregates: _computeAggregates(bucketRows),
                subGroups: null,
                rows: null
            };
            if (isLeaf) {
                node.rows = _sortRowsWithChain(bucketRows, chain);
            } else {
                node.subGroups = _partition(bucketRows, keys, depth + 1, path);
            }
            nodes[i] = node;
        }
        return nodes;
    }

    // groupedRows: null when no grouping, GroupNode[] when active.
    const groupedRows = scope.computed(() => {
        const keys = groupBy();
        if (keys.length === 0) return null;
        const src = filteredRows();
        // Re-read sortChain via the sortChain read inside _partition -> that
        // makes leaf-group sort reactive. If we called _sortRowsWithChain
        // here directly we'd need explicit sortChain() first.
        return _partition(src, keys, 0, []);
    });

    // ---- Emit tree to a flat entries array ---------------------------------
    // A depth-first walk that respects the current collapsed-groups Set.
    // Entries are one of:
    //   { type: "data",         row }
    //   { type: "group-header", depth, key, value, path, pathStr, count,
    //                            aggregates, isCollapsed }
    //   { type: "grand-total",  aggregates, count }
    // The mount layer dispatches per-slot rendering on `entry.type`.
    function _emitTree(nodes, out, collapsed) {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const isCollapsed = collapsed.has(node.pathStr);
            out.push({
                type: "group-header",
                depth: node.depth,
                key: node.key,
                value: node.value,
                path: node.path,
                pathStr: node.pathStr,
                count: node.count,
                aggregates: node.aggregates,
                isCollapsed
            });
            if (isCollapsed) continue;
            if (node.subGroups) {
                _emitTree(node.subGroups, out, collapsed);
            } else {
                const rows = node.rows;
                for (let j = 0; j < rows.length; j++) {
                    out.push({ type: "data", row: rows[j] });
                }
            }
        }
    }

    // Ungrouped -> `visibleRows` behavior, exactly like 1.1.0.
    // Kept as a private computed so the ungrouped fast path doesn't have to
    // build entries + strip them.
    const _sortedFilteredRows = scope.computed(() => {
        const src = filteredRows();
        const chain = sortChain();
        if (!chain.length) return src;
        return _sortRowsWithChain(src, chain);
    });

    const visibleEntries = scope.computed(() => {
        const tree = groupedRows();
        const collapsed = collapsedGroups();
        let entries;
        if (tree === null) {
            // Ungrouped: wrap each sorted-filtered row as a data entry.
            const rows = _sortedFilteredRows();
            entries = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) entries[i] = { type: "data", row: rows[i] };
        } else {
            entries = [];
            _emitTree(tree, entries, collapsed);
        }
        if (showGrandTotal) {
            // Grand-total aggregates ALWAYS fold over filteredRows (the
            // whole visible-in-consumer's-sense dataset), regardless of
            // collapse state. Consumers expect the total to be stable when
            // they collapse a group.
            const src = filteredRows();
            entries.push({
                type: "grand-total",
                aggregates: _computeAggregates(src),
                count: src.length
            });
        }
        return entries;
    });

    // visibleRows: BACKWARDS COMPAT -- always returns just data rows in
    // current display order. Ungrouped: same array as 1.1.0's visibleRows.
    // Grouped: data rows extracted from visibleEntries (respects collapse).
    const visibleRows = scope.computed(() => {
        // Ungrouped fast path -- skip entries entirely.
        if (groupBy().length === 0) return _sortedFilteredRows();
        const entries = visibleEntries();
        const out = [];
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].type === "data") out.push(entries[i].row);
        }
        return out;
    });

    // rowCount: still counts DATA rows (backwards compat). Consumers that
    // want the total including group headers should read entryCount().
    const rowCount = scope.computed(() => visibleRows().length);
    // entryCount: total emitted entries -- drives the virtual axis in the
    // mount layer so group-header rows take vertical space in the scrolled
    // content just like data rows do.
    const entryCount = scope.computed(() => visibleEntries().length);

    // ---- Grouping mutators -------------------------------------------------
    function setGroupBy(v) {
        const next = _normalizeGroupBy(v);
        // Avoid unnecessary signal writes when the effective value is the
        // same array of keys. Cheap len+scan comparison.
        const cur = groupBy();
        if (cur.length === next.length) {
            let same = true;
            for (let i = 0; i < cur.length; i++) {
                if (cur[i] !== next[i]) { same = false; break; }
            }
            if (same) return;
        }
        groupBy.set(next);
        // Prune collapsed paths whose top-level key is no longer part of
        // groupBy -- otherwise stale entries linger in the Set forever.
        // (We can't reason about deeper paths without walking the tree, and
        // they're harmless since they'll never match a real path anyway.)
        if (collapsedGroups().size > 0 && next.length === 0) {
            collapsedGroups.set(new Set());
        }
    }
    function _mutateCollapse(fn) {
        const s = collapsedGroups();
        const next = new Set(s);
        fn(next);
        // Only publish a new Set if membership actually changed -- keeps
        // downstream computeds stable.
        if (next.size !== s.size) { collapsedGroups.set(next); return; }
        for (const k of next) { if (!s.has(k)) { collapsedGroups.set(next); return; } }
    }
    function collapseGroup(path) {
        if (!Array.isArray(path)) return;
        const key = _pathStr(path.map(String));
        _mutateCollapse((s) => s.add(key));
    }
    function expandGroup(path) {
        if (!Array.isArray(path)) return;
        const key = _pathStr(path.map(String));
        _mutateCollapse((s) => s.delete(key));
    }
    function toggleGroup(path) {
        if (!Array.isArray(path)) return;
        const key = _pathStr(path.map(String));
        _mutateCollapse((s) => { if (s.has(key)) s.delete(key); else s.add(key); });
    }
    function collapseAllGroups() {
        // Walk the current groupedRows tree and collect every group's pathStr.
        // Only makes sense when grouping is active.
        const tree = groupedRows();
        if (tree === null) return;
        const s = new Set();
        (function walk(nodes) {
            for (const n of nodes) {
                s.add(n.pathStr);
                if (n.subGroups) walk(n.subGroups);
            }
        })(tree);
        collapsedGroups.set(s);
    }
    function expandAllGroups() { collapsedGroups.set(new Set()); }

    // Convenience: is a path currently collapsed? Fast enough that consumers
    // can bind it into row-level effects without indirection.
    function isGroupCollapsed(path) {
        if (!Array.isArray(path)) return false;
        return collapsedGroups().has(_pathStr(path.map(String)));
    }

    // Ancestor lookup for sticky-header rendering: given an entry index
    // (usually axis.start()), returns the group-header entries that CONTAIN
    // it -- one per depth level, deepest last. Returns [] for the ungrouped
    // path or when the target is above the first group header.
    function groupAncestryAt(entryIndex) {
        const entries = visibleEntries();
        if (entryIndex < 0 || entryIndex >= entries.length) return [];
        const target = entries[entryIndex];
        // If target is a group-header, its own row is what the mount is
        // rendering -- ancestors are strictly-shallower headers. If it's a
        // data row, ancestors are ALL group headers containing it.
        const maxDepth = target.type === "group-header" ? target.depth : Infinity;
        const active = [];
        for (let i = entryIndex; i >= 0; i--) {
            const e = entries[i];
            if (e.type === "group-header" && e.depth < maxDepth && active[e.depth] === undefined) {
                active[e.depth] = e;
                // Early exit once we've collected every needed level.
                let complete = true;
                for (let d = 0; d < maxDepth && d <= e.depth + 8 /* safety */; d++) {
                    if (active[d] === undefined) { complete = false; break; }
                }
                if (complete && maxDepth !== Infinity) break;
            }
            if (e.type === "data" && active.length > 0) {
                // Data rows always come AFTER their headers. If we've filled
                // every shallower depth we can stop.
                let complete = true;
                for (let d = 0; d < active.length; d++) {
                    if (active[d] === undefined) { complete = false; break; }
                }
                if (complete) break;
            }
        }
        // Trim trailing undefined slots.
        const out = [];
        for (let i = 0; i < active.length; i++) {
            if (active[i] !== undefined) out.push(active[i]);
        }
        return out;
    }

    // =========================================================================
    // --- End grouping --------------------------------------------------------
    // =========================================================================

    // --- Selection ---
    // The selection state is a PREDICATE, not a list of IDs. Two modes:
    //
    //   mode: "whitelist" -> set contains the selected IDs (the classic case).
    //   mode: "all"       -> set is a BLACKLIST. Every row is selected EXCEPT
    //                        those in the set. This makes Ctrl+A across 1M rows
    //                        an O(1) operation -- no Set construction, no walk
    //                        of the row source, no per-ID allocation.
    //
    // The cost is paid only at materialization: `selectedIds(source)` and
    // `selectedRows(source)` walk the source once and run the predicate per
    // row. Callers that want to stream (CSV export, server upload) use
    // `forEachSelected` instead and never materialize the full list at all.
    //
    // Practical wins of the inversion:
    //   1. New rows arriving from a paged backend after Ctrl+A are auto-
    //      included -- "all" is a predicate evaluated at read time, not a
    //      snapshot of IDs at click time.
    //   2. Partial materialization (export top 1000 of a select-all set) is
    //      possible. With a 1M-entry whitelist it wasn't -- you had no way
    //      to know what was selected without enumerating.
    //   3. `selectedCount()` is O(1) (rowCount - blacklist.size or
    //      whitelist.size), suitable for a reactive "X selected" badge.
    //
    // Range-select (shift-click) switches the selection BACK to whitelist
    // mode, scoped to the range. This matches AG Grid's convention and what
    // most users expect.
    const selection = scope.signal({ mode: "whitelist", set: new Set() });
    const selectionAnchor = scope.signal(null);

    function isSelected(rowId) {
        const sel = selection();
        return sel.mode === "all" ? !sel.set.has(rowId) : sel.set.has(rowId);
    }

    // Reactive count derived from the predicate state. O(1).
    const selectedCount = scope.computed(() => {
        const sel = selection();
        return sel.mode === "all" ? rowCount() - sel.set.size : sel.set.size;
    });

    function selectRow(rowId, mode) {
        mode = mode || "set";
        const cur = selection.peek();
        if (mode === "set") {
            // Single-click: replace selection with just this row. Always
            // collapses to a single-entry whitelist regardless of prior mode.
            selection.set({ mode: "whitelist", set: new Set([rowId]) });
            selectionAnchor.set(rowId);
        } else if (mode === "add") {
            // Ensure rowId is selected. In whitelist mode, add to set; in
            // all-mode, remove from blacklist.
            const next = new Set(cur.set);
            if (cur.mode === "all") next.delete(rowId);
            else next.add(rowId);
            selection.set({ mode: cur.mode, set: next });
            if (!selectionAnchor.peek()) selectionAnchor.set(rowId);
        } else if (mode === "toggle") {
            // Flip rowId's membership. In whitelist mode, toggle in set; in
            // all-mode, toggle in blacklist (which inverts membership).
            const next = new Set(cur.set);
            if (next.has(rowId)) next.delete(rowId);
            else next.add(rowId);
            selection.set({ mode: cur.mode, set: next });
            selectionAnchor.set(rowId);
        } else if (mode === "range") {
            selectRowRange(selectionAnchor.peek(), rowId);
            return;
        }
    }

    function selectRowRange(anchorId, targetId) {
        const list = visibleRows();
        if (anchorId == null) {
            // No anchor yet -- behave as a single-row set.
            selection.set({ mode: "whitelist", set: new Set([targetId]) });
            selectionAnchor.set(targetId);
            return;
        }
        let aIdx = -1, tIdx = -1;
        for (let i = 0; i < list.length; i++) {
            const id = getRowId(list[i]);
            if (id === anchorId) aIdx = i;
            if (id === targetId) tIdx = i;
            if (aIdx >= 0 && tIdx >= 0) break;
        }
        if (tIdx < 0) return;
        if (aIdx < 0) aIdx = tIdx;
        const [from, to] = aIdx < tIdx ? [aIdx, tIdx] : [tIdx, aIdx];
        const next = new Set();
        for (let i = from; i <= to; i++) next.add(getRowId(list[i]));
        // Range select always collapses to a whitelist of the range. If the
        // caller was previously in select-all mode, this is the documented
        // "shift-click switches back to whitelist of range" convention.
        selection.set({ mode: "whitelist", set: next });
    }

    function selectAll() {
        // O(1). Flip to all-mode with an empty blacklist. No walk of rows,
        // no Set construction with N entries. The predicate `isSelected`
        // immediately returns true for every row.
        selection.set({ mode: "all", set: new Set() });
        const first = visibleRows()[0];
        if (first && selectionAnchor.peek() == null) {
            selectionAnchor.set(getRowId(first));
        }
    }

    function clearSelection() {
        selection.set({ mode: "whitelist", set: new Set() });
        selectionAnchor.set(null);
    }

    // Materializers. These are the only O(N) operations -- you only pay the
    // walk cost when something explicitly asks for the list. Source defaults
    // to current visibleRows() but callers can pass a different source (e.g.
    // unsorted master list for export).
    function selectedIds(source) {
        const rows = source != null ? source : visibleRows();
        const out = [];
        const sel = selection.peek();
        if (sel.mode === "all") {
            for (let i = 0; i < rows.length; i++) {
                const id = getRowId(rows[i]);
                if (!sel.set.has(id)) out.push(id);
            }
        } else {
            for (let i = 0; i < rows.length; i++) {
                const id = getRowId(rows[i]);
                if (sel.set.has(id)) out.push(id);
            }
        }
        return out;
    }
    function selectedRows(source) {
        const rows = source != null ? source : visibleRows();
        const out = [];
        const sel = selection.peek();
        if (sel.mode === "all") {
            for (let i = 0; i < rows.length; i++) {
                if (!sel.set.has(getRowId(rows[i]))) out.push(rows[i]);
            }
        } else {
            for (let i = 0; i < rows.length; i++) {
                if (sel.set.has(getRowId(rows[i]))) out.push(rows[i]);
            }
        }
        return out;
    }
    // Iterator form. fn receives (row, id, index). Return false to stop early.
    // This is the recommended path for CSV export, server upload, or any
    // per-row processing -- it never allocates the materialized list.
    function forEachSelected(fn, source) {
        const rows = source != null ? source : visibleRows();
        const sel = selection.peek();
        if (sel.mode === "all") {
            for (let i = 0; i < rows.length; i++) {
                const id = getRowId(rows[i]);
                if (!sel.set.has(id)) {
                    if (fn(rows[i], id, i) === false) return;
                }
            }
        } else {
            for (let i = 0; i < rows.length; i++) {
                const id = getRowId(rows[i]);
                if (sel.set.has(id)) {
                    if (fn(rows[i], id, i) === false) return;
                }
            }
        }
    }

    // --- Focus ---
    const focusedCell = scope.signal(initialFocus);

    /**
     * Move focused cell by direction. Side-effecting: scrolls focused row
     * into view in the mount (mount subscribes to focusedCell movement).
     */
    function moveFocus(direction, opts) {
        opts = opts || {};
        const list = visibleRows();
        const cols = visibleColumns();
        if (!list.length || !cols.length) return;
        const cur = focusedCell();
        // No focus yet -> seed at the first cell. Without this, ArrowDown
        // from a null focus lands on row 1 (impl treats null as row -1 then
        // moves down to 0+1), which surprises keyboard users who expect the
        // first arrow to PUT them in the grid, not move them past row 0.
        if (!cur) {
            focusedCell.set({
                rowId: getRowId(list[0]),
                columnKey: cols[0].key
            });
            return;
        }
        let rIdx = -1, cIdx = -1;
        for (let i = 0; i < list.length; i++) {
            if (getRowId(list[i]) === cur.rowId) { rIdx = i; break; }
        }
        for (let i = 0; i < cols.length; i++) {
            if (cols[i].key === cur.columnKey) { cIdx = i; break; }
        }
        if (rIdx < 0) rIdx = 0;
        if (cIdx < 0) cIdx = 0;

        const pageSize = Math.max(1, opts.pageSize || 10);
        switch (direction) {
            case "up":       rIdx = Math.max(0, rIdx - 1); break;
            case "down":     rIdx = Math.min(list.length - 1, rIdx + 1); break;
            case "left":     cIdx = Math.max(0, cIdx - 1); break;
            case "right":    cIdx = Math.min(cols.length - 1, cIdx + 1); break;
            case "home":     cIdx = 0; break;
            case "end":      cIdx = cols.length - 1; break;
            case "rowStart": rIdx = 0; cIdx = 0; break;
            case "rowEnd":   rIdx = list.length - 1; cIdx = cols.length - 1; break;
            case "pageUp":   rIdx = Math.max(0, rIdx - pageSize); break;
            case "pageDown": rIdx = Math.min(list.length - 1, rIdx + pageSize); break;
            default: return;
        }
        focusedCell.set({
            rowId: getRowId(list[rIdx]),
            columnKey: cols[cIdx].key
        });
    }

    // --- Column mutations ---
    function setColumnWidth(key, w) {
        const c = columnsByKey.get(key);
        if (!c) return;
        const clamped = Math.max(c.minWidth, Math.min(c.maxWidth, Math.round(w)));
        c.width.set(clamped);
    }
    function setColumnHidden(key, hidden) {
        const c = columnsByKey.get(key);
        if (!c) return;
        c.hidden.set(hidden !== false);
    }
    function setColumnPin(key, side) {
        const c = columnsByKey.get(key);
        if (!c) return;
        const s = side === "left" || side === "right" ? side : "none";
        c.pin.set(s);
    }
    function setColumnFlex(key, flex) {
        const c = columnsByKey.get(key);
        if (!c) return;
        c.flex.set(typeof flex === "number" && flex > 0 ? flex : 0);
    }
    function setColumnOrder(keys) {
        if (!Array.isArray(keys)) return;
        // Validate: must be a permutation of declared keys.
        if (keys.length !== columns.length) return;
        for (const k of keys) if (!columnsByKey.has(k)) return;
        const seen = new Set(keys);
        if (seen.size !== keys.length) return;
        columnOrder.set(keys.slice());
    }
    function moveColumn(fromKey, toKey, opts) {
        opts = opts || {};
        const before = opts.before !== false;
        const order = columnOrder().slice();
        const fromIdx = order.indexOf(fromKey);
        const toIdx = order.indexOf(toKey);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
        const [moved] = order.splice(fromIdx, 1);
        const target = order.indexOf(toKey);
        order.splice(before ? target : target + 1, 0, moved);
        columnOrder.set(order);
    }

    // --- Filters (M2 mutators) ---
    function setColumnFilter(key, value) {
        const col = columnsByKey.get(key);
        if (!col || !col.filterable) return;
        const next = new Map(columnFilters());
        if (value === null || value === undefined || value === "") {
            next.delete(key);
        } else {
            next.set(key, String(value));
        }
        columnFilters.set(next);
    }
    function clearColumnFilters() {
        if (columnFilters().size === 0) return;
        columnFilters.set(new Map());
    }

    // --- Cell editing (M2) ---
    // editingCell points at the (rowId, columnKey) currently being edited,
    // or null. Like focusedCell, editing is keyed on row identity so it
    // survives scroll, sort, filter, slot recycling -- a cell that scrolls
    // out of the viewport stays "editing" if it scrolls back in.
    const editingCell = scope.signal(null);
    // editingDraft is the in-progress value being typed. mountTable writes to
    // it from `input` events on the contenteditable cell; the consumer rarely
    // needs to read this directly (commitEdit captures it for them).
    const editingDraft = scope.signal("");

    function isEditing(rowId, columnKey) {
        const e = editingCell();
        if (e === null) return false;
        return e.rowId === rowId && e.columnKey === columnKey;
    }

    function startEdit(rowId, columnKey) {
        const col = columnsByKey.get(columnKey);
        if (!col || !col.editable) return;
        // Already editing this exact cell -- no-op so an idempotent double-
        // click or programmatic call doesn't clobber the in-flight draft.
        const e = editingCell();
        if (e !== null && e.rowId === rowId && e.columnKey === columnKey) return;
        // Editing a different cell -- commit before switching so the user's
        // typed-in value isn't silently dropped on a tab-out / click-elsewhere.
        if (e !== null) {
            commitEdit();
        }
        // Seed the draft with the current cell value so the consumer's
        // onCellEdit gets a clean oldValue/newValue diff even if they don't
        // touch anything.
        const row = _findRowById(rowId);
        if (row !== undefined) {
            const v = readCell(col, row);
            editingDraft.set(v === null || v === undefined ? "" : String(v));
        } else {
            editingDraft.set("");
        }
        editingCell.set({ rowId, columnKey });
    }

    function commitEdit(explicitValue) {
        const e = editingCell();
        if (e === null) return;
        const col = columnsByKey.get(e.columnKey);
        const row = _findRowById(e.rowId);
        const newValue = arguments.length > 0 ? explicitValue : editingDraft();
        editingCell.set(null);
        editingDraft.set("");
        if (col && row !== undefined && onCellEdit) {
            const oldValue = readCell(col, row);

            // No-op guard: skip the hook when nothing actually changed.
            // If newValue is a string (from contenteditable), coerce oldValue
            // to a string to prevent false positives (e.g., 100 !== "100").
            // If a non-string is explicitly passed, use standard strict equality.
            const isChanged = typeof newValue === "string"
                ? String(oldValue) !== newValue
                : oldValue !== newValue;

            if (isChanged) {
                try {
                    onCellEdit({
                        row,
                        columnKey: e.columnKey,
                        oldValue,
                        newValue,
                    });
                } catch (err) {
                    try { console.error("lite-table: onCellEdit threw:", err); } catch (_) {}
                }
            }
        }
    }

    function cancelEdit() {
        if (editingCell() === null) return;
        editingCell.set(null);
        editingDraft.set("");
    }

    // Best-effort row lookup by id. Walks the master once -- O(N). The cell-
    // editing happy path uses this once per commit, not per keystroke, so the
    // linear scan is fine; if a consumer with millions of rows wants O(1)
    // they can build their own id->row index and pass it in via onCellEdit
    // by other means (or use selectedRows-style materializers).
    function _findRowById(rowId) {
        const src = rowsGetter();
        for (let i = 0; i < src.length; i++) {
            if (getRowId(src[i]) === rowId) return src[i];
        }
        return undefined;
    }

    // --- Export ---
    // Resolve the row source for an export call:
    //   rows: "visible"   => visibleRows() (post-sort/filter, post-pagination if you reactify it)
    //   rows: "selected"  => current selection materialized against the chosen source
    //   rows: "all"       => rowsGetter() (the original master)
    //   rows: <array>     => an explicit array (e.g. a snapshot)
    // Selection mode interacts naturally: passing rows: "selected" with
    // selectAll() active exports every row minus the blacklist, which is
    // typically what the user means when they Ctrl+A then "Export selected".
    function _resolveRows(rowsOpt) {
        if (Array.isArray(rowsOpt)) return rowsOpt;
        if (rowsOpt === "all") return rowsGetter();
        if (rowsOpt === "selected") return selectedRows(rowsGetter());
        // default "visible"
        return visibleRows();
    }

    // Resolve column list. "visible" honors hidden + order; "all" walks
    // declared columns in declaration order regardless of hide/order state.
    // Array of keys = explicit projection.
    function _resolveColumns(colsOpt) {
        if (Array.isArray(colsOpt)) {
            const out = [];
            for (const k of colsOpt) {
                const c = columnsByKey.get(k);
                if (c) out.push(c);
            }
            return out;
        }
        if (colsOpt === "all") return columns.slice();
        // default "visible"
        return visibleColumns();
    }

    // Extract the displayed value for a cell: accessor() if present, else
    // row[key]. Used by both exports + a documented helper if you ever
    // want the same projection elsewhere (currently inlined for speed).
    function _cellValue(row, col) {
        return col.accessor ? col.accessor(row) : row[col.key];
    }

    // CSV escape rule (RFC 4180): if a field contains the delimiter, a
    // quote, CR, or LF, it must be enclosed in quotes and any inner quote
    // doubled. We additionally accept a custom delimiter + quote char.
    function _csvEscape(value, delimiter, quote) {
        if (value === null || value === undefined) return "";
        const s = typeof value === "string" ? value : String(value);
        if (s.length === 0) return "";
        // The quote-doubling is a regex with the configured quote char.
        // Build the matcher lazily; for the default '"' delimiter ',' this
        // is the same hot path every call, so V8 caches the regex behind
        // the literal anyway.
        const needsQuote =
            s.indexOf(delimiter) !== -1 ||
            s.indexOf(quote) !== -1 ||
            s.indexOf("\n") !== -1 ||
            s.indexOf("\r") !== -1;
        if (!needsQuote) return s;
        // Double any embedded quote
        let escaped = "";
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            escaped += ch === quote ? quote + quote : ch;
        }
        return quote + escaped + quote;
    }

    /**
     * Export rows to a CSV string.
     *
     * @param {object} [opts]
     * @param {"visible"|"all"|"selected"|Array} [opts.rows="visible"]
     *        Which rows to export.
     * @param {"visible"|"all"|Array<string>} [opts.columns="visible"]
     *        Which columns to project. Array values are column keys.
     * @param {string} [opts.delimiter=","]
     *        Field separator. Common alternatives: "\t" for TSV, ";" for
     *        regional CSV.
     * @param {string} [opts.quote='"']
     *        Quote character (per RFC 4180).
     * @param {boolean} [opts.headers=true]
     *        Emit a header row.
     * @param {string} [opts.newline="\r\n"]
     *        Line separator. RFC 4180 says CRLF; LF works fine for most
     *        consumers and tends to be what spreadsheet imports prefer
     *        when opened on macOS / Linux.
     * @param {boolean} [opts.bom=false]
     *        Prepend a UTF-8 BOM. Excel on Windows uses this to detect
     *        UTF-8 encoding for non-ASCII content.
     * @param {(row:any, col:ColumnState) => unknown} [opts.formatter]
     *        Optional cell formatter run BEFORE the value is stringified
     *        and CSV-escaped. Receives the raw row + the column state.
     *        Use this for date formatting, number locales, etc.
     * @returns {string}
     */
    function exportCsv(opts) {
        opts = opts || {};
        const rows = _resolveRows(opts.rows);
        const cols = _resolveColumns(opts.columns);
        const delimiter = typeof opts.delimiter === "string" && opts.delimiter.length > 0 ? opts.delimiter : ",";
        const quote = typeof opts.quote === "string" && opts.quote.length > 0 ? opts.quote : '"';
        const headers = opts.headers !== false;
        const newline = typeof opts.newline === "string" ? opts.newline : "\r\n";
        const bom = opts.bom === true;
        const fmt = typeof opts.formatter === "function" ? opts.formatter : null;

        // Pre-size for one pass append; the final string is built by Array.join
        // to avoid the O(N^2) string concat trap.
        const lines = [];
        if (headers) {
            const head = new Array(cols.length);
            for (let i = 0; i < cols.length; i++) {
                head[i] = _csvEscape(cols[i].header, delimiter, quote);
            }
            lines.push(head.join(delimiter));
        }
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            const cells = new Array(cols.length);
            for (let c = 0; c < cols.length; c++) {
                const col = cols[c];
                const raw = fmt ? fmt(row, col) : _cellValue(row, col);
                cells[c] = _csvEscape(raw, delimiter, quote);
            }
            lines.push(cells.join(delimiter));
        }
        const body = lines.join(newline);
        return bom ? "\uFEFF" + body : body;
    }

    /**
     * Export rows to a JSON string (or array, if `format: "array"`).
     *
     * @param {object} [opts]
     * @param {"visible"|"all"|"selected"|Array} [opts.rows="visible"]
     * @param {"visible"|"all"|Array<string>} [opts.columns="visible"]
     *        When provided, output objects contain only the projected keys.
     *        With "all" + no formatter, this is just `rows` unchanged
     *        (the raw row objects), so we avoid an unnecessary allocation.
     * @param {number} [opts.indent=0]
     *        JSON.stringify indent. 0 = compact (single line).
     * @param {"string"|"array"} [opts.format="string"]
     *        "string" (default) returns the serialized JSON text.
     *        "array" returns the projected array directly (skips
     *        JSON.stringify). Useful for chaining into IndexedDB,
     *        postMessage, structured clone, or further transforms.
     * @param {(row:any, col:ColumnState) => unknown} [opts.formatter]
     *        Optional cell formatter, same shape as exportCsv.
     * @returns {string|Array<object>}
     */
    function exportJson(opts) {
        opts = opts || {};
        const rows = _resolveRows(opts.rows);
        const colsOpt = opts.columns;
        const fmt = typeof opts.formatter === "function" ? opts.formatter : null;
        const indent = typeof opts.indent === "number" && opts.indent > 0 ? opts.indent : 0;
        const asArray = opts.format === "array";

        let out;

        // Fast path: when the consumer wants the raw row objects (no column
        // projection, no formatter) we can return the array as-is for
        // format:"array" or stringify it directly for format:"string".
        if (colsOpt === undefined && !fmt) {
            // Default behaviour: project to visible columns (matches CSV
            // default). If you really want the raw rows, pass columns: "all".
            // We still go through the projection path below.
        }

        if (colsOpt === "all" && !fmt) {
            // Raw rows -- safe because we don't mutate, the consumer owns
            // the lifetime of the strings.
            out = rows.slice();
        } else {
            const cols = _resolveColumns(colsOpt);
            out = new Array(rows.length);
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                const obj = {};
                for (let c = 0; c < cols.length; c++) {
                    const col = cols[c];
                    obj[col.key] = fmt ? fmt(row, col) : _cellValue(row, col);
                }
                out[r] = obj;
            }
        }

        if (asArray) return out;
        return indent > 0 ? JSON.stringify(out, null, indent) : JSON.stringify(out);
    }

    return {
        // Static
        columns,
        getRowId,
        rowHeight,
        overscan,
        cellId: makeCellId,

        // Reactive: data
        rowsGetter,
        filteredRows,
        visibleRows,
        rowCount,

        // Reactive: grouping + aggregation (M3)
        groupBy,
        collapsedGroups,
        groupedRows,
        visibleEntries,
        entryCount,

        // Reactive: columns
        columnOrder,
        visibleColumns,
        displayIndexByKey,
        colPlacement,
        colTemplate,
        contentWidth,
        leftOffsets,
        rightOffsets,

        // Reactive: sort / filters
        sortChain,
        columnFilters,

        // Reactive: focus / selection / editing
        focusedCell,
        selection,
        selectionAnchor,
        selectedCount,
        editingCell,
        editingDraft,

        // Methods: sort
        setSort, addSort, toggleSort, clearSort,

        // Methods: selection
        selectRow, selectRowRange, selectAll, clearSelection, isSelected,
        selectedIds, selectedRows, forEachSelected,

        // Methods: columns
        setColumnWidth, setColumnHidden, setColumnPin, setColumnFlex,
        setColumnOrder, moveColumn,

        // Methods: filters
        setColumnFilter, clearColumnFilters,

        // Methods: grouping (M3)
        setGroupBy, toggleGroup, expandGroup, collapseGroup,
        expandAllGroups, collapseAllGroups, isGroupCollapsed,
        groupAncestryAt,

        // Methods: editing
        startEdit, commitEdit, cancelEdit, isEditing,

        // Methods: export
        exportCsv, exportJson,

        // Methods: focus
        moveFocus,

        // Lifecycle
        dispose,
        _scope: scope
    };
}

// =============================================================================
// 4. DEFAULT STYLES
// =============================================================================

const DEFAULT_STYLES =
    // Root container
    ".lt-root{display:flex;flex-direction:column;position:relative;outline:none;" +
    "width:100%;height:100%;min-height:0;font-family:system-ui,sans-serif;" +
    "font-size:14px;color:#0f172a;border:1px solid #e2e8f0;border-radius:6px;" +
    "overflow:hidden;box-sizing:border-box;--lt-pin-bg:#fff;--lt-pin-alt-bg:#fafafa}" +
    ".lt-root:focus-visible{box-shadow:0 0 0 2px #3b82f6}" +

    // Header. width: max-content lets the grid container be sized by the
    // sum of its column tracks (their natural widths). min-width: 100% then
    // stretches it to the viewport when the viewport is wider so flex
    // columns can absorb leftover space. This pair is more robust than the
    // earlier `width: 100%; min-width: <computed contentWidth>px` approach,
    // which forced a calculated width that could disagree with what the
    // grid template actually distributed -- especially when flex columns
    // had a minWidth floor that bumped above the share-of-fr they would
    // have received in the available space.
    ".lt-header{display:grid;grid-template-columns:var(--lt-cols);position:sticky;" +
    "top:0;z-index:3;background:#f8fafc;border-bottom:1px solid #e2e8f0;" +
    "user-select:none;width:max-content;min-width:100%}" +
    ".lt-header-cell{padding:8px 12px;font-weight:600;color:#334155;" +
    "border-right:1px solid #e2e8f0;overflow:hidden;text-overflow:ellipsis;" +
    "white-space:nowrap;background:#f8fafc;position:relative;" +
    "display:flex;align-items:center;gap:6px;cursor:default;" +
    // grid-row: 1 -- LOCK every header cell to row 1. CSS Grid's sparse
    // auto-placement cursor never moves backwards: if DOM-order N has
    // grid-column:5 and DOM-order N+1 (a column reordered to the front)
    // has grid-column:1, the placement cursor is past col 5 in row 1 and
    // cannot backtrack -- the second item gets put on row 2. With
    // grid-row:1 explicit on every cell, the auto-placement walk is
    // bypassed entirely and the row can never overflow. This is the fix
    // for the header-wraps-after-reorder bug.
    "grid-row:1;" +
    // touch-action: none -- on touch devices, pointer events default to
    // touch-action: auto which lets the browser claim pointermove for
    // native scroll BEFORE our 4px drag threshold triggers capture. None
    // means drag-to-sort and drag-to-reorder actually receive pointermove.
    // Horizontal scroll of the table is initiated from the body, not the
    // header, so this doesn't reduce scrolling affordance.
    "touch-action:none}" +
    ".lt-header-cell.is-sortable{cursor:pointer}" +
    // Dragged cell: dim + outlined ghost so the user can clearly see what
    // they're carrying. opacity alone (the old behavior) was easy to miss
    // against a low-contrast row background, especially in dark themes.
    ".lt-header-cell.is-dragging{opacity:0.45;outline:2px dashed #3b82f6;" +
    "outline-offset:-3px;cursor:grabbing}" +
    // Drop indicators: 4px solid blue bar with a soft pulse animation so the
    // user can see where the column will land. The earlier 2px inset shadow
    // was too thin to read against a dense header.
    ".lt-header-cell.is-drop-before{box-shadow:4px 0 0 #2563eb inset;" +
    "animation:lt-drop-pulse 0.9s ease-in-out infinite}" +
    ".lt-header-cell.is-drop-after{box-shadow:-4px 0 0 #2563eb inset;" +
    "animation:lt-drop-pulse 0.9s ease-in-out infinite}" +
    "@keyframes lt-drop-pulse{0%,100%{filter:none}50%{filter:brightness(1.15)}}" +
    ".lt-header-cell[data-pin=\"left\"]{position:sticky;z-index:4;background:#f8fafc}" +
    ".lt-header-cell[data-pin=\"right\"]{position:sticky;z-index:4;background:#f8fafc}" +
    ".lt-header-cell-label{flex:1;overflow:hidden;text-overflow:ellipsis;" +
    "pointer-events:none}" +
    ".lt-header-sort{font-size:10px;color:#64748b;font-weight:600;min-width:14px;" +
    "text-align:right;pointer-events:none}" +
    ".lt-header-resize{position:absolute;top:0;right:0;width:6px;height:100%;" +
    "cursor:col-resize;user-select:none;touch-action:none}" +
    ".lt-header-resize:hover,.lt-header-resize.is-active{background:#3b82f6}" +
    // While ANY column is being dragged, every cursor in the table becomes
    // grabbing. The class is applied to the root by attachHeaderInteraction.
    ".lt-root.is-dragging-column,.lt-root.is-dragging-column *{cursor:grabbing !important}" +

    // Viewport. The viewport itself is the scroll container; inner uses the
    // same width pair as header so they scroll together as one wide surface
    // when columns exceed viewport.
    ".lt-viewport{flex:1;overflow:auto;position:relative;contain:strict}" +
    ".lt-inner{position:relative;width:max-content;min-width:100%}" +

    // Rows
    ".lt-row{display:grid;grid-template-columns:var(--lt-cols);" +
    "position:absolute;left:0;right:0;top:0;border-bottom:1px solid #f1f5f9;" +
    "background:var(--lt-pin-bg);contain:layout style}" +
    ".lt-row.lt-row-alt{background:var(--lt-pin-alt-bg)}" +
    ".lt-row.is-selected{background:#dbeafe}" +
    ".lt-row.is-selected.lt-row-alt{background:#bfdbfe}" +

    // Cells. grid-row: 1 -- LOCK to row 1 to bypass CSS Grid sparse
    // auto-placement (see the .lt-header-cell rule above for the full
    // explanation). Without this lock, a reordered column whose new
    // grid-column lies "before" the placement cursor of the previous
    // sibling wraps to row 2, taking its row's data with it.
    ".lt-cell{padding:6px 12px;overflow:hidden;text-overflow:ellipsis;" +
    "white-space:nowrap;border-right:1px solid #f1f5f9;line-height:20px;" +
    "background:inherit;box-sizing:border-box;grid-row:1}" +
    ".lt-cell[data-pin=\"left\"]{position:sticky;z-index:2}" +
    ".lt-cell[data-pin=\"right\"]{position:sticky;z-index:2}" +
    // Focus ring via outline: doesn't affect layout, doesn't promote the
    // cell to a new stacking context (which box-shadow + position:relative
    // could do, causing pixel-shift during compositor layer creation), and
    // doesn't conflict with sticky positioning on pinned cells.
    ".lt-cell.is-focused{outline:2px solid #3b82f6;outline-offset:-2px}" +
    // M2: editable cell affordance (subtle cursor hint on hover) + active
    // editing state (filled background + caret-line outline).
    ".lt-cell[data-editable=\"true\"]{cursor:text}" +
    ".lt-cell.is-editing{outline:2px solid #f59e0b;outline-offset:-2px;" +
    "background:#fff;overflow:visible;white-space:normal;" +
    "text-overflow:clip}" +
    // M2: filter row sits between header and viewport, mirrors --lt-cols.
    ".lt-filter-row{position:sticky;top:32px;z-index:4;display:grid;" +
    "grid-template-columns:var(--lt-cols);background:#f1f5f9;" +
    "border-bottom:1px solid #e2e8f0;width:max-content;min-width:100%;" +
    "grid-auto-flow:column;grid-template-rows:auto}" +
    ".lt-filter-cell{padding:4px 6px;box-sizing:border-box;" +
    "border-right:1px solid #f1f5f9;grid-row:1;background:inherit}" +
    ".lt-filter-cell[data-pin=\"left\"]{position:sticky;z-index:5;background:#f1f5f9}" +
    ".lt-filter-cell[data-pin=\"right\"]{position:sticky;z-index:5;background:#f1f5f9}" +
    ".lt-filter-input{width:100%;padding:3px 6px;font:inherit;font-size:12px;" +
    "background:#fff;color:#0f172a;border:1px solid #cbd5e1;border-radius:3px;" +
    "outline:none;box-sizing:border-box}" +
    ".lt-filter-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px #dbeafe}" +

    // M3: group-header row -- solid background (never striped), bolder
    // typography, per-depth indent on the first-visible cell via padding.
    // The chevron + label are already textual so no icon font required.
    ".lt-row-group-header{background:#eff6ff;font-weight:600;" +
    "border-bottom:1px solid #bfdbfe;cursor:pointer;" +
    // touch-action:none avoids the browser claiming pointermove for
    // native scroll before our toggle handler fires on tap.
    "touch-action:manipulation;user-select:none}" +
    ".lt-row-group-header:hover{background:#dbeafe}" +
    ".lt-row-group-header .lt-cell{background:inherit;font-weight:inherit;" +
    "color:#1e3a8a}" +
    // First cell (chevron + label + count) overflows visibly rather than
    // getting ellipsized -- the label is the group's identity and the user
    // needs to read it, even when the first column is narrow (id, checkbox).
    // Non-first cells keep their normal clipping.
    ".lt-row-group-header .lt-cell:first-child{overflow:visible;" +
    "white-space:nowrap;text-overflow:clip;z-index:1;position:relative}" +
    // Indent the first cell per depth. CSS attribute selectors keep the
    // effect purely in CSS -- no per-slot inline style writes.
    ".lt-row-group-header[data-depth=\"0\"] .lt-cell:first-child{padding-left:12px}" +
    ".lt-row-group-header[data-depth=\"1\"] .lt-cell:first-child{padding-left:28px}" +
    ".lt-row-group-header[data-depth=\"2\"] .lt-cell:first-child{padding-left:44px}" +
    ".lt-row-group-header[data-depth=\"3\"] .lt-cell:first-child{padding-left:60px}" +
    ".lt-row-group-header[data-depth=\"4\"] .lt-cell:first-child{padding-left:76px}" +
    // Collapsed state: dim the row slightly to hint the group is folded.
    ".lt-row-group-header[data-collapsed=\"true\"]{opacity:0.85}" +
    // Aggregate cells (non-first) get a slightly muted color so the
    // group's key value (in first cell) reads as the identity.
    ".lt-row-group-header .lt-cell:not(:first-child){color:#3730a3;" +
    "text-align:right;font-variant-numeric:tabular-nums}" +

    // M3: grand-total row -- pinned appearance (thick top border, sturdy
    // typography). Sits at the tail of visibleEntries when enabled.
    ".lt-row-grand-total{background:#f0f9ff;font-weight:700;" +
    "border-top:2px solid #7dd3fc;border-bottom:1px solid #7dd3fc;" +
    "color:#0c4a6e}" +
    ".lt-row-grand-total .lt-cell{background:inherit;font-weight:inherit;" +
    "color:inherit}" +
    // First cell (the "Total (N)" label) overflows visibly rather than
    // getting ellipsized when the first column is narrow. Same rationale
    // as `.lt-row-group-header .lt-cell:first-child`.
    ".lt-row-grand-total .lt-cell:first-child{overflow:visible;" +
    "white-space:nowrap;text-overflow:clip;z-index:1;position:relative}" +
    ".lt-row-grand-total .lt-cell:not(:first-child){text-align:right;" +
    "font-variant-numeric:tabular-nums}" +

    // M3: sticky overlays -- containers are zero-height so they don't
    // reserve scroll space. Their absolute-positioned rows sit on top of
    // the pool via z-index. Subtle bottom-shadow on sticky group headers
    // and top-shadow on the sticky footer help them float visually above
    // the data underneath.
    ".lt-sticky-groups{}" +
    ".lt-sticky-group{box-shadow:0 1px 2px rgba(15,23,42,0.08)}" +
    ".lt-sticky-grand-total{}" +
    ".lt-sticky-grand-total-row{box-shadow:0 -1px 2px rgba(15,23,42,0.08)}";

let _stylesInjected = new WeakSet();
function injectStyles(doc) {
    if (_stylesInjected.has(doc)) return;
    _stylesInjected.add(doc);
    const style = doc.createElement("style");
    style.setAttribute("data-lt", "core");
    style.textContent = DEFAULT_STYLES;
    doc.head.appendChild(style);
}

// Test hook.
/**
 * @internal
 * Reset the styles-injected WeakSet so tests can re-assert injection
 * behaviour from a clean slate. Not part of the public API.
 */
export function _resetStylesForTest() {
    _stylesInjected = new WeakSet();
}

// =============================================================================
// 5. DOM MOUNT
// =============================================================================

const DRAG_THRESHOLD_PX = 4;

/**
 * Render a {@link createTable} core into a host element. Wires up CSS Grid
 * layout, slot-pooled virtualization (constant DOM cost regardless of dataset
 * size), reactive cell bindings, header sort / drag-reorder / drag-resize,
 * pointer + keyboard handlers, and ARIA wiring (`role=grid`, `aria-rowcount`,
 * `aria-activedescendant`).
 *
 * **Lifecycle coupling**: `mount.dispose()` also calls `table.dispose()`.
 * One mount owns one table. To render the same data in two places, create
 * two tables sharing the same row source.
 *
 * @template Row
 * @param {HTMLElement} host
 *      Container element. The mount takes one child and lives there until
 *      `dispose()` removes it. Should have a non-zero `clientHeight` for
 *      virtualization to size the pool; defaults to `initialViewportHeight`
 *      while layout settles.
 * @param {object} table  TableCore from {@link createTable}.
 * @param {object} [options]
 * @param {boolean} [options.injectStyles=true]
 *      When false, the consumer is responsible for `.lt-*` CSS. The mount
 *      still applies inline `style.--lt-cols` and per-cell `grid-column`
 *      placements (which are required for the grid to lay out at all).
 * @param {number} [options.initialViewportHeight=480]
 *      Used to size the slot pool before the ResizeObserver fires.
 *
 * @returns {object} TableMount -- `{ root, viewport, axis, scrollToIndex, poolSize, dispose }`.
 * @throws {TypeError} If `host` or `table` is missing.
 *
 * @example
 *   const table = createTable({ ... });
 *   const m = mountTable(document.getElementById("grid"), table);
 *   m.scrollToIndex(500, "center");
 *   // ... later
 *   m.dispose();
 */
export function mountTable(host, table, options) {
    if (!host) throw new TypeError("lite-table: host element required");
    if (!table) throw new TypeError("lite-table: table required");
    options = options || {};
    const doc = host.ownerDocument;
    if (options.injectStyles !== false) injectStyles(doc);

    const {
        columns, rowHeight, overscan,
        visibleRows, rowCount, visibleColumns, displayIndexByKey, colPlacement,
        colTemplate, contentWidth, leftOffsets, rightOffsets,
        sortChain, focusedCell, selection,
        getRowId, cellId,
        toggleSort, selectRow, isSelected, moveFocus,
        setColumnWidth, moveColumn,
        // M2 surface
        columnFilters, setColumnFilter,
        editingCell, editingDraft, startEdit, commitEdit, cancelEdit,
        // M3 surface
        visibleEntries, entryCount, groupBy, collapsedGroups, groupedRows,
        toggleGroup, groupAncestryAt
    } = table;

    const { scope, dispose: disposeScope } = createScope();

    // ----- Root container (the focusable element) ---------------------------
    const root = doc.createElement("div");
    root.className = "lt-root";
    root.setAttribute("role", "grid");
    root.setAttribute("tabindex", "0");
    root.setAttribute("aria-multiselectable", "true");
    root.setAttribute("aria-colcount", String(columns.length));

    scope.effect(() => {
        root.setAttribute("aria-rowcount", String(rowCount() + 1));
    });

    // Reactive grid template (CSS var consumed by both header and rows).
    scope.effect(() => {
        root.style.setProperty("--lt-cols", colTemplate());
    });

    // ----- Header row -------------------------------------------------------
    const header = doc.createElement("div");
    header.className = "lt-header";
    header.setAttribute("role", "row");
    header.setAttribute("aria-rowindex", "1");

    // One header cell per declared column. Reorder + hide + pin update their
    // gridColumn / display / position reactively -- DOM nodes never change.
    const headerCells = new Map(); // key -> { el, labelEl, sortEl, resizeEl }
    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const cell = doc.createElement("div");
        cell.className = "lt-header-cell";
        cell.setAttribute("role", "columnheader");
        cell.setAttribute("aria-colindex", String(i + 1));
        cell.setAttribute("data-key", col.key);
        if (col.sortable) cell.classList.add("is-sortable");

        const labelEl = doc.createElement("span");
        labelEl.className = "lt-header-cell-label";
        labelEl.textContent = col.header;
        cell.appendChild(labelEl);

        const sortEl = doc.createElement("span");
        sortEl.className = "lt-header-sort";
        sortEl.setAttribute("aria-hidden", "true");
        cell.appendChild(sortEl);

        // Resize handle on the right edge.
        const resizeEl = doc.createElement("span");
        resizeEl.className = "lt-header-resize";
        resizeEl.setAttribute("aria-hidden", "true");
        if (col.resizable) cell.appendChild(resizeEl);

        header.appendChild(cell);
        headerCells.set(col.key, { el: cell, labelEl, sortEl, resizeEl, col });
    }
    root.appendChild(header);

    // ----- Filter row (M2) --------------------------------------------------
    // Only mounted if at least one declared column has filterable: true.
    // Sits between the header and the viewport in the DOM, uses the same
    // CSS Grid template (via --lt-cols inherited from root), and recycles
    // never -- one input per filterable column, hidden when the column is
    // hidden.
    const filterCells = new Map();   // key -> input element
    const hasAnyFilterable = columns.some((c) => c.filterable);
    let filterRow = null;
    if (hasAnyFilterable) {
        filterRow = doc.createElement("div");
        filterRow.className = "lt-filter-row";
        filterRow.setAttribute("role", "row");
        filterRow.setAttribute("aria-rowindex", "2");

        for (const col of columns) {
            const cell = doc.createElement("div");
            cell.className = "lt-filter-cell";
            cell.setAttribute("data-key", col.key);
            cell.setAttribute("data-pin", "none");

            if (col.filterable) {
                const input = doc.createElement("input");
                input.type = "text";
                input.className = "lt-filter-input";
                input.setAttribute("aria-label", "Filter " + col.header);
                if (col.filterPlaceholder) input.placeholder = col.filterPlaceholder;
                else input.placeholder = "Filter…";

                // Two-way binding. Outer source of truth is columnFilters; we
                // read it on every change and write into the input only if the
                // values diverged (so user typing doesn't get reset by their
                // own write echoing back). Likewise we write into the signal
                // from `input` events only when divergent.
                scope.effect(() => {
                    const cur = columnFilters().get(col.key) || "";
                    if (input.value !== cur) input.value = cur;
                });
                scope.on(input, "input", () => {
                    setColumnFilter(col.key, input.value);
                });
                // Escape clears just this column's filter.
                scope.on(input, "keydown", (ev) => {
                    if (ev.key === "Escape") {
                        ev.preventDefault();
                        setColumnFilter(col.key, "");
                    }
                });

                cell.appendChild(input);
                filterCells.set(col.key, input);
            }

            // Mirror grid placement, hide, and pin offsets from the column
            // state -- same logic as header cells. We reuse the column's
            // reactive placement so a hidden column drops its filter cell
            // too, and pinned columns keep their filter input sticky.
            scope.effect(() => {
                const placement = colPlacement().get(col.key);
                if (placement == null) {
                    cell.style.display = "none";
                } else {
                    cell.style.display = "";
                    cell.style.gridColumn = placement + " / span 1";
                }
            });
            scope.effect(() => {
                const pinSide = col.pin();
                cell.setAttribute("data-pin", pinSide);
                if (pinSide === "left") {
                    cell.style.left = (leftOffsets().get(col.key) || 0) + "px";
                    cell.style.right = "";
                } else if (pinSide === "right") {
                    cell.style.right = (rightOffsets().get(col.key) || 0) + "px";
                    cell.style.left = "";
                } else {
                    cell.style.left = "";
                    cell.style.right = "";
                }
            });

            filterRow.appendChild(cell);
        }

        root.appendChild(filterRow);
    }

    // Per-header reactive bindings: gridColumn, display, sticky pin, aria-sort.
    for (const col of columns) {
        const hc = headerCells.get(col.key);

        // gridColumn / display. colPlacement gives the 1-indexed
        // grid-column accounting for the 1fr filler between unpinned and
        // right-pinned columns.
        scope.effect(() => {
            const placement = colPlacement().get(col.key);
            if (placement == null) {
                hc.el.style.display = "none";
            } else {
                hc.el.style.display = "";
                hc.el.style.gridColumn = placement + " / span 1";
            }
        });

        // Pin: data-pin + left/right offsets.
        scope.effect(() => {
            const pinSide = col.pin();
            hc.el.setAttribute("data-pin", pinSide);
            if (pinSide === "left") {
                hc.el.style.left = (leftOffsets().get(col.key) || 0) + "px";
                hc.el.style.right = "";
            } else if (pinSide === "right") {
                hc.el.style.right = (rightOffsets().get(col.key) || 0) + "px";
                hc.el.style.left = "";
            } else {
                hc.el.style.left = "";
                hc.el.style.right = "";
            }
        });

        // aria-sort + visible sort indicator.
        scope.effect(() => {
            const chain = sortChain();
            const idx = chain.findIndex((e) => e.key === col.key);
            const entry = idx >= 0 ? chain[idx] : null;
            if (entry) {
                hc.el.setAttribute("aria-sort", entry.dir === "asc" ? "ascending" : "descending");
                // Show arrow + position in chain (e.g., "1\u25b2", "2\u25bc").
                const arrow = entry.dir === "asc" ? "\u25b2" : "\u25bc";
                hc.sortEl.textContent = (chain.length > 1 ? (idx + 1) + arrow : arrow);
            } else {
                hc.el.setAttribute("aria-sort", "none");
                hc.sortEl.textContent = "";
            }
        });

        // Click: sort. Shift-click: additive sort. Drag: reorder.
        // pointerdown -> capture potential drag; on pointerup we decide.
        if (col.sortable || col.reorderable) {
            attachHeaderInteraction(hc, col, scope, doc, {
                root, header, columnsByKey: new Map(columns.map(c => [c.key, c])),
                toggleSort, moveColumn, headerCells
            });
        }

        // Resize: pointerdown on resize handle starts a drag-to-resize.
        if (col.resizable) {
            attachResizeInteraction(hc, col, scope, doc, setColumnWidth);
        }
    }

    // ----- Viewport (scroll container) --------------------------------------
    // Header is INSIDE the viewport so horizontal scroll moves header + body
    // together (they share the same scroll context). Header still sticks to
    // the top via position:sticky.
    const viewport = doc.createElement("div");
    viewport.className = "lt-viewport";
    viewport.setAttribute("role", "presentation");

    // Move the header from root into viewport.
    root.removeChild(header);
    viewport.appendChild(header);

    const inner = doc.createElement("div");
    inner.className = "lt-inner";
    viewport.appendChild(inner);
    root.appendChild(viewport);

    host.appendChild(root);

    // Sizing of the scroll surface is now done entirely in CSS. Both `.lt-header`
    // and `.lt-inner` use `width: max-content; min-width: 100%` so the grid
    // container's intrinsic width is the natural width of its tracks, and it
    // stretches to viewport when the viewport is wider so flex columns can
    // absorb leftover space. The earlier JS effect that set
    // `style.minWidth = contentWidth() + "px"` was fragile: it could force a
    // width that disagreed with what the grid template actually distributed
    // (e.g. when a flex column's minWidth floor exceeded its share of fr),
    // which in Chrome could push cells into a second implicit row.

    // ----- Virtual axis -----------------------------------------------------
    const initialVH = viewport.clientHeight ||
        options.initialViewportHeight || 480;

    const axis = virtualAxis({
        count: rowCount.peek(),
        itemSize: rowHeight,
        viewport: initialVH,
        overscan
    });

    // The virtual axis reserves scroll height for EVERY visible entry --
    // data rows AND group-header + grand-total rows all take rowHeight.
    // rowCount (data-only) is exposed on the core for consumer stats but
    // never drives the axis, or headers would overlap the last data row.
    scope.effect(() => { axis.setCount(entryCount()); });
    scope.effect(() => { inner.style.height = axis.totalSize() + "px"; });

    // ----- Slot pool --------------------------------------------------------
    const poolSize = scope.signal(
        Math.ceil(initialVH / rowHeight) + overscan * 2 + 1
    );

    const slots = [];

    // Reactive: which column is currently first-in-display-order. Group
    // headers put their chevron + label + count in this column's cell;
    // the aggregate values go into the rest. Recomputes on show/hide/
    // reorder -- so a hidden first column bumps the label into the next.
    const firstVisibleColKey = scope.computed(() => {
        const cols = visibleColumns();
        return cols.length > 0 ? cols[0].key : null;
    });

    // Chevron glyphs -- ASCII-adjacent Unicode that renders reliably
    // across system fonts without a webfont dependency.
    const CHEVRON_EXPANDED = "\u25BC";  // ▼
    const CHEVRON_COLLAPSED = "\u25B6"; // ▶

    // Format an aggregate value for display. Uses the column's
    // `aggregateFormat` if provided, otherwise falls back to String().
    // Null aggregates render as empty (they mean "no values to aggregate").
    function _formatAggregate(entry, col) {
        if (!entry.aggregates) return "";
        const v = entry.aggregates.get(col.key);
        if (v == null) return "";
        if (col.aggregateFormat) {
            try { return col.aggregateFormat(v, col, entry.count); }
            catch (err) {
                try { console.error("lite-table: aggregateFormat threw:", err); } catch (_) {}
                return String(v);
            }
        }
        return String(v);
    }

    function buildSlot(poolIdx) {
        const rowEl = doc.createElement("div");
        rowEl.className = "lt-row";
        rowEl.setAttribute("role", "row");

        const slotIndex = scope.computed(() => axis.start() + poolIdx);

        // The one source of truth for what this pool slot renders. Reads
        // visibleEntries() so it dispatches on entry.type (data /
        // group-header / grand-total). All row-level and cell-level
        // effects below read slotEntry rather than visibleRows/visibleEntries
        // directly -- keeps every effect down to a single-signal read.
        const slotEntry = scope.computed(() => {
            const es = visibleEntries();
            const i = slotIndex();
            if (i < 0 || i >= es.length) return null;
            return es[i];
        });

        // Position (translateY) -- single transform write per boundary cross.
        scope.effect(() => {
            const i = slotIndex();
            rowEl.style.transform = "translateY(" + (i * rowHeight) + "px)";
        });

        // Visibility & aria-rowindex driven by entryCount so out-of-bounds
        // slots hide immediately (e.g. after collapsing a big group).
        scope.effect(() => {
            const i = slotIndex();
            const n = entryCount();
            if (i < 0 || i >= n) {
                rowEl.style.display = "none";
                rowEl.removeAttribute("aria-rowindex");
            } else {
                rowEl.style.display = "";
                rowEl.setAttribute("aria-rowindex", String(i + 2));
            }
        });

        // Row-type discriminator: group-header + grand-total get their own
        // classes and data-attributes. Data rows keep the base .lt-row plus
        // alt striping. `data-depth` on headers lets the stylesheet indent
        // per depth without JS style writes.
        scope.effect(() => {
            const entry = slotEntry();
            rowEl.classList.remove("lt-row-group-header", "lt-row-grand-total");
            if (entry === null) {
                rowEl.removeAttribute("data-depth");
                rowEl.removeAttribute("data-collapsed");
                return;
            }
            if (entry.type === "group-header") {
                rowEl.classList.add("lt-row-group-header");
                rowEl.setAttribute("data-depth", String(entry.depth));
                rowEl.setAttribute("data-collapsed", entry.isCollapsed ? "true" : "false");
            } else if (entry.type === "grand-total") {
                rowEl.classList.add("lt-row-grand-total");
                rowEl.removeAttribute("data-depth");
                rowEl.removeAttribute("data-collapsed");
            } else {
                rowEl.removeAttribute("data-depth");
                rowEl.removeAttribute("data-collapsed");
            }
        });

        // Alt striping -- data rows only, tied to slotIndex parity of the
        // data row's ORDINAL POSITION would be ideal, but computing that
        // requires another walk. Using slotIndex parity (entry position)
        // gives visually consistent striping across data rows even when
        // interrupted by group headers -- it just resets at each header.
        scope.effect(() => {
            const entry = slotEntry();
            const i = slotIndex();
            const isDataAlt = entry !== null && entry.type === "data" && (i & 1);
            if (isDataAlt) rowEl.classList.add("lt-row-alt");
            else rowEl.classList.remove("lt-row-alt");
        });

        // Selection highlight -- data rows only. Group headers and grand
        // total never appear "selected"; clicking them toggles the group
        // or does nothing rather than adding to selection.
        scope.onCleanup(bindClass(rowEl, "is-selected", () => {
            const entry = slotEntry();
            if (entry === null || entry.type !== "data") return false;
            return isSelected(getRowId(entry.row));
        }));

        scope.onCleanup(bindAttr(rowEl, "aria-selected", () => {
            const entry = slotEntry();
            if (entry === null || entry.type !== "data") return null;
            return isSelected(getRowId(entry.row)) ? "true" : "false";
        }));

        // ----- Cells (one per declared column, in DOM config order) ---------
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const cellEl = doc.createElement("div");
            cellEl.className = "lt-cell";
            cellEl.setAttribute("role", "gridcell");
            cellEl.setAttribute("aria-colindex", String(c + 1));
            cellEl.setAttribute("data-key", col.key);

            // Reactive grid placement / hide.
            scope.effect(() => {
                const placement = colPlacement().get(col.key);
                if (placement == null) {
                    cellEl.style.display = "none";
                } else {
                    cellEl.style.display = "";
                    cellEl.style.gridColumn = placement + " / span 1";
                }
            });

            // Reactive pin (sticky + offset).
            scope.effect(() => {
                const pinSide = col.pin();
                cellEl.setAttribute("data-pin", pinSide);
                if (pinSide === "left") {
                    cellEl.style.left = (leftOffsets().get(col.key) || 0) + "px";
                    cellEl.style.right = "";
                } else if (pinSide === "right") {
                    cellEl.style.right = (rightOffsets().get(col.key) || 0) + "px";
                    cellEl.style.left = "";
                } else {
                    cellEl.style.left = "";
                    cellEl.style.right = "";
                }
            });

            // Reactive text -- dispatches on entry.type. Manual effect (not
            // bindText) so the editing gate can skip the write when this
            // cell is the active edit target.
            scope.effect(() => {
                const entry = slotEntry();
                if (entry === null) {
                    if (cellEl.textContent !== "") cellEl.textContent = "";
                    return;
                }

                if (entry.type === "data") {
                    // Editing gate: suspend text writes while the user is
                    // typing in this cell -- the contenteditable IS the
                    // source of truth until commitEdit runs. The effect
                    // still tracks editingCell so it resumes cleanly.
                    if (col.editable) {
                        const e = editingCell();
                        if (e !== null && e.rowId === getRowId(entry.row) && e.columnKey === col.key) {
                            return;
                        }
                    }
                    const v = readCell(col, entry.row);
                    const text = v == null ? "" : String(v);
                    if (cellEl.textContent !== text) cellEl.textContent = text;
                    return;
                }

                if (entry.type === "group-header") {
                    // First visible column holds the chevron + label.
                    // (Reads firstVisibleColKey reactively -- column
                    // hide/reorder repaints the affected cells.)
                    if (firstVisibleColKey() === col.key) {
                        const chevron = entry.isCollapsed ? CHEVRON_COLLAPSED : CHEVRON_EXPANDED;
                        const label = entry.value == null ? "(none)" : String(entry.value);
                        const text = chevron + "  " + label + "  (" + entry.count + ")";
                        if (cellEl.textContent !== text) cellEl.textContent = text;
                    } else {
                        const text = _formatAggregate(entry, col);
                        if (cellEl.textContent !== text) cellEl.textContent = text;
                    }
                    return;
                }

                if (entry.type === "grand-total") {
                    if (firstVisibleColKey() === col.key) {
                        const text = "Total (" + entry.count + ")";
                        if (cellEl.textContent !== text) cellEl.textContent = text;
                    } else {
                        const text = _formatAggregate(entry, col);
                        if (cellEl.textContent !== text) cellEl.textContent = text;
                    }
                    return;
                }
            });

            // Reactive id (the aria-activedescendant target). Only data
            // cells get an id -- headers / totals have no rowId.
            scope.onCleanup(bindAttr(cellEl, "id", () => {
                const entry = slotEntry();
                if (entry === null || entry.type !== "data") return null;
                return cellId(getRowId(entry.row), col.key);
            }));

            // Focus indicator. Same restriction -- only data cells can be
            // focused via the keyboard grid.
            scope.onCleanup(bindClass(cellEl, "is-focused", () => {
                const entry = slotEntry();
                if (entry === null || entry.type !== "data") return false;
                const f = focusedCell();
                if (!f) return false;
                return getRowId(entry.row) === f.rowId && col.key === f.columnKey;
            }));

            // Editable machinery is gated on data rows: group-header cells
            // are visually plain even for editable columns.
            if (col.editable) {
                cellEl.setAttribute("data-editable", "true");

                // Editing state painted as data + class + contenteditable.
                scope.effect(() => {
                    const entry = slotEntry();
                    if (entry === null || entry.type !== "data") {
                        cellEl.removeAttribute("contenteditable");
                        cellEl.classList.remove("is-editing");
                        return;
                    }
                    const row = entry.row;
                    const e = editingCell();
                    const editingThis = e !== null && e.rowId === getRowId(row) && e.columnKey === col.key;
                    if (editingThis) {
                        if (cellEl.getAttribute("contenteditable") !== "true") {
                            cellEl.setAttribute("contenteditable", "true");
                            const seed = editingDraft.peek();
                            if (cellEl.textContent !== seed) cellEl.textContent = seed;
                            queueMicrotask(() => {
                                if (cellEl.getAttribute("contenteditable") === "true") {
                                    cellEl.focus();
                                    const sel = doc.getSelection ? doc.getSelection() : null;
                                    if (sel) {
                                        const range = doc.createRange();
                                        range.selectNodeContents(cellEl);
                                        sel.removeAllRanges();
                                        sel.addRange(range);
                                    }
                                }
                            });
                        }
                        cellEl.classList.add("is-editing");
                    } else {
                        if (cellEl.hasAttribute("contenteditable")) {
                            cellEl.removeAttribute("contenteditable");
                        }
                        cellEl.classList.remove("is-editing");
                    }
                });

                scope.on(cellEl, "input", () => {
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    editingDraft.set(cellEl.textContent || "");
                });

                scope.on(cellEl, "keydown", (ev) => {
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    if (ev.key === "Escape") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        cancelEdit();
                        root.focus();
                    } else if (ev.key === "Enter" && !ev.shiftKey) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commitEdit();
                        root.focus();
                        moveFocus("down");
                    } else if (ev.key === "Tab") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commitEdit();
                        root.focus();
                        moveFocus(ev.shiftKey ? "left" : "right");
                    }
                });

                scope.on(cellEl, "blur", () => {
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    commitEdit();
                });

                scope.on(cellEl, "dblclick", (ev) => {
                    const entry = slotEntry.peek();
                    if (entry === null || entry.type !== "data") return;
                    ev.preventDefault();
                    startEdit(getRowId(entry.row), col.key);
                });
            }

            rowEl.appendChild(cellEl);
        }

        inner.appendChild(rowEl);
        return rowEl;
    }

    for (let i = 0; i < poolSize.peek(); i++) slots.push(buildSlot(i));

    scope.effect(() => {
        const want = poolSize();
        while (slots.length < want) slots.push(buildSlot(slots.length));
    });

    // ----- Sticky group-header + grand-total overlays -----------------------
    // Both are `position: sticky` zero-height containers that live as
    // DIRECT CHILDREN OF `.lt-viewport`:
    //     .lt-sticky-groups         -- inserted BEFORE .lt-inner
    //     .lt-sticky-grand-total    -- appended AFTER .lt-inner
    // This matters because `position: sticky` is relative to the element's
    // natural flow position. Putting them inside .lt-inner (where the pool
    // slots live absolute) would give both containers a natural position
    // of 0 -- fine for `top: 32`, WRONG for `bottom: 0` (that only kicks
    // in when the natural position is BELOW viewport bottom, so a footer
    // at flow-top just... sits at the top). Placing them around .lt-inner
    // -- whose height reflects the scrollable content -- gives each the
    // natural position that matches the sticky edge it's aiming for.
    //
    // Design invariants:
    //   - Sticky headers show the ANCESTORS of visibleEntries[axis.start()].
    //     If the top-visible entry is itself a group header, its own row is
    //     drawn by the pool at translateY(start * rowHeight); sticky shows
    //     only strictly-shallower ancestors, which is [] for a depth-0
    //     header. No duplication.
    //   - Sticky grand-total mirrors the last entry's aggregates. When the
    //     inline grand-total row is scrolled into view, the sticky row sits
    //     on top of it -- same content, no visible difference.
    //   - Both are hidden when their prerequisites aren't met (no grouping,
    //     no grand total configured). Neither injects DOM or effects into
    //     the ungrouped fast path beyond the two guarding effects.

    // Local lookup so sticky effects don't have to walk `columns` linearly.
    const _mountColumnsByKey = new Map(columns.map(c => [c.key, c]));

    // Sticky group-headers: BEFORE .lt-inner in the viewport's flow, sticks
    // at viewport top:<headerHeight> so it clears the sticky column header
    // (which itself sits at top:0). We use rowHeight for the header height
    // since that matches the padding+content of `.lt-header-cell` -- if a
    // consumer restyles the header taller, they'll want a bigger offset.
    const stickyGroupsEl = doc.createElement("div");
    stickyGroupsEl.className = "lt-sticky-groups";
    stickyGroupsEl.setAttribute("aria-hidden", "true");
    stickyGroupsEl.style.cssText =
        "position:sticky;top:" + rowHeight + "px;" +
        "left:0;right:0;height:0;z-index:2;pointer-events:none;";
    viewport.insertBefore(stickyGroupsEl, inner);

    const _stickyRows = [];
    function _buildStickyRow(depth) {
        const rowEl = doc.createElement("div");
        // NOTE: no `.lt-row` on sticky rows -- the base class is used by
        // the 1.1.0 test suite (and by consumers) to count pool slots via
        // `querySelectorAll(".lt-row")`. Sticky rows carry only their
        // discriminator classes; the grid layout that `.lt-row` provides
        // is inlined below (display:grid + grid-template-columns).
        rowEl.className = "lt-row-group-header lt-sticky-group";
        rowEl.setAttribute("data-depth", String(depth));
        rowEl.style.cssText =
            "position:absolute;left:0;right:0;" +
            "top:" + (depth * rowHeight) + "px;" +
            "height:" + rowHeight + "px;" +
            "display:grid;grid-template-columns:var(--lt-cols);" +
            "width:max-content;min-width:100%;" +
            "pointer-events:auto;";
        const cells = new Map();
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const cellEl = doc.createElement("div");
            cellEl.className = "lt-cell";
            cellEl.setAttribute("data-key", col.key);
            // Reactive per-cell grid placement + pin, matching pool cells so
            // sticky rows track column reorder / hide / pin the same way.
            scope.effect(() => {
                const placement = colPlacement().get(col.key);
                if (placement == null) {
                    cellEl.style.display = "none";
                } else {
                    cellEl.style.display = "";
                    cellEl.style.gridColumn = placement + " / span 1";
                }
            });
            scope.effect(() => {
                const pinSide = col.pin();
                cellEl.setAttribute("data-pin", pinSide);
                if (pinSide === "left") {
                    cellEl.style.left = (leftOffsets().get(col.key) || 0) + "px";
                    cellEl.style.right = "";
                } else if (pinSide === "right") {
                    cellEl.style.right = (rightOffsets().get(col.key) || 0) + "px";
                    cellEl.style.left = "";
                } else {
                    cellEl.style.left = "";
                    cellEl.style.right = "";
                }
            });
            rowEl.appendChild(cellEl);
            cells.set(col.key, cellEl);
        }
        // Toggle the group by clicking anywhere on the sticky row. Reads the
        // closure-captured info.currentEntry so we always toggle the group
        // the row is currently showing, not the one it was built for.
        const info = { row: rowEl, cells, currentEntry: null };
        scope.on(rowEl, "pointerdown", (ev) => {
            if (!ev.isPrimary || ev.button !== 0) return;
            if (info.currentEntry) toggleGroup(info.currentEntry.path);
        });
        return info;
    }

    // Reactive sync: watch axis.start() + visibleEntries + column changes.
    // Emits/hides sticky rows to match `groupAncestryAt(axis.start())`.
    scope.effect(() => {
        // Ungrouped fast path: hide everything and skip.
        if (groupBy().length === 0) {
            stickyGroupsEl.style.display = "none";
            for (let i = 0; i < _stickyRows.length; i++) {
                _stickyRows[i].row.style.display = "none";
                _stickyRows[i].currentEntry = null;
            }
            return;
        }
        stickyGroupsEl.style.display = "";
        // Read the FIRST-VISIBLE entry index (no overscan). axis.start()
        // includes overscan slots above the viewport, so it would show
        // ancestors of a not-yet-visible entry -- sticky "active" while
        // the user is already scrolling through "archived" data. Using
        // firstIndex keeps sticky in lockstep with what's under the
        // column header line.
        const ancestors = groupAncestryAt(axis.firstIndex());
        // Grow the pool of sticky rows to match the current depth.
        while (_stickyRows.length < ancestors.length) {
            const info = _buildStickyRow(_stickyRows.length);
            stickyGroupsEl.appendChild(info.row);
            _stickyRows.push(info);
        }
        // Populate visible slots + hide the rest.
        const firstKey = firstVisibleColKey();
        for (let d = 0; d < _stickyRows.length; d++) {
            const info = _stickyRows[d];
            const a = ancestors[d];
            if (a) {
                info.currentEntry = a;
                info.row.style.display = "grid";
                info.row.setAttribute("data-collapsed", a.isCollapsed ? "true" : "false");
                for (const [colKey, cellEl] of info.cells) {
                    const col = _mountColumnsByKey.get(colKey);
                    if (!col) continue;
                    let text;
                    if (firstKey === colKey) {
                        const chevron = a.isCollapsed ? CHEVRON_COLLAPSED : CHEVRON_EXPANDED;
                        const label = a.value == null ? "(none)" : String(a.value);
                        text = chevron + "  " + label + "  (" + a.count + ")";
                    } else {
                        text = _formatAggregate(a, col);
                    }
                    if (cellEl.textContent !== text) cellEl.textContent = text;
                }
            } else {
                info.currentEntry = null;
                info.row.style.display = "none";
            }
        }
    });

    // Sticky grand-total footer: AFTER .lt-inner in the viewport's flow, so
    // its natural flow position is at end-of-scroll -- exactly the trigger
    // condition for `position: sticky; bottom: 0` to pin it at viewport
    // bottom. When the user scrolls to the very end and the actual last
    // entry (grand-total, at index entryCount-1) is drawn by the pool at
    // the same visual y position, the two overlap seamlessly with matching
    // content (same _formatAggregate call at both sites).
    const stickyGrandTotalEl = doc.createElement("div");
    stickyGrandTotalEl.className = "lt-sticky-grand-total";
    stickyGrandTotalEl.setAttribute("aria-hidden", "true");
    stickyGrandTotalEl.style.cssText =
        "position:sticky;bottom:0;left:0;right:0;height:0;z-index:2;pointer-events:none;";
    viewport.appendChild(stickyGrandTotalEl);

    const stickyGrandTotalRow = doc.createElement("div");
    // See `_buildStickyRow` note: no `.lt-row` on sticky rows so pool-slot
    // counters (querySelectorAll(".lt-row")) aren't inflated.
    stickyGrandTotalRow.className = "lt-row-grand-total lt-sticky-grand-total-row";
    // Position ABOVE the (height:0) sticky container: `top: -rowHeight` puts
    // the row's top edge one rowHeight ABOVE the container, so the row's
    // bottom edge coincides with the container's top -- which is glued to
    // viewport bottom by the sticky rule on the container. This is more
    // robust than `bottom: 0` inside a height:0 containing block, where
    // some browsers resolve "0 from bottom of a 0-height box" as "at the
    // container's top" (which puts the row BELOW the viewport).
    stickyGrandTotalRow.style.cssText =
        "position:absolute;left:0;right:0;" +
        "top:-" + rowHeight + "px;" +
        "height:" + rowHeight + "px;" +
        "display:grid;grid-template-columns:var(--lt-cols);" +
        "width:max-content;min-width:100%;" +
        "pointer-events:auto;";
    const _stickyGtCells = new Map();
    for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const cellEl = doc.createElement("div");
        cellEl.className = "lt-cell";
        cellEl.setAttribute("data-key", col.key);
        scope.effect(() => {
            const placement = colPlacement().get(col.key);
            if (placement == null) {
                cellEl.style.display = "none";
            } else {
                cellEl.style.display = "";
                cellEl.style.gridColumn = placement + " / span 1";
            }
        });
        scope.effect(() => {
            const pinSide = col.pin();
            cellEl.setAttribute("data-pin", pinSide);
            if (pinSide === "left") {
                cellEl.style.left = (leftOffsets().get(col.key) || 0) + "px";
                cellEl.style.right = "";
            } else if (pinSide === "right") {
                cellEl.style.right = (rightOffsets().get(col.key) || 0) + "px";
                cellEl.style.left = "";
            } else {
                cellEl.style.left = "";
                cellEl.style.right = "";
            }
        });
        stickyGrandTotalRow.appendChild(cellEl);
        _stickyGtCells.set(col.key, cellEl);
    }
    stickyGrandTotalEl.appendChild(stickyGrandTotalRow);

    scope.effect(() => {
        const entries = visibleEntries();
        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        if (!last || last.type !== "grand-total") {
            stickyGrandTotalEl.style.display = "none";
            return;
        }
        stickyGrandTotalEl.style.display = "";
        const firstKey = firstVisibleColKey();
        for (const [colKey, cellEl] of _stickyGtCells) {
            const col = _mountColumnsByKey.get(colKey);
            if (!col) continue;
            let text;
            if (firstKey === colKey) {
                text = "Total (" + last.count + ")";
            } else {
                text = _formatAggregate(last, col);
            }
            if (cellEl.textContent !== text) cellEl.textContent = text;
        }
    });

    // ----- Delegated pointerdown on root ------------------------------------
    // One listener instead of pool-size x columns. We use closest('.lt-cell')
    // to find the tapped cell, read its data-key for the column, and find the
    // row's slot position via slots.indexOf -- O(poolSize) lookup, which is
    // bounded by viewport.
    scope.on(root, "pointerdown", (ev) => {
        if (!ev.isPrimary || ev.button !== 0) return;
        const cell = ev.target.closest && ev.target.closest(".lt-cell");
        if (!cell) return;
        const colKey = cell.getAttribute("data-key");
        if (!colKey) return;
        const rowEl = cell.closest(".lt-row");
        if (!rowEl) return;
        const poolIdx = slots.indexOf(rowEl);
        if (poolIdx < 0) return;
        const slotIdx = untrack(() => axis.start()) + poolIdx;
        const es = untrack(() => visibleEntries());
        if (slotIdx < 0 || slotIdx >= es.length) return;
        const entry = es[slotIdx];
        if (entry == null) return;

        // Group-header rows are toggles, not selections. Any click on the
        // header collapses/expands its subtree -- we don't wire this to
        // just the chevron because a bigger hit target is friendlier on
        // touch, and there's nothing else meaningful to do with a
        // header-row click. Selection + focus stay untouched.
        if (entry.type === "group-header") {
            toggleGroup(entry.path);
            return;
        }
        // Grand-total row is decorative -- ignore clicks entirely so it
        // doesn't clear the current selection when the user taps it.
        if (entry.type === "grand-total") return;

        const row = entry.row;
        if (row == null) return;
        const rowId = getRowId(row);
        if (ev.shiftKey) selectRow(rowId, "range");
        else if (ev.ctrlKey || ev.metaKey) selectRow(rowId, "toggle");
        else selectRow(rowId, "set");
        focusedCell.set({ rowId, columnKey: colKey });
    });

    // ----- aria-activedescendant --------------------------------------------
    scope.effect(() => {
        const f = focusedCell();
        if (!f) { root.removeAttribute("aria-activedescendant"); return; }
        root.setAttribute("aria-activedescendant", cellId(f.rowId, f.columnKey));
    });

    // ----- Scroll wiring ----------------------------------------------------
    scope.on(viewport, "scroll", () => {
        axis.setScroll(viewport.scrollTop);
    }, { passive: true });

    // ----- ResizeObserver ---------------------------------------------------
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
            const h = viewport.clientHeight;
            if (h > 0) {
                axis.setViewport(h);
                const want = Math.ceil(h / rowHeight) + overscan * 2 + 1;
                if (want > poolSize.peek()) poolSize.set(want);
            }
        });
        ro.observe(viewport);
        scope.onCleanup(() => ro.disconnect());
    }

    // ----- Auto-scroll focused row into view --------------------------------
    // When focus moves via keyboard, scroll the focused row into view.
    scope.effect(() => {
        const f = focusedCell();
        if (!f) return;
        const list = untrack(() => visibleRows());
        let rIdx = -1;
        for (let i = 0; i < list.length; i++) {
            if (getRowId(list[i]) === f.rowId) { rIdx = i; break; }
        }
        if (rIdx < 0) return;
        const top = rIdx * rowHeight;
        const bottom = top + rowHeight;
        const sTop = viewport.scrollTop;
        const sBot = sTop + viewport.clientHeight;
        if (top < sTop) {
            viewport.scrollTop = top;
            axis.setScroll(top);
        } else if (bottom > sBot) {
            const next = bottom - viewport.clientHeight;
            viewport.scrollTop = next;
            axis.setScroll(next);
        }
    });

    // ----- Keyboard navigation ---------------------------------------------
    const viewportPageSize = () =>
        Math.max(1, Math.floor((viewport.clientHeight || initialVH) / rowHeight));

    scope.on(root, "keydown", (ev) => {
        // Only handle when focus is actually on root (not delegated to a child
        // editable element, etc.).
        if (ev.target !== root) return;
        let handled = true;
        const opts = { pageSize: viewportPageSize() };
        const ctrl = ev.ctrlKey || ev.metaKey;
        switch (ev.key) {
            case "ArrowUp":    moveFocus("up", opts); break;
            case "ArrowDown":  moveFocus("down", opts); break;
            case "ArrowLeft":  moveFocus("left", opts); break;
            case "ArrowRight": moveFocus("right", opts); break;
            case "Home":
                if (ctrl) moveFocus("rowStart", opts);
                else      moveFocus("home", opts);
                break;
            case "End":
                if (ctrl) moveFocus("rowEnd", opts);
                else      moveFocus("end", opts);
                break;
            case "PageUp":     moveFocus("pageUp", opts); break;
            case "PageDown":   moveFocus("pageDown", opts); break;
            case " ": {
                const f = focusedCell.peek();
                if (f) {
                    selectRow(f.rowId, ev.ctrlKey || ev.metaKey ? "toggle" : "set");
                }
                break;
            }
            case "Escape":
                table.clearSelection();
                break;
            case "a":
            case "A":
                if (ctrl) { table.selectAll(); }
                else handled = false;
                break;
            // M2: F2 and Enter (no modifiers) on the focused cell start
            // editing if the column is editable. Matches the spreadsheet
            // convention -- F2 universally, Enter as a convenience.
            case "F2":
            case "Enter": {
                if (ev.shiftKey || ctrl) { handled = false; break; }
                const f = focusedCell.peek();
                if (!f) { handled = false; break; }
                const col = columns.find((c) => c.key === f.columnKey);
                if (col && col.editable) {
                    startEdit(f.rowId, f.columnKey);
                } else {
                    handled = false;
                }
                break;
            }
            default:
                handled = false;
        }
        if (handled) ev.preventDefault();
    });

    return {
        root,
        viewport,
        axis,
        scrollToIndex(index, align) {
            const px = axis.offsetForIndex(index, align);
            viewport.scrollTop = px;
            axis.setScroll(px);
        },
        poolSize() { return slots.length; },
        dispose() {
            disposeScope();
            if (table.dispose) table.dispose();
            if (root.parentNode) root.parentNode.removeChild(root);
        }
    };
}

// =============================================================================
// 6. HEADER INTERACTIONS (sort click vs reorder drag)
// =============================================================================

/**
 * Attach pointerdown on a header cell that distinguishes click-to-sort from
 * drag-to-reorder by movement threshold.
 */
function attachHeaderInteraction(hc, col, scope, doc, ctx) {
    const { root, header, toggleSort, moveColumn, headerCells } = ctx;

    scope.onCleanup(bindOn(hc.el, "pointerdown", (ev) => {
        if (!ev.isPrimary || ev.button !== 0) return;
        // Resize handle takes precedence: skip if the target is the handle.
        if (ev.target === hc.resizeEl) return;

        const startX = ev.clientX;
        const startY = ev.clientY;
        let dragging = false;
        let lastDropTarget = null;
        let lastDropBefore = true;

        const onMove = (e) => {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!dragging) {
                if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
                if (!col.reorderable) return;
                dragging = true;
                hc.el.classList.add("is-dragging");
                // Mark the whole root so every cursor (including the body
                // cells the user might pass over) shows grabbing. Without
                // this the cursor goes back to default the moment the
                // pointer leaves the dragged header cell.
                root.classList.add("is-dragging-column");
                try { hc.el.setPointerCapture(e.pointerId); } catch (_) {}
            }
            // Find the header cell under the pointer (excluding self).
            const hover = doc.elementFromPoint(e.clientX, e.clientY);
            let candidate = hover;
            while (candidate && !(candidate.classList && candidate.classList.contains("lt-header-cell"))) {
                candidate = candidate.parentElement;
            }
            clearDropIndicators(headerCells);
            if (!candidate || candidate === hc.el) {
                lastDropTarget = null;
                return;
            }
            const rect = candidate.getBoundingClientRect();
            const before = e.clientX < rect.left + rect.width / 2;
            candidate.classList.add(before ? "is-drop-before" : "is-drop-after");
            lastDropTarget = candidate.getAttribute("data-key");
            lastDropBefore = before;
        };
        const onUp = (e) => {
            doc.removeEventListener("pointermove", onMove);
            doc.removeEventListener("pointerup", onUp);
            doc.removeEventListener("pointercancel", onUp);
            try { hc.el.releasePointerCapture(e.pointerId); } catch (_) {}
            if (dragging) {
                hc.el.classList.remove("is-dragging");
                root.classList.remove("is-dragging-column");
                clearDropIndicators(headerCells);
                if (lastDropTarget) {
                    moveColumn(col.key, lastDropTarget, { before: lastDropBefore });
                }
            } else {
                // Treat as click: sort.
                if (col.sortable) toggleSort(col.key, { additive: ev.shiftKey });
            }
        };
        doc.addEventListener("pointermove", onMove);
        doc.addEventListener("pointerup", onUp);
        doc.addEventListener("pointercancel", onUp);
    }));
}

function clearDropIndicators(headerCells) {
    for (const { el } of headerCells.values()) {
        el.classList.remove("is-drop-before");
        el.classList.remove("is-drop-after");
    }
}

// =============================================================================
// 7. RESIZE INTERACTION
// =============================================================================

function attachResizeInteraction(hc, col, scope, doc, setColumnWidth) {
    scope.onCleanup(bindOn(hc.resizeEl, "pointerdown", (ev) => {
        if (!ev.isPrimary || ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        const startX = ev.clientX;
        const startW = col.width.peek();
        hc.resizeEl.classList.add("is-active");
        try { hc.resizeEl.setPointerCapture(ev.pointerId); } catch (_) {}
        const onMove = (e) => {
            setColumnWidth(col.key, startW + (e.clientX - startX));
        };
        const onUp = (e) => {
            doc.removeEventListener("pointermove", onMove);
            doc.removeEventListener("pointerup", onUp);
            doc.removeEventListener("pointercancel", onUp);
            try { hc.resizeEl.releasePointerCapture(e.pointerId); } catch (_) {}
            hc.resizeEl.classList.remove("is-active");
        };
        doc.addEventListener("pointermove", onMove);
        doc.addEventListener("pointerup", onUp);
        doc.addEventListener("pointercancel", onUp);
    }));
}

// =============================================================================
// 8. TYPEDEFS (JSDoc; canonical types in Table.d.ts)
// =============================================================================

/**
 * @typedef {object} ColumnDef
 * @property {string} key
 * @property {string} [header]
 * @property {number} [width]
 * @property {number} [minWidth]
 * @property {number} [maxWidth]
 * @property {boolean} [hidden]
 * @property {"left"|"none"|"right"} [pin]
 * @property {boolean} [sortable]
 * @property {boolean} [resizable]
 * @property {boolean} [pinnable]
 * @property {boolean} [hideable]
 * @property {boolean} [reorderable]
 * @property {(row: any) => any} [accessor]
 * @property {(a: any, b: any) => number} [compare]
 */
