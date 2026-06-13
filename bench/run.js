/**
 * Orchestrator. Runs every bench, prints a compact markdown report.
 *
 * Usage:
 *   npm run bench               (text output)
 *   npm run bench -- --md       (markdown -- copy into README)
 */

import { fmt, fmtMs, fmtBytes } from "./_harness.js";
import { run as runScroll } from "./01-scroll-writes.js";
import { run as runMount } from "./02-mount.js";
import { run as runHeap } from "./03-heap.js";
import { run as runSort } from "./04-sort.js";

const useMd = process.argv.includes("--md");

function h(s, level) {
    if (useMd) console.log(("#".repeat(level)) + " " + s);
    else console.log("\n=== " + s + " ===");
}
function note(s) {
    if (useMd) console.log("\n_" + s + "_\n");
    else console.log("\n  " + s + "\n");
}
function mdTable(headers, rows) {
    if (useMd) {
        console.log("\n| " + headers.join(" | ") + " |");
        console.log("|" + headers.map(() => "---").join("|") + "|");
        for (const row of rows) console.log("| " + row.join(" | ") + " |");
        console.log("");
    } else {
        const widths = headers.map((h, i) =>
            Math.max(h.length, ...rows.map((r) => String(r[i] || "").length)));
        const pad = (s, w) => (String(s) + " ".repeat(w)).slice(0, w);
        console.log("\n  " + headers.map((h, i) => pad(h, widths[i])).join("  "));
        console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
        for (const row of rows) {
            console.log("  " + row.map((c, i) => pad(c, widths[i])).join("  "));
        }
        console.log("");
    }
}

h("@zakkster/lite-table benchmarks", 2);
note("Methodology: in-process under Node 22 + happy-dom. " +
     "DOM mutation counts, signal-graph stats, and pool size are exact. " +
     "Heap is approximate. Run on your hardware for absolute numbers.");

// 1. SCROLL ----------------------------------------------------------------
h("Scroll: zero-allocation steady state", 3);
note("100k rows, 480px viewport. allocations create new DOM nodes (GC pressure); " +
     "updates mutate existing nodes in place (no allocation).");

const scroll = await runScroll();
const scrollRows = [];
for (const [impl, r] of Object.entries(scroll)) {
    if (r.error) {
        scrollRows.push([impl, "error: " + r.error, "", "", "", "", "", ""]);
        continue;
    }
    scrollRows.push([impl,
        fmt(r.sub.allocations), fmt(r.sub.updates),
        fmt(r.boundary.allocations), fmt(r.boundary.updates),
        fmt(r.long.allocations), fmt(r.long.updates)
    ]);
}
mdTable(
    ["impl", "sub alloc", "sub upd", "boundary alloc", "boundary upd", "1k-jump alloc", "1k-jump upd"],
    scrollRows
);
note("sub = 100 scroll events that stay within one row. " +
     "boundary = 100 scroll events each crossing one row. " +
     "1k-jump = single scroll event crossing 1000 rows.");

// 2. MOUNT -----------------------------------------------------------------
h("Mount: cost vs dataset size", 3);
note("Total writes + allocations during initial render. lite-table's pool is " +
     "bounded by viewport, so cost is constant.");

const mount = await runMount();
const mountRows = [];
for (const [n, byImpl] of Object.entries(mount)) {
    for (const [impl, r] of Object.entries(byImpl)) {
        if (r.na) {
            mountRows.push([fmt(Number(n)), impl, "OOM", "", "", ""]);
            continue;
        }
        mountRows.push([fmt(Number(n)), impl, fmtMs(r.ms),
            fmt(r.allocations), fmt(r.writes), String(r.pool ?? "")]);
    }
}
mdTable(["rows", "impl", "time", "alloc", "total writes", "pool"], mountRows);

// 3. HEAP ------------------------------------------------------------------
h("Heap stability: zero-GC verification", 3);
note("Mount once, warm up, take a baseline, scroll N boundaries, measure delta. " +
     "Signal-graph counts and pool size are the exact numbers; heap is indicative.");

const hr = await runHeap();
mdTable(
    ["metric", "before", "after", "delta"],
    [
        ["heap",          fmtBytes(hr.heap.before),     fmtBytes(hr.heap.after),     fmtBytes(hr.heap.delta)],
        ["signal nodes",  String(hr.graph.beforeNodes), String(hr.graph.afterNodes), String(hr.graph.deltaNodes)],
        ["signal links",  String(hr.graph.beforeLinks), String(hr.graph.afterLinks), String(hr.graph.deltaLinks)],
        ["DOM pool size", String(hr.pool.before),       String(hr.pool.after),       String(hr.pool.delta)]
    ]
);
note("Workload: " + fmt(hr.scrolledRows) + " boundary scrolls.");

// 4. SORT ------------------------------------------------------------------
h("Sort: cost of operations", 3);
note("100k rows. Reference is native Array.sort on the same data. lite-table's sort " +
     "uses a reusable Uint32Array of indices -- one fill, one in-place sort, " +
     "one output allocation. Zero tuple allocations.");

const sr = await runSort();
mdTable(
    ["operation", "time"],
    [
        ["Array.sort (reference)",         fmtMs(sr.ref.ms)],
        ["setSort 1 col + read",           fmtMs(sr.sort1.ms)],
        ["re-read visibleRows (cached)",   fmtMs(sr.reread.ms)],
        ["setSort + addSort (multi)",      fmtMs(sr.sort2.ms)],
        ["toggleSort cycle",               fmtMs(sr.toggle.ms)],
        ["sort + scroll 100 rows",         fmtMs(sr.sortPlusScroll.ms)]
    ]
);
