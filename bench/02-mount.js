/**
 * Mount cost. Time and DOM writes during initial render.
 *
 * lite-table's pool is bounded by VIEWPORT, not dataset. So mounting against
 * 1M rows should be ~the same cost as mounting against 1k rows.
 *
 * Naive mounts visible+overscan rows too, so it's bounded -- but every
 * scroll event rebuilds. clusterize is bounded by its block size.
 */

import {
    document, makeHost, makeRows, STD_COLUMNS,
    startCounts, stopCounts, time, fmt, fmtMs
} from "./_harness.js";
import { naiveMount } from "./_naive-virtual.js";

const SIZES = [1_000, 10_000, 100_000, 1_000_000];
const VH = 480;

async function mountLite(rows) {
    const { createTable, mountTable } = await import("../Table.js");
    const host = makeHost(1200, VH);
    let m;
    startCounts();
    const r = await time("mount", async () => {
        const t = createTable({
            rows, columns: STD_COLUMNS, getRowId: (r) => r.id,
            rowHeight: 32, overscan: 4
        });
        m = mountTable(host, t, { initialViewportHeight: VH });
    });
    const c = stopCounts();
    const pool = m.poolSize();
    m.dispose();
    host.remove();
    return { ms: r.ms, writes: c.total, allocations: c.allocations, pool };
}

async function mountNaive(rows) {
    const host = makeHost(1200, VH);
    let m;
    startCounts();
    const r = await time("mount", async () => {
        m = naiveMount(host, {
            rows, columns: STD_COLUMNS, rowHeight: 32, viewportHeight: VH
        });
    });
    const c = stopCounts();
    m.dispose();
    host.remove();
    return { ms: r.ms, writes: c.total, allocations: c.allocations, pool: null };
}

async function mountClusterize(rows) {
    const ClusterizeMod = await import("clusterize.js");
    const Clusterize = ClusterizeMod.default || ClusterizeMod;
    const host = makeHost(1200, VH);
    const scrollEl = document.createElement("div");
    scrollEl.id = "scrollArea";
    scrollEl.style.cssText = "height:" + VH + "px;overflow:auto;position:relative;";
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, get: () => VH });
    const contentEl = document.createElement("div");
    contentEl.id = "contentArea";
    scrollEl.appendChild(contentEl);
    host.appendChild(scrollEl);

    const rowData = rows.map((row) =>
        '<div style="height:32px">' +
        row.id + " | " + row.name + " | " + row.email + " | " + row.value + " | " + row.status +
        '</div>'
    );

    let c;
    startCounts();
    const r = await time("mount", async () => {
        try {
            c = new Clusterize({
                rows: rowData, scrollElem: scrollEl, contentElem: contentEl,
                rows_in_block: 50, blocks_in_cluster: 4, no_data_text: ""
            });
        } catch (e) { /* ignore */ }
    });
    const counts = stopCounts();
    if (c) c.destroy();
    host.remove();
    return { ms: r.ms, writes: counts.total, allocations: counts.allocations, pool: null };
}

export async function run() {
    const out = {};
    for (const n of SIZES) {
        const rows = makeRows(n);
        out[n] = { "lite-table": await mountLite(rows) };
        // Naive and clusterize cannot survive 1M rows in this harness because
        // they build the full HTML string up-front. Skip with N/A marker.
        if (n <= 100_000) {
            out[n]["naive"] = await mountNaive(rows);
            out[n]["clusterize.js"] = await mountClusterize(rows);
        } else {
            out[n]["naive"] = { ms: NaN, writes: NaN, allocations: NaN, pool: null, na: true };
            out[n]["clusterize.js"] = { ms: NaN, writes: NaN, allocations: NaN, pool: null, na: true };
        }
    }
    return out;
}

if (import.meta.url === "file://" + process.argv[1]) {
    const out = await run();
    console.log("\nmount cost: time, allocations, total writes\n");
    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
    console.log(pad("rows", 12), pad("impl", 14), pad("time", 10),
        pad("alloc", 10), pad("total", 10), pad("pool", 8));
    for (const n of SIZES) {
        for (const [name, r] of Object.entries(out[n])) {
            if (r.na) {
                console.log(pad(fmt(n), 12), pad(name, 14),
                    "OOM in this harness (builds full HTML up-front)");
                continue;
            }
            console.log(pad(fmt(n), 12),
                pad(name, 14),
                pad(fmtMs(r.ms), 10),
                pad(fmt(r.allocations), 10),
                pad(fmt(r.writes), 10),
                pad(r.pool == null ? "" : String(r.pool), 8));
        }
    }
}
