/**
 * Sort: visibleRows is derived from sortChain, multi-column sort is stable,
 * aria-sort updates on headers, toggleSort cycles none -> asc -> desc -> none.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./_setup.js";
setupDom();

const { signal } = await import("@zakkster/lite-signal");
const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

const COLS = [
    { key: "id", header: "ID", width: 60 },
    { key: "name", header: "Name", width: 160 },
    { key: "value", header: "Value", width: 100 }
];

const ROWS = [
    { id: 1, name: "Charlie", value: 30 },
    { id: 2, name: "Alpha",   value: 10 },
    { id: 3, name: "Bravo",   value: 20 },
    { id: 4, name: "Alpha",   value: 5  }
];

test("sort: setSort(asc) reorders visibleRows ascending", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    assert.deepEqual(t.visibleRows().map(r => r.id), [1, 2, 3, 4]);
    t.setSort("name", "asc");
    assert.deepEqual(t.visibleRows().map(r => r.name),
        ["Alpha", "Alpha", "Bravo", "Charlie"]);
    t.dispose();
});

test("sort: setSort(desc) reorders descending", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.setSort("value", "desc");
    assert.deepEqual(t.visibleRows().map(r => r.value), [30, 20, 10, 5]);
    t.dispose();
});

test("sort: multi-column chain is stable", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    // Primary: name asc; secondary: value asc. Tie on "Alpha" should put
    // value=5 before value=10 (so row id 4 before row id 2).
    t.setSort("name", "asc");
    t.addSort("value", "asc");
    assert.deepEqual(t.visibleRows().map(r => r.id), [4, 2, 3, 1]);
    t.dispose();
});

test("sort: toggleSort cycles none -> asc -> desc -> none", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    assert.deepEqual(t.sortChain(), []);
    t.toggleSort("name"); // -> asc
    assert.deepEqual(t.sortChain(), [{ key: "name", dir: "asc" }]);
    t.toggleSort("name"); // -> desc
    assert.deepEqual(t.sortChain(), [{ key: "name", dir: "desc" }]);
    t.toggleSort("name"); // -> none
    assert.deepEqual(t.sortChain(), []);
    t.dispose();
});

test("sort: toggleSort additive builds and reduces the chain", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.toggleSort("name");
    t.toggleSort("value", { additive: true });
    assert.equal(t.sortChain().length, 2);
    t.toggleSort("value", { additive: true }); // asc -> desc
    assert.deepEqual(t.sortChain()[1], { key: "value", dir: "desc" });
    t.toggleSort("value", { additive: true }); // desc -> none (remove from chain)
    assert.equal(t.sortChain().length, 1);
    assert.equal(t.sortChain()[0].key, "name");
    t.dispose();
});

test("sort: plain click on a column in a multi-col chain toggles asc<->desc, never removes (chain preserved)", () => {
    // Without this rule, every plain click on a chained header risks pruning
    // chain entries on the third click (asc -> desc -> removed cycle). That
    // surprises users who carefully built a multi-column sort: one stray
    // plain-click on a chained desc column would silently lose that column.
    // New rule: plain-click on a chained column is asc <-> desc only. To
    // remove from chain, use shift-click (which still cycles asc -> desc ->
    // removed) or clearSort().
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.toggleSort("id");
    t.toggleSort("name",  { additive: true });
    t.toggleSort("value", { additive: true });
    assert.equal(t.sortChain().length, 3, "chain of 3 built via shift-click");

    // Plain-click `name` (middle, asc) -> flips to desc, chain length preserved.
    t.toggleSort("name");
    assert.equal(t.sortChain().length, 3, "chain length preserved on flip");
    assert.deepEqual(
        t.sortChain().map((e) => e.key + ":" + e.dir),
        ["id:asc", "name:desc", "value:asc"]
    );

    // Plain-click `name` AGAIN (was desc) -> flips back to asc, NOT removed.
    // This is the key behavior change from the old 3-state cycle.
    t.toggleSort("name");
    assert.equal(t.sortChain().length, 3, "chain length still preserved on second flip");
    assert.deepEqual(
        t.sortChain().map((e) => e.key + ":" + e.dir),
        ["id:asc", "name:asc", "value:asc"]
    );

    // Same for an unchanged column at the top of the chain.
    t.toggleSort("id"); // asc -> desc, chain preserved
    t.toggleSort("id"); // desc -> asc, chain preserved
    assert.equal(t.sortChain().length, 3);

    // To actually remove a chain entry the user must shift-click it through
    // the 3-state cycle (asc -> desc -> remove).
    t.toggleSort("name", { additive: true }); // asc -> desc
    t.toggleSort("name", { additive: true }); // desc -> removed
    assert.equal(t.sortChain().length, 2);
    assert.deepEqual(t.sortChain().map((e) => e.key), ["id", "value"]);

    // Plain-click an UN-chained column STILL replaces (resets to single sort).
    // "name" was just removed above, so it counts as un-chained again.
    t.toggleSort("name");
    assert.deepEqual(t.sortChain(), [{ key: "name", dir: "asc" }]);
    t.dispose();
});

test("sort: plain click cycle on single-column chain stays asc->desc->cleared (legacy)", () => {
    // Single-column chains keep the 3-state legacy cycle: some users rely
    // on a third plain click to fully unsort. The 2-state rule only applies
    // when chain.length > 1.
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.toggleSort("name");
    assert.deepEqual(t.sortChain(), [{ key: "name", dir: "asc" }]);
    t.toggleSort("name");
    assert.deepEqual(t.sortChain(), [{ key: "name", dir: "desc" }]);
    t.toggleSort("name");
    assert.deepEqual(t.sortChain(), []);
    t.dispose();
});

test("sort: clearSort empties the chain", () => {
    const t = createTable({
        rows: ROWS, columns: COLS, getRowId: (r) => r.id,
        initialSort: [{ key: "name", dir: "asc" }]
    });
    assert.equal(t.sortChain().length, 1);
    t.clearSort();
    assert.equal(t.sortChain().length, 0);
    t.dispose();
});

test("sort: respects custom compare", () => {
    const t = createTable({
        rows: [
            { id: 1, version: "1.10.0" },
            { id: 2, version: "1.2.0" },
            { id: 3, version: "1.9.0" }
        ],
        columns: [
            { key: "id" },
            {
                key: "version",
                compare: (a, b) => {
                    const A = a.split(".").map(Number);
                    const B = b.split(".").map(Number);
                    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
                    return 0;
                }
            }
        ],
        getRowId: (r) => r.id
    });
    t.setSort("version", "asc");
    assert.deepEqual(t.visibleRows().map(r => r.id), [2, 3, 1]);
    t.dispose();
});

test("sort: sortable=false column is rejected by toggle/set", () => {
    const t = createTable({
        rows: ROWS,
        columns: [
            { key: "id", sortable: false },
            { key: "name" }
        ],
        getRowId: (r) => r.id
    });
    t.toggleSort("id");
    assert.equal(t.sortChain().length, 0);
    t.setSort("id", "asc"); // setSort doesn't check sortable -- by design,
    // it's the programmatic escape hatch.
    assert.equal(t.sortChain().length, 1);
    t.dispose();
});

test("sort (DOM): clicking header sorts and aria-sort reflects", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    const nameHeader = m.root.querySelector('.lt-header-cell[data-key="name"]');
    assert.ok(nameHeader);
    assert.equal(nameHeader.getAttribute("aria-sort"), "none");

    // Simulate a pure click via pointerdown + pointerup with no movement.
    const win = nameHeader.ownerDocument.defaultView;
    const PointerCtor = win.PointerEvent || win.MouseEvent;
    nameHeader.dispatchEvent(new PointerCtor("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
        clientX: 100, clientY: 10
    }));
    document.dispatchEvent(new PointerCtor("pointerup", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
        clientX: 100, clientY: 10
    }));
    assert.equal(t.sortChain()[0]?.dir, "asc");
    assert.equal(nameHeader.getAttribute("aria-sort"), "ascending");

    m.dispose();
    host.remove();
});

test("sort (DOM): sort arrow indicator updates", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    const sortEl = m.root.querySelector('.lt-header-cell[data-key="value"] .lt-header-sort');
    assert.equal(sortEl.textContent, "");
    t.setSort("value", "asc");
    assert.ok(sortEl.textContent.includes("\u25b2"));
    t.setSort("value", "desc");
    assert.ok(sortEl.textContent.includes("\u25bc"));
    t.clearSort();
    assert.equal(sortEl.textContent, "");

    m.dispose();
    host.remove();
});

test("sort: focused row identity survives sort", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.focusedCell.set({ rowId: 3, columnKey: "name" });
    const before = t.focusedCell();
    t.setSort("name", "desc");
    // Focus signal unchanged: still tracks row id 3.
    assert.deepEqual(t.focusedCell(), before);
    // aria-activedescendant still points to row 3's cell.
    assert.equal(m.root.getAttribute("aria-activedescendant"), t.cellId(3, "name"));

    m.dispose();
    host.remove();
});
