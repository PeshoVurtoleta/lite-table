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

    const visibleRows = scope.computed(() => {
        const src = filteredRows();
        const chain = sortChain();
        if (!chain.length) return src;
        const n = src.length;

        if (!_sortIdxBuf || _sortIdxBuf.length < n) {
            // Grow factor of 2 to amortize reallocation.
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

        // Single output allocation: an array of N row references (not row copies).
        // Returning a fresh array each time preserves Object.is inequality so
        // downstream computeds re-evaluate. Reusing this array across calls
        // would silently break consumers that hold the prior reference.
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = src[view[i]];
        return out;
    });

    const rowCount = scope.computed(() => visibleRows().length);

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
    ".lt-filter-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px #dbeafe}";

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
        editingCell, editingDraft, startEdit, commitEdit, cancelEdit
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

    scope.effect(() => { axis.setCount(rowCount()); });
    scope.effect(() => { inner.style.height = axis.totalSize() + "px"; });

    // ----- Slot pool --------------------------------------------------------
    const poolSize = scope.signal(
        Math.ceil(initialVH / rowHeight) + overscan * 2 + 1
    );

    const slots = [];

    function buildSlot(poolIdx) {
        const rowEl = doc.createElement("div");
        rowEl.className = "lt-row";
        rowEl.setAttribute("role", "row");

        const slotIndex = scope.computed(() => axis.start() + poolIdx);

        // Position (translateY) -- single transform write per boundary cross.
        scope.effect(() => {
            const i = slotIndex();
            rowEl.style.transform = "translateY(" + (i * rowHeight) + "px)";
        });

        // Visibility & aria-rowindex.
        scope.effect(() => {
            const i = slotIndex();
            const n = rowCount();
            if (i < 0 || i >= n) {
                rowEl.style.display = "none";
                rowEl.removeAttribute("aria-rowindex");
            } else {
                rowEl.style.display = "";
                rowEl.setAttribute("aria-rowindex", String(i + 2));
            }
        });

        // Alt striping.
        scope.effect(() => {
            const i = slotIndex();
            if (i & 1) rowEl.classList.add("lt-row-alt");
            else rowEl.classList.remove("lt-row-alt");
        });

        // Selection highlight: bindClass calls isSelected (the predicate),
        // which transparently handles both whitelist and all-mode selection.
        scope.onCleanup(bindClass(rowEl, "is-selected", () => {
            const i = slotIndex();
            const rs = visibleRows();
            if (i < 0 || i >= rs.length) return false;
            return isSelected(getRowId(rs[i]));
        }));

        // aria-selected on the row.
        scope.onCleanup(bindAttr(rowEl, "aria-selected", () => {
            const i = slotIndex();
            const rs = visibleRows();
            if (i < 0 || i >= rs.length) return null;
            return isSelected(getRowId(rs[i])) ? "true" : "false";
        }));

        // ----- Cells (one per declared column, in DOM config order) ---------
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const cellEl = doc.createElement("div");
            cellEl.className = "lt-cell";
            cellEl.setAttribute("role", "gridcell");
            cellEl.setAttribute("aria-colindex", String(c + 1));
            // Static -- never changes for this cell. Read by the delegated
            // pointerdown handler on root to identify which column was tapped.
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

            // Reactive text. We use a manual effect (not bindText) so we can
            // skip the write when this cell is currently being edited -- the
            // contenteditable cell IS the source of truth while editing, and
            // any textContent write would clobber the user's caret.
            scope.effect(() => {
                const i = slotIndex();
                const rs = visibleRows();
                if (i < 0 || i >= rs.length) { cellEl.textContent = ""; return; }
                const row = rs[i];
                // Editing gate: suspend text writes for the cell currently in
                // edit mode. The effect still tracks `editingCell` so it
                // resumes the moment editing ends. Tracking visibleRows + col
                // here means scrolling-during-edit re-points the slot to a
                // different row; we commit the in-flight edit in that case
                // (see slot-row scroll effect below) so the suspended write
                // resumes with the right row's data.
                if (col.editable) {
                    const e = editingCell();
                    if (e !== null && row != null && e.rowId === getRowId(row) && e.columnKey === col.key) {
                        return;
                    }
                }
                const v = readCell(col, row);
                const text = v == null ? "" : String(v);
                if (cellEl.textContent !== text) cellEl.textContent = text;
            });

            // Reactive id (the aria-activedescendant target).
            scope.onCleanup(bindAttr(cellEl, "id", () => {
                const i = slotIndex();
                const rs = visibleRows();
                if (i < 0 || i >= rs.length) return null;
                const row = rs[i];
                if (row == null) return null;
                return cellId(getRowId(row), col.key);
            }));

            // Focus indicator. Cheaper than rewriting a <style> element's
            // textContent because that invalidates CSSOM globally. Here each
            // cell flips one class; only the 1-2 cells that gain/lose focus
            // produce classList writes.
            scope.onCleanup(bindClass(cellEl, "is-focused", () => {
                const i = slotIndex();
                const rs = visibleRows();
                if (i < 0 || i >= rs.length) return false;
                const row = rs[i];
                if (row == null) return false;
                const f = focusedCell();
                if (!f) return false;
                return getRowId(row) === f.rowId && col.key === f.columnKey;
            }));

            // Editable cells: manage contenteditable + the editing-flash class.
            // We only attach this machinery for columns that opted in -- non-
            // editable cells stay simple text nodes with no event listeners.
            if (col.editable) {
                cellEl.setAttribute("data-editable", "true");

                // Editing state painted as data + class + contenteditable.
                scope.effect(() => {
                    const i = slotIndex();
                    const rs = visibleRows();
                    if (i < 0 || i >= rs.length) {
                        cellEl.removeAttribute("contenteditable");
                        cellEl.classList.remove("is-editing");
                        return;
                    }
                    const row = rs[i];
                    if (row == null) {
                        cellEl.removeAttribute("contenteditable");
                        cellEl.classList.remove("is-editing");
                        return;
                    }
                    const e = editingCell();
                    const editingThis = e !== null && e.rowId === getRowId(row) && e.columnKey === col.key;
                    if (editingThis) {
                        if (cellEl.getAttribute("contenteditable") !== "true") {
                            cellEl.setAttribute("contenteditable", "true");
                            // Seed textContent with the draft so what the user
                            // sees matches what commitEdit will read. Capture
                            // the draft synchronously to avoid re-running this
                            // effect on every keystroke (draft changes don't
                            // need to re-paint anything else).
                            const seed = editingDraft.peek();
                            if (cellEl.textContent !== seed) cellEl.textContent = seed;
                            // Defer focus to the next microtask so any
                            // synchronous DOM rearrangement (slot recycle,
                            // resize) doesn't pre-empt the focus call.
                            queueMicrotask(() => {
                                if (cellEl.getAttribute("contenteditable") === "true") {
                                    cellEl.focus();
                                    // Select all so a tab into the cell starts
                                    // with the whole value highlighted -- the
                                    // standard spreadsheet idiom.
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

                // input event: keep the draft in sync with the visible content
                // so commitEdit (which reads editingDraft) gets the latest.
                scope.on(cellEl, "input", () => {
                    // Only act when this cell is the one being edited. Slot
                    // recycling could in theory fire input on a stale cell
                    // (it shouldn't if contenteditable isn't set, but the
                    // guard is cheap).
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    editingDraft.set(cellEl.textContent || "");
                });

                // keydown: Enter commits (and we move down), Escape cancels,
                // Tab commits (and the browser moves focus).
                scope.on(cellEl, "keydown", (ev) => {
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    if (ev.key === "Escape") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        cancelEdit();
                        // Restore focus to the root so keyboard nav continues.
                        root.focus();
                    } else if (ev.key === "Enter" && !ev.shiftKey) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commitEdit();
                        root.focus();
                        // Move focus to the row below if there is one.
                        moveFocus("down");
                    } else if (ev.key === "Tab") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        commitEdit();
                        root.focus();
                        moveFocus(ev.shiftKey ? "left" : "right");
                    }
                });

                // blur: commit. Use focusout so it fires reliably across all
                // browsers and bubbles through the cell.
                scope.on(cellEl, "blur", () => {
                    if (cellEl.getAttribute("contenteditable") !== "true") return;
                    commitEdit();
                });

                // dblclick: start editing this cell.
                scope.on(cellEl, "dblclick", (ev) => {
                    const i = slotIndex.peek();
                    const rs = visibleRows.peek();
                    if (i < 0 || i >= rs.length) return;
                    const row = rs[i];
                    if (row == null) return;
                    ev.preventDefault();
                    startEdit(getRowId(row), col.key);
                });
            }

            // No pointerdown listener here -- the root has one delegated
            // listener that uses closest('.lt-cell') + data-key + slot index.

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
        const rs = untrack(() => visibleRows());
        if (slotIdx < 0 || slotIdx >= rs.length) return;
        const row = rs[slotIdx];
        if (row == null) return;
        const rowId = getRowId(row);
        if (ev.shiftKey) selectRow(rowId, "range");
        else if (ev.ctrlKey || ev.metaKey) selectRow(rowId, "toggle");
        else selectRow(rowId, "set");
        focusedCell.set({ rowId, columnKey: colKey });
        // No preventDefault -- preserves native text selection on mouse and
        // scroll initiation on touch.
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
