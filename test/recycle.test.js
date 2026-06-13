/**
 * Slot recycling and focus model.
 *
 * The load-bearing properties:
 *   - When you scroll, slot DOM nodes do NOT change parents or move in the
 *     tree; only their projected row index (and downstream bindings) mutate.
 *   - aria-activedescendant points to a STRING id (rowId__columnKey). The
 *     element that hosts that id moves between slots as the focused row
 *     scrolls into and out of the window. AT sees a single id reference.
 *   - When the focused row scrolls out of the window, the id is no longer
 *     present in the DOM; aria-activedescendant resolves to nothing. Logical
 *     focus survives in the signal. When the row scrolls back, the id is
 *     re-attached to whichever slot now projects it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom, fireScroll } from "./_setup.js";
setupDom();

const { signal } = await import("@zakkster/lite-signal");
const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

function makeRows(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { id: i, name: "row-" + i };
    return out;
}

const COLS = [
    { key: "id", header: "ID", width: 60 },
    { key: "name", header: "Name", width: 180 }
];

test("scroll: slot DOM nodes are not reparented, only their bindings mutate", () => {
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

    // Snapshot the slot row DOM nodes before scrolling.
    const before = Array.from(m.root.querySelectorAll(".lt-row"));
    const parentBefore = before[0].parentNode;
    assert.ok(before.length > 0);

    // Scroll 5000 rows down.
    fireScroll(m.viewport, 5000 * 32);

    // Same DOM nodes, same parent, same order. Slot pool is identity-stable.
    const after = Array.from(m.root.querySelectorAll(".lt-row"));
    assert.equal(after.length, before.length);
    for (let i = 0; i < after.length; i++) {
        assert.strictEqual(after[i], before[i], "slot " + i + " identity changed");
        assert.strictEqual(after[i].parentNode, parentBefore);
    }

    // But the projected text DID change -- pool now shows ~row-5000.
    // Find any cell whose text starts with "row-5".
    const allCells = m.root.querySelectorAll(".lt-cell");
    let found5k = false;
    for (const c of allCells) {
        if (c.textContent && c.textContent.startsWith("row-5")) {
            found5k = true;
            break;
        }
    }
    assert.ok(found5k, "scrolled pool should project row-5xxx values");

    m.dispose();
    host.remove();
});

test("scroll: cell id follows the row, not the slot", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(1000),
        columns: COLS,
        getRowId: (r) => r.id,
        rowHeight: 32,
        overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    // Row 0 is visible at top initially -- its id should be in the DOM.
    const id0 = t.cellId(0, "name");
    assert.ok(m.root.querySelector("#" + id0), "row 0 name cell should exist");

    // Scroll far away -- row 0 leaves the window.
    fireScroll(m.viewport, 500 * 32);
    assert.equal(m.root.querySelector("#" + id0), null,
        "row 0 name id should be gone from DOM when scrolled out");

    // The slots are now projecting other rows -- their ids should be present.
    const id500 = t.cellId(500, "name");
    assert.ok(m.root.querySelector("#" + id500),
        "row 500 name cell should exist after scroll");

    // Scroll back -- row 0 returns to DOM.
    fireScroll(m.viewport, 0);
    assert.ok(m.root.querySelector("#" + id0),
        "row 0 name cell should reappear when scrolled back");

    m.dispose();
    host.remove();
});

test("focus: aria-activedescendant tracks logical focus, never moves DOM focus", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(1000),
        columns: COLS,
        getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    // No focus initially.
    assert.equal(m.root.getAttribute("aria-activedescendant"), null);
    // No cell should have .is-focused.
    assert.equal(m.root.querySelectorAll(".lt-cell.is-focused").length, 0);

    // Set focus via the signal.
    t.focusedCell.set({ rowId: 3, columnKey: "name" });
    const id3 = t.cellId(3, "name");
    assert.equal(m.root.getAttribute("aria-activedescendant"), id3);
    // The cell with that id is the one with .is-focused (per-cell bindClass).
    const focused = m.root.querySelectorAll(".lt-cell.is-focused");
    assert.equal(focused.length, 1, "exactly one focused cell");
    assert.equal(focused[0].getAttribute("id"), id3);

    // Resolve the id -- it points to a real DOM cell.
    const target = m.root.querySelector("#" + id3);
    assert.ok(target);
    assert.equal(target.textContent, "row-3");

    // Move focus to a different cell.
    const id7 = t.cellId(7, "id");
    t.focusedCell.set({ rowId: 7, columnKey: "id" });
    assert.equal(m.root.getAttribute("aria-activedescendant"), id7);
    const focused2 = m.root.querySelectorAll(".lt-cell.is-focused");
    assert.equal(focused2.length, 1);
    assert.equal(focused2[0].getAttribute("id"), id7,
        "previous focused cell loses the class, new one gains it");

    // Clear focus.
    t.focusedCell.set(null);
    assert.equal(m.root.getAttribute("aria-activedescendant"), null);
    assert.equal(m.root.querySelectorAll(".lt-cell.is-focused").length, 0);

    m.dispose();
    host.remove();
});

test("focus: scrolling focused row out of window leaves logical focus intact", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(1000),
        columns: COLS,
        getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    // Focus row 2 (visible).
    t.focusedCell.set({ rowId: 2, columnKey: "name" });
    const focusedId = t.cellId(2, "name");

    // Confirm the focused cell is in the DOM and has the class.
    let cell = m.root.querySelector("#" + focusedId);
    assert.ok(cell);
    assert.ok(cell.classList.contains("is-focused"));

    // Scroll way down -- row 2 leaves.
    fireScroll(m.viewport, 800 * 32);

    // Logical focus signal: unchanged.
    assert.deepEqual(t.focusedCell(), { rowId: 2, columnKey: "name" });

    // aria-activedescendant still points at the same id (ARIA-permitted
    // dangling reference).
    assert.equal(m.root.getAttribute("aria-activedescendant"), focusedId);

    // No cell currently projects row 2, so no .is-focused in the DOM.
    assert.equal(m.root.querySelectorAll(".lt-cell.is-focused").length, 0,
        "focus class is not held while row is out of pool");

    // The cell with the focused id is not in DOM.
    cell = m.root.querySelector("#" + focusedId);
    assert.equal(cell, null);

    // Scroll back -- the focus class auto-applies once a slot projects row 2.
    fireScroll(m.viewport, 0);
    cell = m.root.querySelector("#" + focusedId);
    assert.ok(cell, "row 2 cell should be in DOM again");
    assert.ok(cell.classList.contains("is-focused"),
        "focus class auto-rehydrates because bindClass re-evaluates");

    m.dispose();
    host.remove();
});

test("focus: filter that removes the focused row leaves focus signal pending, restore on re-add", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const rowsSig = signal(makeRows(20));
    const t = createTable({
        rows: rowsSig, columns: COLS, getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    t.focusedCell.set({ rowId: 5, columnKey: "name" });
    const focusedId = t.cellId(5, "name");
    let focusedCell = m.root.querySelector("#" + focusedId);
    assert.ok(focusedCell);
    assert.ok(focusedCell.classList.contains("is-focused"));

    // Filter row 5 out (in real app this would be a derived signal).
    rowsSig.set(makeRows(20).filter((r) => r.id !== 5));

    // Logical focus survives; id is no longer in DOM, no cell has class.
    assert.deepEqual(t.focusedCell(), { rowId: 5, columnKey: "name" });
    assert.equal(m.root.getAttribute("aria-activedescendant"), focusedId);
    assert.equal(m.root.querySelector("#" + focusedId), null);
    assert.equal(m.root.querySelectorAll(".lt-cell.is-focused").length, 0);

    // Re-add -- the slot projecting row 5 takes id="lt_5__name", the
    // bindClass re-evaluates and adds .is-focused.
    rowsSig.set(makeRows(20));
    focusedCell = m.root.querySelector("#" + focusedId);
    assert.ok(focusedCell);
    assert.ok(focusedCell.classList.contains("is-focused"));

    m.dispose();
    host.remove();
});

test("scroll: pool size stays bounded across a long scroll", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({
        rows: makeRows(50_000),
        columns: COLS,
        getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    const start = m.poolSize();
    fireScroll(m.viewport, 10_000 * 32);
    fireScroll(m.viewport, 25_000 * 32);
    fireScroll(m.viewport, 49_000 * 32);
    fireScroll(m.viewport, 0);
    const end = m.poolSize();
    assert.equal(start, end, "pool size must not grow on scroll");
});
