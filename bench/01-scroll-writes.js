/**
 * Scroll DOM-write counts. The headline metric for zero-GC.
 *
 * Three regimes per implementation:
 *   1. SUB-ROW scroll: scrollTop changes by less than one row height.
 *      lite-table goal: 0 mutations (Object.is cutoff on truncated index).
 *   2. BOUNDARY scroll: scrollTop crosses exactly one row.
 *      lite-table goal: O(slots-moved) -- bounded per cross.
 *   3. LONG scroll: scrollTop crosses 1000 rows.
 *      lite-table goal: O(rows-crossed), linear and constant per row.
 */

import {
    document, makeHost, makeRows, STD_COLUMNS,
    startCounts, stopCounts, fmt
} from "./_harness.js";
import { naiveMount } from "./_naive-virtual.js";

const ROWS = 100_000;
const ROW_HEIGHT = 32;
const VH = 480;

// ----- lite-table -----------------------------------------------------------

async function benchLite() {
    const { createTable, mountTable } = await import("../Table.js");
    const host = makeHost(1200, VH);
    const t = createTable({
        rows: makeRows(ROWS), columns: STD_COLUMNS, getRowId: (r) => r.id,
        rowHeight: ROW_HEIGHT, overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: VH });
    const v = m.viewport;
    // happy-dom doesn't lay out; clientHeight stays 0 unless we override.
    Object.defineProperty(v, "clientHeight", { configurable: true, get: () => VH });

    // Settle.
    v.scrollTop = 0; v.dispatchEvent(new window.Event("scroll"));

    // (1) sub-row scrolls
    startCounts();
    for (let i = 0; i < 100; i++) {
        v.scrollTop = 8 + i * 0.3; // never crosses a row boundary at 32px
        v.dispatchEvent(new window.Event("scroll"));
    }
    const sub = stopCounts();

    // (2) one-row-at-a-time boundary scrolls
    v.scrollTop = 0; v.dispatchEvent(new window.Event("scroll"));
    startCounts();
    for (let i = 1; i <= 100; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }
    const boundary = stopCounts();

    // (3) long scroll: 1000 rows
    v.scrollTop = 0; v.dispatchEvent(new window.Event("scroll"));
    startCounts();
    v.scrollTop = 1000 * ROW_HEIGHT;
    v.dispatchEvent(new window.Event("scroll"));
    const long = stopCounts();

    m.dispose();
    host.remove();
    return { sub, boundary, long };
}

// ----- naive ----------------------------------------------------------------

async function benchNaive() {
    const host = makeHost(1200, VH);
    const m = naiveMount(host, {
        rows: makeRows(ROWS), columns: STD_COLUMNS,
        rowHeight: ROW_HEIGHT, viewportHeight: VH
    });
    const v = m.root;
    Object.defineProperty(v, "clientHeight", { configurable: true, get: () => VH });

    startCounts();
    for (let i = 0; i < 100; i++) {
        v.scrollTop = 8 + i * 0.3;
        v.dispatchEvent(new window.Event("scroll"));
    }
    const sub = stopCounts();

    v.scrollTop = 0; v.dispatchEvent(new window.Event("scroll"));
    startCounts();
    for (let i = 1; i <= 100; i++) {
        v.scrollTop = i * ROW_HEIGHT;
        v.dispatchEvent(new window.Event("scroll"));
    }
    const boundary = stopCounts();

    v.scrollTop = 0; v.dispatchEvent(new window.Event("scroll"));
    startCounts();
    v.scrollTop = 1000 * ROW_HEIGHT;
    v.dispatchEvent(new window.Event("scroll"));
    const long = stopCounts();

    m.dispose();
    host.remove();
    return { sub, boundary, long };
}

// ----- clusterize -----------------------------------------------------------

async function benchClusterize() {
    // Clusterize.js needs a real-DOM table structure and string rows.
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

    const rowData = makeRows(ROWS).map((r) =>
        '<div style="height:' + ROW_HEIGHT + 'px">' +
        r.id + " | " + r.name + " | " + r.email + " | " + r.value + " | " + r.status +
        '</div>'
    );

    let c;
    try {
        c = new Clusterize({
            rows: rowData,
            scrollElem: scrollEl,
            contentElem: contentEl,
            rows_in_block: 50,
            blocks_in_cluster: 4,
            no_data_text: ""
        });
    } catch (e) {
        // Clusterize uses some APIs happy-dom may not implement perfectly.
        return { error: e.message };
    }

    startCounts();
    for (let i = 0; i < 100; i++) {
        scrollEl.scrollTop = 8 + i * 0.3;
        scrollEl.dispatchEvent(new window.Event("scroll"));
    }
    const sub = stopCounts();

    scrollEl.scrollTop = 0; scrollEl.dispatchEvent(new window.Event("scroll"));
    startCounts();
    for (let i = 1; i <= 100; i++) {
        scrollEl.scrollTop = i * ROW_HEIGHT;
        scrollEl.dispatchEvent(new window.Event("scroll"));
    }
    const boundary = stopCounts();

    scrollEl.scrollTop = 0; scrollEl.dispatchEvent(new window.Event("scroll"));
    startCounts();
    scrollEl.scrollTop = 1000 * ROW_HEIGHT;
    scrollEl.dispatchEvent(new window.Event("scroll"));
    const long = stopCounts();

    c.destroy();
    host.remove();
    return { sub, boundary, long };
}

// ----- run ------------------------------------------------------------------

export async function run() {
    const results = {
        "lite-table":   await benchLite(),
        "naive":        await benchNaive(),
        "clusterize.js": await benchClusterize()
    };
    return results;
}

if (import.meta.url === "file://" + process.argv[1]) {
    const out = await run();
    console.log("\nscroll DOM mutations (100k rows, " + VH + "px viewport)");
    console.log("alloc = appendChild/insertBefore/innerHTML (GC pressure)");
    console.log("update = setAttribute/textContent (in-place)\n");
    const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
    console.log(pad("", 16), pad("alloc", 10), pad("update", 10), pad("total", 10));
    for (const [name, r] of Object.entries(out)) {
        if (r.error) {
            console.log("  " + name + ": ERROR -- " + r.error);
            continue;
        }
        console.log(pad("  " + name, 16) + "  -- per regime --");
        console.log(pad("    sub-row  ", 16),
            pad(fmt(r.sub.allocations), 10),
            pad(fmt(r.sub.updates), 10),
            pad(fmt(r.sub.total), 10));
        console.log(pad("    boundary ", 16),
            pad(fmt(r.boundary.allocations), 10),
            pad(fmt(r.boundary.updates), 10),
            pad(fmt(r.boundary.total), 10));
        console.log(pad("    long jump", 16),
            pad(fmt(r.long.allocations), 10),
            pad(fmt(r.long.updates), 10),
            pad(fmt(r.long.total), 10));
    }
}
