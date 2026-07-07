/**
 * M3: heap + graph stability in a GROUPED view.
 *
 * Same shape as 03-heap.js -- 100k rows, warm-up, baseline, then 10k boundary
 * scrolls -- but with `groupBy: "status"` and per-column aggregates active.
 * If M3 introduced any per-scroll allocation, this would show it as a
 * signal-node delta or heap creep. The scroll path stays entirely in the
 * existing translateY + textContent update loop; group headers are just
 * another `entry.type` case in the same cell effect.
 *
 * What "grouped view" costs vs plain scroll:
 *   - visibleEntries pipeline: rebuilt only when filteredRows / sortChain /
 *     groupBy / collapsedGroups change. Never on scroll.
 *   - slotEntry computed per pool slot: allocated once at mount, reactive
 *     read on every boundary cross. No new node per read.
 *   - Aggregate map: allocated once per group per pipeline rebuild.
 *     Persists across scrolls.
 *
 * Expected result: same zero-delta profile as 03-heap.js.
 */

import {
    document, makeHost, makeRows, STD_COLUMNS,
    heap, fmtBytes, fmt, window
} from "./_harness.js";

const ROWS = 100_000;
const ROW_HEIGHT = 32;
const VH = 480;
const N = 10_000;

async function run() {
    const { createTable, mountTable } = await import("../Table.js");
    const { stats } = await import("@zakkster/lite-signal");

    const host = makeHost(1200, VH);

    // Grouped by status (3 buckets, cheap to compute) with a sum aggregate
    // on `value`. This gives us group-header entries interleaved through
    // the pool during scroll -- proving the entry-type dispatch in the
    // rewritten cell effect stays allocation-free.
    const columns = STD_COLUMNS.map((c, i) => {
        // Attach a sum aggregate to the `value` column; leave others plain.
        if (c.key === "value") {
            return { ...c, aggregate: "sum",
                     aggregateFormat: (v) => "$" + v.toFixed(0) };
        }
        return c;
    });

    const t = createTable({
        rows: makeRows(ROWS), columns, getRowId: (r) => r.id,
        rowHeight: ROW_HEIGHT, overscan: 4,
        groupBy: "status",
        showGrandTotal: true
    });
    const m = mountTable(host, t, { initialViewportHeight: VH });
    const v = m.viewport;
    Object.defineProperty(v, "clientHeight", { configurable: true, get: () => VH });

    // Warm up: enough scrolls to hit multiple group boundaries and warm
    // every reactive computed at least once (visibleEntries, slotEntry per
    // pool slot, aggregate formats, etc.).
    for (let i = 0; i < 200; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }
    v.scrollTop = 0;
    v.dispatchEvent(new window.Event("scroll"));

    const beforeHeap = heap();
    const beforeStats = stats();
    const beforePool = m.poolSize();
    const beforeEntries = t.entryCount();

    // The workload -- 10k boundary scrolls crossing group headers.
    for (let i = 0; i < N; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }

    const afterHeap = heap();
    const afterStats = stats();
    const afterPool = m.poolSize();
    const afterEntries = t.entryCount();

    m.dispose();
    host.remove();

    return {
        scrolledRows: N,
        entryCount: { before: beforeEntries, after: afterEntries },
        heap: { before: beforeHeap, after: afterHeap, delta: afterHeap - beforeHeap },
        graph: {
            beforeNodes: beforeStats.activeNodes, afterNodes: afterStats.activeNodes,
            deltaNodes: afterStats.activeNodes - beforeStats.activeNodes,
            beforeLinks: beforeStats.activeLinks, afterLinks: afterStats.activeLinks,
            deltaLinks: afterStats.activeLinks - beforeStats.activeLinks
        },
        pool: { before: beforePool, after: afterPool, delta: afterPool - beforePool }
    };
}

if (import.meta.url === "file://" + process.argv[1]) {
    const r = await run();
    console.log("\nheap & signal-graph stability across " + fmt(r.scrolledRows) +
                " boundary scrolls (GROUPED view, groupBy: 'status', showGrandTotal)\n");
    console.log("  entries visible:    " + r.entryCount.before +
                " (rows + group headers + grand total)");
    console.log("  heap before:        " + fmtBytes(r.heap.before));
    console.log("  heap after:         " + fmtBytes(r.heap.after));
    console.log("  heap delta:         " + fmtBytes(r.heap.delta) +
        "   (~" + fmtBytes(r.heap.delta / r.scrolledRows) + "/row)");
    console.log("  signal nodes delta: " + r.graph.deltaNodes +
        "   (was " + r.graph.beforeNodes + ", now " + r.graph.afterNodes + ")");
    console.log("  signal links delta: " + r.graph.deltaLinks +
        "   (was " + r.graph.beforeLinks + ", now " + r.graph.afterLinks + ")");
    console.log("  pool size delta:    " + r.pool.delta +
        "   (was " + r.pool.before + ", now " + r.pool.after + ")");
}

export { run };
