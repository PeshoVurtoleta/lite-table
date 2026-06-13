/**
 * Keyboard navigation. Arrow keys move focus, Home/End jump within a row,
 * Ctrl+Home/End jump to grid corners, PgUp/PgDn jump by viewport rows,
 * Space toggles selection, Escape clears selection, Ctrl+A selects all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./_setup.js";
setupDom();

const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

const COLS = [
    { key: "a", header: "A", width: 80 },
    { key: "b", header: "B", width: 80 },
    { key: "c", header: "C", width: 80 }
];

const makeRows = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: i, a: "a" + i, b: "b" + i, c: "c" + i }));

function keydown(root, key, mods) {
    mods = mods || {};
    const ev = new root.ownerDocument.defaultView.KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key,
        ctrlKey: !!mods.ctrlKey,
        shiftKey: !!mods.shiftKey,
        metaKey: !!mods.metaKey
    });
    // Set target to root manually since happy-dom dispatches preserve it.
    Object.defineProperty(ev, "target", { value: root, configurable: true });
    root.dispatchEvent(ev);
    return ev;
}

test("nav: ArrowDown moves focus to next row", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.focusedCell.set({ rowId: 0, columnKey: "a" });
    keydown(m.root, "ArrowDown");
    assert.deepEqual(t.focusedCell(), { rowId: 1, columnKey: "a" });

    m.dispose();
    host.remove();
});

test("nav: ArrowUp clamps at top", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.focusedCell.set({ rowId: 0, columnKey: "a" });
    keydown(m.root, "ArrowUp");
    assert.equal(t.focusedCell().rowId, 0);
    m.dispose();
    host.remove();
});

test("nav: ArrowRight / ArrowLeft move between visible columns", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.focusedCell.set({ rowId: 0, columnKey: "a" });
    keydown(m.root, "ArrowRight");
    assert.equal(t.focusedCell().columnKey, "b");
    keydown(m.root, "ArrowRight");
    assert.equal(t.focusedCell().columnKey, "c");
    keydown(m.root, "ArrowRight"); // clamp
    assert.equal(t.focusedCell().columnKey, "c");
    keydown(m.root, "ArrowLeft");
    assert.equal(t.focusedCell().columnKey, "b");
    m.dispose();
    host.remove();
});

test("nav: Home / End jump within row", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.focusedCell.set({ rowId: 3, columnKey: "b" });
    keydown(m.root, "Home");
    assert.deepEqual(t.focusedCell(), { rowId: 3, columnKey: "a" });
    keydown(m.root, "End");
    assert.deepEqual(t.focusedCell(), { rowId: 3, columnKey: "c" });
    m.dispose();
    host.remove();
});

test("nav: Ctrl+Home / Ctrl+End jump to grid corners", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.focusedCell.set({ rowId: 5, columnKey: "b" });
    keydown(m.root, "Home", { ctrlKey: true });
    assert.deepEqual(t.focusedCell(), { rowId: 0, columnKey: "a" });
    keydown(m.root, "End", { ctrlKey: true });
    assert.deepEqual(t.focusedCell(), { rowId: 9, columnKey: "c" });
    m.dispose();
    host.remove();
});

test("nav: PageUp / PageDown jump by viewport rows", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(1000), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t, { initialViewportHeight: 320 }); // 10 rows

    t.focusedCell.set({ rowId: 0, columnKey: "a" });
    keydown(m.root, "PageDown");
    // Page size derived from clientHeight or initialViewportHeight fallback.
    // In happy-dom clientHeight is 0, so page size uses initialVH fallback.
    // Page size = floor(320 / 32) = 10.
    assert.equal(t.focusedCell().rowId, 10);
    keydown(m.root, "PageUp");
    assert.equal(t.focusedCell().rowId, 0);

    m.dispose();
    host.remove();
});

test("nav: Space toggles selection of focused row", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.focusedCell.set({ rowId: 3, columnKey: "a" });
    keydown(m.root, " "); // selectRow set-mode
    assert.deepEqual(t.selectedIds(), [3]);
    m.dispose();
    host.remove();
});

test("nav: Escape clears selection", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    t.selectRow(2);
    t.selectRow(4, "add");
    keydown(m.root, "Escape");
    assert.equal(t.selectedCount(), 0);
    m.dispose();
    host.remove();
});

test("nav: Ctrl+A selects all", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(20), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);
    keydown(m.root, "a", { ctrlKey: true });
    assert.equal(t.selectedCount(), 20);
    m.dispose();
    host.remove();
});

test("nav: moveFocus skips hidden columns", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.setColumnHidden("b", true);
    t.focusedCell.set({ rowId: 0, columnKey: "a" });
    keydown(m.root, "ArrowRight");
    // 'b' is hidden -> next visible column is 'c'.
    assert.equal(t.focusedCell().columnKey, "c");

    m.dispose();
    host.remove();
});

test("nav: moveFocus follows sort order", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const rows = [
        { id: 1, a: "z", b: "1", c: "1" },
        { id: 2, a: "a", b: "2", c: "2" },
        { id: 3, a: "m", b: "3", c: "3" }
    ];
    const t = createTable({ rows, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.setSort("a", "asc"); // visible order: id 2, 3, 1
    t.focusedCell.set({ rowId: 2, columnKey: "a" });
    keydown(m.root, "ArrowDown");
    assert.equal(t.focusedCell().rowId, 3);
    keydown(m.root, "ArrowDown");
    assert.equal(t.focusedCell().rowId, 1);

    m.dispose();
    host.remove();
});
