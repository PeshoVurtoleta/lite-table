/**
 * Heap stability across a long scroll. The empirical case for zero-GC.
 *
 * Method: mount once, run a baseline scroll to warm caches and force any
 * lazy allocations, GC, take a baseline, then scroll N more boundaries and
 * measure delta. A well-behaved implementation produces noise-floor delta.
 *
 * Caveat: happy-dom + V8 in Node have GC patterns unlike a real browser.
 * The signal-graph counts and pool size are exact; the heap number is
 * indicative and best taken as a relative comparison.
 */

import {
    document, makeHost, makeRows, STD_COLUMNS,
    heap, fmtBytes, fmt, window
} from "./_harness.js";

const ROWS = 100_000;
const ROW_HEIGHT = 32;
const VH = 480;
const N = 10_000;  // scroll boundaries to traverse after warm-up

async function run() {
    const { createTable, mountTable } = await import("../Table.js");
    const { stats } = await import("@zakkster/lite-signal");

    const host = makeHost(1200, VH);
    const t = createTable({
        rows: makeRows(ROWS), columns: STD_COLUMNS, getRowId: (r) => r.id,
        rowHeight: ROW_HEIGHT, overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: VH });
    const v = m.viewport;
    Object.defineProperty(v, "clientHeight", { configurable: true, get: () => VH });

    // Warm up.
    for (let i = 0; i < 100; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }
    v.scrollTop = 0;
    v.dispatchEvent(new window.Event("scroll"));

    // Baseline.
    const beforeHeap = heap();
    const beforeStats = stats();
    const beforePool = m.poolSize();

    // The actual scroll workload.
    for (let i = 0; i < N; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }

    const afterHeap = heap();
    const afterStats = stats();
    const afterPool = m.poolSize();

    m.dispose();
    host.remove();

    const result = {
        scrolledRows: N,
        heap: { before: beforeHeap, after: afterHeap, delta: afterHeap - beforeHeap },
        graph: {
            beforeNodes: beforeStats.activeNodes, afterNodes: afterStats.activeNodes,
            deltaNodes: afterStats.activeNodes - beforeStats.activeNodes,
            beforeLinks: beforeStats.activeLinks, afterLinks: afterStats.activeLinks,
            deltaLinks: afterStats.activeLinks - beforeStats.activeLinks
        },
        pool: { before: beforePool, after: afterPool, delta: afterPool - beforePool }
    };
    return result;
}

if (import.meta.url === "file://" + process.argv[1]) {
    const r = await run();
    console.log("\nheap & signal-graph stability across " + fmt(r.scrolledRows) + " boundary scrolls\n");
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
