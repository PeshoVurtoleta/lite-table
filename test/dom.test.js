/**
 * DOM mount: structure, ARIA roles, reactive cell text, header layout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom, setClientHeight, fireScroll } from "./_setup.js";
setupDom();

const { signal } = await import("@zakkster/lite-signal");
const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

function makeRows(n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { id: i, name: "row-" + i, value: i * 10 };
    return out;
}

const COLS = [
    { key: "id", header: "ID", width: 60 },
    { key: "name", header: "Name", width: 180 },
    { key: "value", header: "Value", width: 100 }
];

test("mount: builds [role=grid] container with header and viewport", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(10), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    assert.equal(m.root.getAttribute("role"), "grid");
    assert.equal(m.root.getAttribute("tabindex"), "0");
    assert.equal(m.root.getAttribute("aria-colcount"), "3");
    assert.equal(m.root.getAttribute("aria-rowcount"), "11"); // 10 rows + header

    const header = m.root.querySelector(".lt-header");
    assert.ok(header);
    assert.equal(header.getAttribute("role"), "row");
    const headerCells = header.querySelectorAll(".lt-header-cell");
    assert.equal(headerCells.length, 3);
    assert.equal(headerCells[0].getAttribute("role"), "columnheader");
    assert.equal(headerCells[0].textContent, "ID");
    assert.equal(headerCells[1].textContent, "Name");
    assert.equal(headerCells[2].textContent, "Value");

    m.dispose();
    host.remove();
});

test("mount: cells render with role=gridcell and reactive text", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const rowsSig = signal(makeRows(5));
    const t = createTable({ rows: rowsSig, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t, { initialViewportHeight: 200 });

    const cells = m.root.querySelectorAll(".lt-cell");
    // Pool size for 200 / 32 = 7, plus overscan 4*2 + 1 = 9 -> 16 slots.
    // Each slot has 3 cells -> 48 cells. Some are hidden (slot index > 4).
    assert.ok(cells.length >= 15); // at least 5 visible rows * 3 cols

    // Find visible cell for row 0, col "name"
    const cellId = t.cellId(0, "name");
    const c0 = m.root.querySelector("#" + cellId);
    assert.ok(c0, "cell with id " + cellId + " should exist");
    assert.equal(c0.getAttribute("role"), "gridcell");
    assert.equal(c0.textContent, "row-0");

    // Mutate row data (new array reference) -- text should update reactively
    rowsSig.set(makeRows(5).map((r) => ({ ...r, name: r.name.toUpperCase() })));
    const c0after = m.root.querySelector("#" + cellId);
    assert.equal(c0after.textContent, "ROW-0");

    m.dispose();
    host.remove();
});

test("mount: pool size is bounded by viewport, not dataset", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    // 100k rows, tiny viewport. Pool must be tiny.
    const t = createTable({
        rows: makeRows(100_000),
        columns: COLS,
        getRowId: (r) => r.id,
        rowHeight: 32,
        overscan: 4
    });
    const m = mountTable(host, t, { initialViewportHeight: 320 });

    const pool = m.poolSize();
    // ceil(320/32) + 4*2 + 1 = 10 + 9 = 19. Anything sub-50 proves we are not
    // materializing the dataset.
    assert.ok(pool < 50, "pool size should be small, got " + pool);
    assert.ok(pool >= 10, "pool size should cover viewport, got " + pool);

    // DOM slot count matches pool reporting.
    const slotRows = m.root.querySelectorAll(".lt-row");
    assert.equal(slotRows.length, pool);

    m.dispose();
    host.remove();
});

test("mount: inner sizer height equals dataset total", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const rowsSig = signal(makeRows(100));
    const t = createTable({
        rows: rowsSig, columns: COLS, getRowId: (r) => r.id, rowHeight: 32
    });
    const m = mountTable(host, t);

    const inner = m.root.querySelector(".lt-inner");
    assert.equal(inner.style.height, "3200px"); // 100 * 32

    rowsSig.set(makeRows(250));
    assert.equal(inner.style.height, "8000px");

    m.dispose();
    host.remove();
});

test("mount: hidden slots overshooting the dataset are display:none", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    // Only 3 rows, but pool will allocate many. Excess slots must be hidden.
    const t = createTable({
        rows: makeRows(3), columns: COLS, getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 400 });

    const slotRows = m.root.querySelectorAll(".lt-row");
    let visible = 0, hidden = 0;
    for (const r of slotRows) {
        if (r.style.display === "none") hidden++;
        else visible++;
    }
    assert.equal(visible, 3);
    assert.ok(hidden > 0);

    m.dispose();
    host.remove();
});

test("mount: accessor columns compute reactively", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const rowsSig = signal([
        { id: 1, a: 2, b: 3 },
        { id: 2, a: 5, b: 7 }
    ]);
    const t = createTable({
        rows: rowsSig,
        columns: [
            { key: "id", header: "ID", width: 50 },
            { key: "sum", header: "Sum", width: 80, accessor: (r) => r.a + r.b }
        ],
        getRowId: (r) => r.id
    });
    const m = mountTable(host, t, { initialViewportHeight: 200 });

    const c1sum = m.root.querySelector("#" + t.cellId(1, "sum"));
    const c2sum = m.root.querySelector("#" + t.cellId(2, "sum"));
    assert.equal(c1sum.textContent, "5");
    assert.equal(c2sum.textContent, "12");

    rowsSig.set([
        { id: 1, a: 10, b: 10 },
        { id: 2, a: 100, b: 1 }
    ]);
    assert.equal(c1sum.textContent, "20");
    assert.equal(c2sum.textContent, "101");

    m.dispose();
    host.remove();
});

test("dispose: removes root and is idempotent", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    assert.equal(host.children.length, 1);
    m.dispose();
    assert.equal(host.children.length, 0);
    m.dispose(); // second call must not throw
    host.remove();
});

test("click: pointerdown does not preventDefault (text selection + touch scroll preserved)", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    const cell = m.root.querySelector("#" + t.cellId(2, "name"));
    assert.ok(cell);

    // Dispatch a real pointerdown and observe whether defaultPrevented got
    // flipped. The browser uses the default for both focus traversal AND
    // initiating text selection (mouse) / scroll gestures (touch); killing
    // it disables drag-to-select on mouse and may interfere with scrolling
    // on touch.
    const win = cell.ownerDocument.defaultView;
    const EventCtor = win.PointerEvent || win.MouseEvent;
    const ev = new EventCtor("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        isPrimary: true,
        pointerType: "mouse"
    });
    cell.dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, false,
        "pointerdown must not preventDefault");

    // But focus state IS updated -- the signal moved.
    assert.deepEqual(t.focusedCell(), { rowId: 2, columnKey: "name" });

    m.dispose();
    host.remove();
});

test("click: non-primary pointer (multi-touch second finger) does not steal focus", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    // Focus row 2 first.
    t.focusedCell.set({ rowId: 2, columnKey: "name" });

    const cell = m.root.querySelector("#" + t.cellId(4, "id"));
    assert.ok(cell);

    const win = cell.ownerDocument.defaultView;
    const EventCtor = win.PointerEvent || win.MouseEvent;
    const ev = new EventCtor("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        isPrimary: false, // second touch in a multi-touch gesture
        pointerType: "touch"
    });
    cell.dispatchEvent(ev);

    // Focus must NOT have moved to row 4.
    assert.deepEqual(t.focusedCell(), { rowId: 2, columnKey: "name" });

    m.dispose();
    host.remove();
});

test("mount: root has height:100% so it fills its host instead of collapsing", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: makeRows(5), columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    // Read the rule we inject. happy-dom does not implement layout, so we
    // can't assert pixel heights; we assert the CSS declaration is present.
    const styleEl = document.head.querySelector('style[data-lt="core"]');
    assert.ok(styleEl);
    assert.ok(styleEl.textContent.includes("height:100%"),
        "default stylesheet must set .lt-root height:100% so it fills the host");

    m.dispose();
    host.remove();
});
