/**
 * Sort cost. lite-table's sort uses a reusable Uint32Array of indices: one
 * fill (0..N-1), one in-place sort with a comparator that dereferences rows,
 * one output array of N references. Zero tuple allocations per sort. The
 * comparator falls back to original-index ordering as a stability tiebreaker.
 *
 * Naive and clusterize do not natively sort; we don't compare them here.
 * The reference comparator is native Array.sort on the same dataset, which
 * is the lower bound on what's achievable in pure JS.
 */

import {
    document, makeHost, makeRows, STD_COLUMNS,
    time, fmtMs, window
} from "./_harness.js";

const ROWS = 100_000;
const VH = 480;

async function run() {
    const { createTable, mountTable } = await import("../Table.js");

    const data = makeRows(ROWS);
    const host = makeHost(1200, VH);
    const t = createTable({
        rows: data, columns: STD_COLUMNS, getRowId: (r) => r.id,
        rowHeight: 32, overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: VH });
    Object.defineProperty(m.viewport, "clientHeight", {
        configurable: true, get: () => VH
    });

    // Reference: native sort on a fresh copy.
    const ref = await time("native", async () => {
        const copy = data.slice();
        copy.sort((a, b) => a.value - b.value);
    });

    // Single-column sort -- first time pays the recompute cost.
    const sort1 = await time("setSort(value, asc)", async () => {
        t.setSort("value", "asc");
        // Force the computed to materialize.
        t.visibleRows();
    });

    // Re-read: should be a cached pull, essentially free.
    const reread = await time("re-read visibleRows", async () => {
        t.visibleRows();
    });

    // Multi-key sort.
    t.clearSort();
    t.visibleRows();
    const sort2 = await time("setSort then addSort", async () => {
        t.setSort("status", "asc");
        t.addSort("value", "desc");
        t.visibleRows();
    });

    // Toggle sort direction.
    const toggle = await time("toggleSort cycle", async () => {
        t.toggleSort("value");      // -> asc (or flip)
        t.visibleRows();
    });

    // Sort + scroll: change sort, then scroll. Verifies the new visibleRows
    // is what the slots project against.
    t.clearSort();
    t.visibleRows();
    const sortPlusScroll = await time("sort + scroll 100 rows", async () => {
        t.setSort("name", "desc");
        t.visibleRows();
        for (let i = 0; i < 100; i++) {
            m.viewport.scrollTop = i * 32;
            m.viewport.dispatchEvent(new window.Event("scroll"));
        }
    });

    m.dispose();
    host.remove();
    return { ref, sort1, reread, sort2, toggle, sortPlusScroll };
}

if (import.meta.url === "file://" + process.argv[1]) {
    const r = await run();
    console.log("\nsort cost (100k rows, 5 columns)\n");
    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
    console.log(pad("operation", 32), pad("time", 12));
    console.log(pad("  Array.sort (reference)", 32),       pad(fmtMs(r.ref.ms), 12));
    console.log(pad("  setSort 1 col + read", 32),         pad(fmtMs(r.sort1.ms), 12));
    console.log(pad("  re-read visibleRows (cached)", 32), pad(fmtMs(r.reread.ms), 12));
    console.log(pad("  setSort + addSort (multi)", 32),    pad(fmtMs(r.sort2.ms), 12));
    console.log(pad("  toggleSort cycle", 32),             pad(fmtMs(r.toggle.ms), 12));
    console.log(pad("  sort + scroll 100 rows", 32),       pad(fmtMs(r.sortPlusScroll.ms), 12));
}

export { run };
