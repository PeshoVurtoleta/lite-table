// test/export.test.js -- M1.1 export methods
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable } from "../Table.js";

const rows = [
    { id: 1, name: "Alice",   email: "alice@example.com",   value: 100 },
    { id: 2, name: "Bob",     email: "bob@example.com",     value: 200 },
    { id: 3, name: "Charlie", email: "charlie@example.com", value: 50  },
    { id: 4, name: 'O"Brien', email: "ob@example.com",      value: 75  },
    { id: 5, name: "comma,",  email: "c@example.com",       value: 99  },
    { id: 6, name: "multi\nline", email: "m@example.com",   value: 30  },
];

const cols = [
    { key: "id", width: 60 },
    { key: "name", width: 150 },
    { key: "email", width: 220 },
    { key: "value", width: 100, compare: (a, b) => a - b },
];

function mk() {
    return createTable({ rows, columns: cols, getRowId: r => r.id });
}

// =====================================================================
// exportCsv: basic shape
// =====================================================================

test("exportCsv: default returns CSV string with header + visible rows", () => {
    const t = mk();
    const out = t.exportCsv();
    const lines = out.split("\r\n");
    assert.equal(lines[0], "id,name,email,value");
    assert.equal(lines.length, 7);  // 1 header + 6 rows
    assert.equal(lines[1], "1,Alice,alice@example.com,100");
    t.dispose();
});

test("exportCsv: headers:false omits header row", () => {
    const t = mk();
    const out = t.exportCsv({ headers: false });
    const lines = out.split("\r\n");
    assert.equal(lines.length, 6);
    assert.equal(lines[0], "1,Alice,alice@example.com,100");
    t.dispose();
});

test("exportCsv: custom delimiter", () => {
    const t = mk();
    const out = t.exportCsv({ delimiter: "\t" });
    const lines = out.split("\r\n");
    assert.equal(lines[0], "id\tname\temail\tvalue");
    assert.equal(lines[1], "1\tAlice\talice@example.com\t100");
    t.dispose();
});

test("exportCsv: semicolon delimiter (European regional)", () => {
    const t = mk();
    const out = t.exportCsv({ delimiter: ";" });
    assert.ok(out.startsWith("id;name;email;value"));
    t.dispose();
});

test("exportCsv: LF newline", () => {
    const t = mk();
    const out = t.exportCsv({ newline: "\n" });
    assert.ok(!out.includes("\r"));
    // The data contains a row with an embedded newline, which gets
    // QUOTED. Naive split on "\n" would over-count; verify structure by
    // checking the embedded LF lives inside quotes.
    const embeddedIdx = out.indexOf("multi\nline");
    assert.ok(embeddedIdx > 0);
    // The character before "multi" must be the opening quote of the field.
    assert.equal(out[embeddedIdx - 1], '"');
    t.dispose();
});

test("exportCsv: BOM prefix", () => {
    const t = mk();
    const out = t.exportCsv({ bom: true });
    assert.equal(out.charCodeAt(0), 0xFEFF);
    t.dispose();
});

// =====================================================================
// CSV escaping (RFC 4180)
// =====================================================================

test("exportCsv: quotes field containing comma", () => {
    const t = mk();
    const out = t.exportCsv();
    // row 5: name = "comma,"  -> "comma,"
    assert.ok(out.includes('"comma,"'));
    t.dispose();
});

test("exportCsv: doubles embedded quotes", () => {
    const t = mk();
    const out = t.exportCsv();
    // row 4: name = O"Brien -> "O""Brien"
    assert.ok(out.includes('"O""Brien"'));
    t.dispose();
});

test("exportCsv: quotes field containing newline", () => {
    const t = mk();
    const out = t.exportCsv({ newline: "\r\n" });
    // row 6 has "multi\nline" which must be quoted
    assert.ok(out.includes('"multi\nline"'));
    t.dispose();
});

test("exportCsv: empty strings stay unquoted", () => {
    const t = createTable({
        rows: [{ id: 1, name: "", value: 0 }],
        columns: [{ key: "id" }, { key: "name" }, { key: "value" }],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    // "1,,0" -- middle field is empty, not quoted
    assert.equal(out.split("\r\n")[1], "1,,0");
    t.dispose();
});

test("exportCsv: null/undefined become empty fields", () => {
    const t = createTable({
        rows: [{ id: 1, name: null, value: undefined }],
        columns: [{ key: "id" }, { key: "name" }, { key: "value" }],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out.split("\r\n")[1], "1,,");
    t.dispose();
});

test("exportCsv: custom quote char", () => {
    const t = createTable({
        rows: [{ id: 1, name: "hello,world" }],
        columns: [{ key: "id" }, { key: "name" }],
        getRowId: r => r.id,
    });
    const out = t.exportCsv({ quote: "'" });
    assert.equal(out.split("\r\n")[1], "1,'hello,world'");
    t.dispose();
});

test("exportCsv: numbers are stringified naturally", () => {
    const t = createTable({
        rows: [{ id: 1, n: 3.14, big: 1234567890 }],
        columns: [{ key: "id" }, { key: "n" }, { key: "big" }],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out.split("\r\n")[1], "1,3.14,1234567890");
    t.dispose();
});

// =====================================================================
// Row source selection
// =====================================================================

test("exportCsv: rows=visible follows current sort", () => {
    const t = mk();
    t.setSort("value", "asc");
    const out = t.exportCsv();
    const lines = out.split("\r\n");
    // sorted ascending by value: 30, 50, 75, 99, 100, 200
    assert.match(lines[1], /,30$/);
    assert.match(lines[2], /,50$/);
    assert.match(lines[6], /,200$/);
    t.dispose();
});

test("exportCsv: rows=all ignores sort, uses master order", () => {
    const t = mk();
    t.setSort("value", "asc");
    const out = t.exportCsv({ rows: "all" });
    const lines = out.split("\r\n");
    assert.match(lines[1], /^1,/);  // master order: 1,2,3,4,5,6
    assert.match(lines[6], /^6,/);
    t.dispose();
});

test("exportCsv: rows=selected exports only selected rows", () => {
    const t = mk();
    t.selectRow(2);
    t.selectRow(4, "add");
    const out = t.exportCsv({ rows: "selected" });
    const lines = out.split("\r\n");
    assert.equal(lines.length, 3);  // 1 header + 2 selected
    assert.match(lines[1], /^2,Bob,/);
    assert.match(lines[2], /^4,/);
    t.dispose();
});

test("exportCsv: rows=selected with selectAll exports all rows", () => {
    const t = mk();
    t.selectAll();
    const out = t.exportCsv({ rows: "selected" });
    const lines = out.split("\r\n");
    assert.equal(lines.length, 7);  // 1 header + 6 rows
    t.dispose();
});

test("exportCsv: rows accepts explicit array", () => {
    const t = mk();
    const snapshot = [rows[0], rows[2]];
    const out = t.exportCsv({ rows: snapshot });
    const lines = out.split("\r\n");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^1,Alice,/);
    assert.match(lines[2], /^3,Charlie,/);
    t.dispose();
});

// =====================================================================
// Column selection
// =====================================================================

test("exportCsv: columns=visible follows column order + hidden state", () => {
    const t = mk();
    t.setColumnHidden("email", true);
    t.setColumnOrder(["name", "id", "email", "value"]);
    const out = t.exportCsv();
    const lines = out.split("\r\n");
    // hidden email is dropped; remaining order: name, id, value
    assert.equal(lines[0], "name,id,value");
    assert.match(lines[1], /^Alice,1,100$/);
    t.dispose();
});

test("exportCsv: columns=all includes hidden columns in declaration order", () => {
    const t = mk();
    t.setColumnHidden("email", true);
    t.setColumnOrder(["name", "id", "email", "value"]);
    const out = t.exportCsv({ columns: "all" });
    const lines = out.split("\r\n");
    assert.equal(lines[0], "id,name,email,value");
    t.dispose();
});

test("exportCsv: columns array projects + reorders explicitly", () => {
    const t = mk();
    const out = t.exportCsv({ columns: ["email", "id"] });
    const lines = out.split("\r\n");
    assert.equal(lines[0], "email,id");
    assert.equal(lines[1], "alice@example.com,1");
    t.dispose();
});

test("exportCsv: columns array silently drops unknown keys", () => {
    const t = mk();
    const out = t.exportCsv({ columns: ["id", "nonexistent", "name"] });
    assert.equal(out.split("\r\n")[0], "id,name");
    t.dispose();
});

// =====================================================================
// Accessors + header overrides
// =====================================================================

test("exportCsv: column accessor is honored", () => {
    const t = createTable({
        rows: [{ id: 1, first: "Ada", last: "Lovelace" }],
        columns: [
            { key: "id" },
            { key: "fullName", accessor: r => r.first + " " + r.last },
        ],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out.split("\r\n")[1], "1,Ada Lovelace");
    t.dispose();
});

test("exportCsv: column header override appears in CSV header", () => {
    const t = createTable({
        rows: [{ id: 1, n: "x" }],
        columns: [
            { key: "id", header: "Row ID" },
            { key: "n", header: "Display Name" },
        ],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out.split("\r\n")[0], "Row ID,Display Name");
    t.dispose();
});

test("exportCsv: header text gets CSV-escaped too", () => {
    const t = createTable({
        rows: [{ id: 1 }],
        columns: [
            { key: "id", header: "ID, original" },
        ],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out.split("\r\n")[0], '"ID, original"');
    t.dispose();
});

// =====================================================================
// formatter hook
// =====================================================================

test("exportCsv: formatter receives row + col, can format dates/numbers", () => {
    const t = mk();
    const out = t.exportCsv({
        columns: ["id", "value"],
        formatter: (row, col) => {
            if (col.key === "value") return "$" + row.value.toFixed(2);
            return row[col.key];
        },
    });
    const lines = out.split("\r\n");
    assert.equal(lines[1], "1,$100.00");
    t.dispose();
});

// =====================================================================
// exportJson
// =====================================================================

test("exportJson: default returns JSON string of visible rows projected to visible cols", () => {
    const t = mk();
    const out = t.exportJson();
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 6);
    assert.deepEqual(Object.keys(parsed[0]), ["id", "name", "email", "value"]);
    assert.equal(parsed[0].id, 1);
    t.dispose();
});

test("exportJson: format=array returns array directly (no JSON.stringify)", () => {
    const t = mk();
    const out = t.exportJson({ format: "array" });
    assert.ok(Array.isArray(out));
    assert.equal(typeof out, "object");
    assert.deepEqual(out[0], { id: 1, name: "Alice", email: "alice@example.com", value: 100 });
    t.dispose();
});

test("exportJson: columns=all+no formatter returns raw row references (fast path)", () => {
    const t = mk();
    const out = t.exportJson({ columns: "all", format: "array" });
    // Should be a shallow copy of rows[] (slice), so identity per row preserved
    assert.equal(out[0], rows[0]);
    assert.equal(out[5], rows[5]);
    t.dispose();
});

test("exportJson: indent option", () => {
    const t = createTable({
        rows: [{ id: 1, name: "A" }],
        columns: [{ key: "id" }, { key: "name" }],
        getRowId: r => r.id,
    });
    const out = t.exportJson({ indent: 2 });
    assert.ok(out.includes("\n"));
    assert.ok(out.includes("  "));
    t.dispose();
});

test("exportJson: respects column projection via array", () => {
    const t = mk();
    const out = t.exportJson({ columns: ["id", "email"], format: "array" });
    assert.deepEqual(Object.keys(out[0]), ["id", "email"]);
    assert.equal(out[0].email, "alice@example.com");
    t.dispose();
});

test("exportJson: respects column accessor", () => {
    const t = createTable({
        rows: [{ id: 1, first: "Ada", last: "Lovelace" }],
        columns: [
            { key: "id" },
            { key: "fullName", accessor: r => r.first + " " + r.last },
        ],
        getRowId: r => r.id,
    });
    const out = t.exportJson({ format: "array" });
    assert.equal(out[0].fullName, "Ada Lovelace");
    t.dispose();
});

test("exportJson: rows=selected materializes the selection", () => {
    const t = mk();
    t.selectRow(1);
    t.selectRow(3, "add");
    const out = t.exportJson({ rows: "selected", format: "array" });
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 1);
    assert.equal(out[1].id, 3);
    t.dispose();
});

test("exportJson: formatter runs per-cell", () => {
    const t = mk();
    const out = t.exportJson({
        format: "array",
        formatter: (row, col) => col.key === "value" ? row.value * 2 : row[col.key],
    });
    assert.equal(out[0].value, 200);
    assert.equal(out[1].value, 400);
    t.dispose();
});

test("exportJson: indent=0 produces compact single-line output", () => {
    const t = mk();
    const out = t.exportJson({ indent: 0 });
    assert.ok(!out.includes("\n"));
    t.dispose();
});

// =====================================================================
// Edge cases
// =====================================================================

test("exportCsv: empty row source produces only header row", () => {
    const t = createTable({
        rows: [],
        columns: [{ key: "id" }, { key: "name" }],
        getRowId: r => r.id,
    });
    const out = t.exportCsv();
    assert.equal(out, "id,name");
    t.dispose();
});

test("exportJson: empty row source produces '[]'", () => {
    const t = createTable({
        rows: [],
        columns: [{ key: "id" }],
        getRowId: r => r.id,
    });
    assert.equal(t.exportJson(), "[]");
    assert.deepEqual(t.exportJson({ format: "array" }), []);
    t.dispose();
});

test("exportCsv: pre-dispose is the supported window; post-dispose is undefined", () => {
    // Documented contract: dispose() releases all reactive nodes. After
    // dispose, computed reads return undefined (stale gen). Callers should
    // export BEFORE calling dispose. We don't attempt post-dispose recovery.
    const t = mk();
    const out = t.exportCsv();
    assert.ok(out.length > 0);
    t.dispose();
    // No assertion on post-dispose behaviour -- it's outside the contract.
});

test("exportCsv + sort interaction: sort then export visible matches what user sees", () => {
    const t = mk();
    t.setSort("value", "desc");
    const out = t.exportCsv();
    const lines = out.split("\r\n");
    // desc order: 200, 100, 99, 75, 50, 30
    assert.match(lines[1], /,200$/);
    assert.match(lines[6], /,30$/);
    t.dispose();
});

test("exportJson + multi-column sort matches visible order", () => {
    const t = mk();
    t.setSort("value", "asc");
    t.addSort("name", "asc");
    const out = t.exportJson({ format: "array" });
    // ascending by value: 30, 50, 75, 99, 100, 200
    assert.equal(out[0].value, 30);
    assert.equal(out[5].value, 200);
    t.dispose();
});

test("exportCsv: large dataset (10k rows) completes synchronously", () => {
    const big = [];
    for (let i = 0; i < 10000; i++) {
        big.push({ id: i, name: "row-" + i, value: i * 3 });
    }
    const t = createTable({
        rows: big,
        columns: [{ key: "id" }, { key: "name" }, { key: "value" }],
        getRowId: r => r.id,
    });
    const t0 = Date.now();
    const out = t.exportCsv();
    const ms = Date.now() - t0;
    assert.ok(ms < 500, `export took ${ms}ms (expected < 500ms)`);
    const lines = out.split("\r\n");
    assert.equal(lines.length, 10001);  // 1 header + 10k rows
    t.dispose();
});
