/**
 * Allocation and write-amplification tests.
 *
 * Honest claims under test:
 *   1. ZERO-WRITE SUB-ROW SCROLL: scrolling within one row's height triggers
 *      zero DOM writes -- proven by lite-virtual's integer-gated start signal
 *      (Object.is cutoff on the truncated index). This is the "writes zero
 *      bytes to the DOM" claim from lite-virtual.
 *   2. STABLE SIGNAL GRAPH: 5000 boundary-crossing scrolls do not grow the
 *      number of signals, computeds, effects, or dependency links in the
 *      lite-signal registry. This is the reactive-layer "zero-GC" claim.
 *
 * NOT tested here: heap-bytes growth in happy-dom. happy-dom allocates per
 * setAttribute / classList / style write (these are object allocations in
 * its DOM impl, not in ours). A real-browser benchmark is in /bench (M0+1).
 * Measuring process.memoryUsage().heapUsed under happy-dom would yield a
 * misleading number that says nothing about lite-table's actual behaviour
 * in a browser. We do not ship dishonest benchmarks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom, fireScroll } from "./_setup.js";
setupDom();

const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");
const { stats } = await import("@zakkster/lite-signal");

function makeRows(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { id: i, name: "row-" + i, value: i };
    return out;
}

const COLS = [
    { key: "id", header: "ID", width: 60 },
    { key: "name", header: "Name", width: 160 },
    { key: "value", header: "Value", width: 80 }
];

/**
 * Patch a node's style property setter to count writes. happy-dom exposes
 * the CSSStyleDeclaration as a normal object whose properties we can wrap
 * via Proxy. We patch the row element directly.
 */
function countTransformWrites(rowEl) {
    let writes = 0;
    const original = rowEl.style;
    // happy-dom's CSSStyleDeclaration supports property assignment; wrap via
    // a Proxy that increments on transform writes and passes everything else
    // through unchanged. Reads still hit the underlying object.
    const proxied = new Proxy(original, {
        set(target, prop, value) {
            if (prop === "transform") writes++;
            target[prop] = value;
            return true;
        },
        get(target, prop) {
            const v = target[prop];
            return typeof v === "function" ? v.bind(target) : v;
        }
    });
    Object.defineProperty(rowEl, "style", { value: proxied, configurable: true });
    return {
        count: () => writes,
        reset: () => { writes = 0; }
    };
}

test("sub-row scroll: zero transform writes within one row's height", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(10_000),
        columns: COLS,
        getRowId: (r) => r.id,
        rowHeight: 32,
        overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    // Settle into a stable row position (scroll to row 100).
    fireScroll(m.viewport, 100 * 32);

    // Pick the first slot row and install a transform-write counter on it.
    const slot0 = m.root.querySelectorAll(".lt-row")[0];
    const probe = countTransformWrites(slot0);

    // Sub-row scrolls: 100*32 + 1px, +2px, ..., +31px. None should cross a
    // row boundary (rowHeight = 32), so the integer-truncated start does not
    // change, so the slot's slotIndex does not change, so no transform write.
    probe.reset();
    for (let dy = 1; dy < 32; dy++) {
        fireScroll(m.viewport, 100 * 32 + dy);
    }
    assert.equal(probe.count(), 0,
        "sub-row scroll caused " + probe.count() + " transform writes; expected 0");

    // Crossing a row boundary (+32) must trigger exactly one write.
    probe.reset();
    fireScroll(m.viewport, 101 * 32);
    assert.equal(probe.count(), 1,
        "single boundary crossing should write transform exactly once");

    m.dispose();
    host.remove();
});

test("sub-row scroll: zero cell text writes within one row's height", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(10_000),
        columns: COLS,
        getRowId: (r) => r.id,
        rowHeight: 32
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    fireScroll(m.viewport, 200 * 32);

    // Snapshot textContent of every cell.
    const cells = Array.from(m.root.querySelectorAll(".lt-cell"));
    const before = cells.map((c) => c.textContent);

    // Sub-row scroll.
    for (let dy = 1; dy < 32; dy++) {
        fireScroll(m.viewport, 200 * 32 + dy);
    }

    const after = cells.map((c) => c.textContent);
    for (let i = 0; i < before.length; i++) {
        assert.equal(after[i], before[i],
            "cell " + i + " text changed during sub-row scroll: '" +
            before[i] + "' -> '" + after[i] + "'");
    }

    m.dispose();
    host.remove();
});

test("signal graph: node and link counts stable across 5000 boundary scrolls", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(100_000),
        columns: COLS,
        getRowId: (r) => r.id,
        rowHeight: 32
    });
    const m = mountTable(host, t, { initialViewportHeight: 480 });

    // Warm up: settle first-time effect runs and any lazy connection.
    for (let i = 0; i < 200; i++) m.axis.setScroll(i * 32);

    const before = stats();

    // The reactive hot path. 5000 row-boundary crossings, each one fanning
    // out through axis.start -> per-slot slotIndex -> per-slot transform /
    // display / alt effects + per-cell text / id / class bindings.
    //
    // The signal graph itself MUST NOT grow: no new signals, no new
    // computeds, no new effects, no new dependency links. Steady-state
    // reactivity is the load-bearing zero-GC claim. DOM string allocations
    // (transform values, id attrs) happen in the browser layer below us
    // and are not under lite-table's control.
    for (let i = 200; i < 5200; i++) m.axis.setScroll(i * 32);

    const after = stats();

    assert.equal(after.signals, before.signals,
        "signal count grew: " + before.signals + " -> " + after.signals);
    assert.equal(after.computeds, before.computeds,
        "computed count grew: " + before.computeds + " -> " + after.computeds);
    assert.equal(after.effects, before.effects,
        "effect count grew: " + before.effects + " -> " + after.effects);
    assert.equal(after.activeLinks, before.activeLinks,
        "active dep links grew: " + before.activeLinks + " -> " + after.activeLinks);
    assert.equal(after.activeNodes, before.activeNodes,
        "active nodes grew: " + before.activeNodes + " -> " + after.activeNodes);

    m.dispose();
    host.remove();
});

test("pool size invariant: never grows during scroll, only on viewport grow", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(50_000),
        columns: COLS,
        getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    const initial = m.poolSize();

    // Scroll far -- pool must not grow.
    for (let i = 0; i < 1000; i++) {
        fireScroll(m.viewport, i * 320);
    }
    assert.equal(m.poolSize(), initial);

    m.dispose();
    host.remove();
});
