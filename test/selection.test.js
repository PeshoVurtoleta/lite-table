/**
 * Selection: set/add/toggle/range modes, anchor tracking, selectAll, clear,
 * is-selected class on row, aria-selected attribute.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./_setup.js";
setupDom();

const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

const COLS = [
    { key: "id", header: "ID", width: 60 },
    { key: "name", header: "Name", width: 160 }
];

const makeRows = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: i, name: "row-" + i }));

test("selection: starts empty", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    assert.equal(t.selectedCount(), 0);
    assert.equal(t.selectionAnchor(), null);
    t.dispose();
});

test("selection: 'set' replaces", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2);
    assert.deepEqual(t.selectedIds(), [2]);
    t.selectRow(4);
    assert.deepEqual(t.selectedIds(), [4]);
    t.dispose();
});

test("selection: 'add' accumulates", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(1, "add");
    t.selectRow(3, "add");
    t.selectRow(4, "add");
    assert.deepEqual(t.selectedIds().sort(), [1, 3, 4]);
    t.dispose();
});

test("selection: 'toggle' adds and removes", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2, "toggle");
    assert.deepEqual(t.selectedIds(), [2]);
    t.selectRow(2, "toggle");
    assert.deepEqual(t.selectedIds(), []);
    t.dispose();
});

test("selection: 'range' selects from anchor to target inclusive", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2);          // anchor = 2
    t.selectRow(6, "range"); // range 2..6
    assert.deepEqual(t.selectedIds().sort((a, b) => a - b), [2, 3, 4, 5, 6]);
    t.dispose();
});

test("selection: 'range' works backward (target before anchor)", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(7);
    t.selectRow(3, "range");
    assert.deepEqual(t.selectedIds().sort((a, b) => a - b), [3, 4, 5, 6, 7]);
    t.dispose();
});

test("selection: 'range' without anchor falls back to set", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2, "range");
    assert.deepEqual(t.selectedIds(), [2]);
    t.dispose();
});

test("selection: selectAll covers visibleRows only", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    assert.equal(t.selectedCount(), 5);
    t.dispose();
});

test("selection: clearSelection resets selection + anchor", () => {
    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2);
    t.clearSelection();
    assert.equal(t.selectedCount(), 0);
    assert.equal(t.selectionAnchor(), null);
    t.dispose();
});

test("selection (DOM): selected row gets .is-selected class and aria-selected", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.selectRow(2);
    // Find the slot row currently projecting row id 2.
    const cell = m.root.querySelector("#" + t.cellId(2, "name"));
    const rowEl = cell.closest(".lt-row");
    assert.ok(rowEl.classList.contains("is-selected"));
    assert.equal(rowEl.getAttribute("aria-selected"), "true");

    // Unselected row reads "false".
    const other = m.root.querySelector("#" + t.cellId(3, "name")).closest(".lt-row");
    assert.equal(other.getAttribute("aria-selected"), "false");

    t.clearSelection();
    assert.ok(!rowEl.classList.contains("is-selected"));
    assert.equal(rowEl.getAttribute("aria-selected"), "false");

    m.dispose();
    host.remove();
});

test("selection (DOM): shift-click extends from anchor", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    // First click on row 1.
    const cell1 = m.root.querySelector("#" + t.cellId(1, "name"));
    const win = cell1.ownerDocument.defaultView;
    const P = win.PointerEvent || win.MouseEvent;
    cell1.dispatchEvent(new P("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true
    }));
    assert.deepEqual(t.selectedIds(), [1]);

    // Shift-click on row 4.
    const cell4 = m.root.querySelector("#" + t.cellId(4, "name"));
    cell4.dispatchEvent(new P("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
        shiftKey: true
    }));
    assert.deepEqual(t.selectedIds().sort((a, b) => a - b), [1, 2, 3, 4]);

    m.dispose();
    host.remove();
});

test("selection (DOM): ctrl-click toggles", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    const cell1 = m.root.querySelector("#" + t.cellId(1, "name"));
    const cell3 = m.root.querySelector("#" + t.cellId(3, "name"));
    const win = cell1.ownerDocument.defaultView;
    const P = win.PointerEvent || win.MouseEvent;

    cell1.dispatchEvent(new P("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true
    }));
    cell3.dispatchEvent(new P("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
        ctrlKey: true
    }));
    assert.deepEqual(t.selectedIds().sort((a, b) => a - b), [1, 3]);
    // Ctrl-click again removes.
    cell3.dispatchEvent(new P("pointerdown", {
        bubbles: true, cancelable: true, button: 0, isPrimary: true,
        ctrlKey: true
    }));
    assert.deepEqual(t.selectedIds(), [1]);

    m.dispose();
    host.remove();
});

test("selection: selectAll is O(1) -- flips to all-mode, empty blacklist", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    // State is the predicate, not 10 enumerated IDs.
    const sel = t.selection();
    assert.equal(sel.mode, "all");
    assert.equal(sel.set.size, 0);
    // Predicate returns true for every row, including IDs that don't yet exist.
    for (const r of makeRows(10)) assert.equal(t.isSelected(r.id), true);
    assert.equal(t.isSelected(999), true); // hypothetical future row
    assert.equal(t.selectedCount(), 10);
    t.dispose();
});

test("selection: toggle in all-mode adds to blacklist (deselects)", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    t.selectRow(3, "toggle"); // deselect row 3 -> blacklist it
    assert.equal(t.isSelected(3), false);
    assert.equal(t.isSelected(2), true);
    assert.equal(t.isSelected(4), true);
    assert.equal(t.selectedCount(), 9);
    const sel = t.selection();
    assert.equal(sel.mode, "all");
    assert.deepEqual([...sel.set], [3]);
    // Toggle back: removes from blacklist.
    t.selectRow(3, "toggle");
    assert.equal(t.isSelected(3), true);
    assert.equal(t.selectedCount(), 10);
    t.dispose();
});

test("selection: range-select from all-mode collapses to whitelist of range", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    t.selectRow(2, "set"); // anchor = 2
    t.selectRowRange(2, 5);
    const sel = t.selection();
    assert.equal(sel.mode, "whitelist"); // shift-click switches back
    assert.deepEqual(t.selectedIds().sort((a,b)=>a-b), [2, 3, 4, 5]);
    t.dispose();
});

test("selection: selectedIds and selectedRows materialize against current visibleRows by default", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectRow(2, "set");
    t.selectRow(5, "add");
    t.selectRow(8, "add");
    assert.deepEqual(t.selectedIds().sort((a,b)=>a-b), [2, 5, 8]);
    assert.equal(t.selectedRows().length, 3);
    t.dispose();
});

test("selection: selectedIds against alternate source (e.g. unsorted master for export)", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    // Master list of 20 rows (only 10 are in the table). selectedIds against
    // this source must walk all 20 and run the predicate -- in all-mode every
    // row matches (no blacklist), so we get all 20 IDs back.
    const master = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const ids = t.selectedIds(master);
    assert.equal(ids.length, 20);
    assert.deepEqual(ids.sort((a,b)=>a-b), [...Array(20).keys()]);
    t.dispose();
});

test("selection: forEachSelected streams without allocating the full list", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    t.selectAll();
    t.selectRow(5, "toggle"); // deselect 5
    const seen = [];
    t.forEachSelected((row, id, idx) => { seen.push(id); });
    assert.equal(seen.length, 9);
    assert.equal(seen.includes(5), false);
    // Early termination: return false to stop.
    const first3 = [];
    t.forEachSelected((row, id) => {
        first3.push(id);
        if (first3.length >= 3) return false;
    });
    assert.equal(first3.length, 3);
    t.dispose();
});

test("selection: selectedCount is reactive O(1)", () => {
    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const seen = [];
    const dispose = t._scope.effect(() => { seen.push(t.selectedCount()); });
    assert.deepEqual(seen, [0]);
    t.selectRow(1, "set");        seen.length = 0; t.selectRow(1, "set");        // no-op? actually replaces with {1}
    t.selectRow(2, "add");
    assert.equal(t.selectedCount(), 2);
    t.selectAll();
    assert.equal(t.selectedCount(), 10);
    t.selectRow(3, "toggle"); // deselect in all-mode
    assert.equal(t.selectedCount(), 9);
    t.clearSelection();
    assert.equal(t.selectedCount(), 0);
    t.dispose();
});
