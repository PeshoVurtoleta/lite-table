/**
 * Headless core: validation, reactive shape. No DOM needed for these tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal } from "@zakkster/lite-signal";

import { createTable } from "../Table.js";

const COLS = [
    { key: "id", header: "ID", width: 80 },
    { key: "name", header: "Name", width: 200 }
];

const ROWS = [
    { id: 1, name: "Ada" },
    { id: 2, name: "Bjarne" },
    { id: 3, name: "Coda" }
];

test("createTable: returns expected shape", () => {
    const t = createTable({
        rows: ROWS,
        columns: COLS,
        getRowId: (r) => r.id
    });

    assert.equal(t.columns.length, 2);
    assert.equal(t.rowHeight, 32);
    assert.equal(t.overscan, 4);
    // colTemplate is now a Computed<string>
    assert.equal(typeof t.colTemplate, "function");
    assert.equal(t.colTemplate(), "80px 200px 1fr");
    assert.equal(typeof t.rowsGetter, "function");
    assert.equal(typeof t.getRowId, "function");
    assert.equal(typeof t.cellId, "function");
    assert.equal(t.cellId(42, "name"), "lt_42__name");

    // Column state has reactive signals.
    const c0 = t.columns[0];
    assert.equal(c0.key, "id");
    assert.equal(c0.width(), 80);
    assert.equal(c0.hidden(), false);
    assert.equal(c0.pin(), "none");
    assert.equal(c0.sortable, true);
});

test("createTable: rowCount is a computed of the rows getter", () => {
    const rowsSig = signal(ROWS);
    const t = createTable({
        rows: rowsSig,
        columns: COLS,
        getRowId: (r) => r.id
    });

    assert.equal(t.rowCount(), 3);

    rowsSig.set([...ROWS, { id: 4, name: "Don" }]);
    assert.equal(t.rowCount(), 4);

    rowsSig.set([]);
    assert.equal(t.rowCount(), 0);
});

test("createTable: focusedCell defaults to null and accepts initialFocus", () => {
    const t = createTable({
        rows: ROWS,
        columns: COLS,
        getRowId: (r) => r.id
    });
    assert.equal(t.focusedCell(), null);

    const t2 = createTable({
        rows: ROWS,
        columns: COLS,
        getRowId: (r) => r.id,
        initialFocus: { rowId: 1, columnKey: "name" }
    });
    assert.deepEqual(t2.focusedCell(), { rowId: 1, columnKey: "name" });
});

test("createTable: validates required fields", () => {
    assert.throws(() => createTable(), TypeError);
    assert.throws(() => createTable({}), TypeError);
    assert.throws(
        () => createTable({ rows: ROWS, columns: COLS }),
        /getRowId is required/
    );
    assert.throws(
        () => createTable({ rows: ROWS, columns: [], getRowId: (r) => r.id }),
        /columns must be a non-empty array/
    );
    assert.throws(
        () => createTable({
            rows: ROWS, columns: COLS, getRowId: (r) => r.id, rowHeight: 0
        }),
        /rowHeight must be > 0/
    );
});

test("createTable: accepts static array OR reactive getter for rows", () => {
    const tStatic = createTable({
        rows: ROWS,
        columns: COLS,
        getRowId: (r) => r.id
    });
    assert.equal(tStatic.rowCount(), 3);
    assert.equal(tStatic.rowsGetter().length, 3);

    let arr = [...ROWS];
    const tDynamic = createTable({
        rows: () => arr,
        columns: COLS,
        getRowId: (r) => r.id
    });
    assert.equal(tDynamic.rowCount(), 3);
    arr = [...ROWS, { id: 4, name: "Don" }];
    // No notification because the getter is a plain function, not a signal --
    // the recompute only happens if something invalidates rowCount. The
    // reactive variant is the signal test above. This test documents that
    // a bare function is allowed and acts as a one-shot read.
    assert.equal(tDynamic.rowsGetter().length, 4);
});

test("createTable: column widths default to 120", () => {
    const t = createTable({
        rows: ROWS,
        columns: [{ key: "a" }, { key: "b", width: 50 }],
        getRowId: (r) => r.id
    });
    assert.equal(t.colTemplate(), "120px 50px 1fr");
    assert.equal(t.columns[0].width(), 120);
    assert.equal(t.columns[1].width(), 50);
});

test("createTable: accessor takes precedence over key", () => {
    // Smoke test -- full accessor wiring is tested via mount in dom tests.
    const t = createTable({
        rows: [{ a: 1, b: 2 }],
        columns: [{ key: "sum", accessor: (r) => r.a + r.b }],
        getRowId: (r) => r.a
    });
    assert.equal(typeof t.columns[0].accessor, "function");
});
