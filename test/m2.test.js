// test/m2.test.js -- M2 features: per-column filters + cell editing
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable } from "../Table.js";

function mk(extra) {
    return createTable({
        rows: [
            { id: 1, name: "Alice",   email: "alice@example.com",   role: "engineer", value: 100 },
            { id: 2, name: "Bob",     email: "bob@example.com",     role: "designer", value: 200 },
            { id: 3, name: "Charlie", email: "charlie@example.com", role: "engineer", value: 50  },
            { id: 4, name: "Alistair", email: "ali@example.com",     role: "manager",  value: 75  },
            { id: 5, name: "Dave",    email: "dave@example.com",    role: "engineer", value: 99  },
        ],
        columns: [
            { key: "id", width: 60 },
            { key: "name", filterable: true, editable: true },
            { key: "email", filterable: true },
            { key: "role", filterable: true, editable: true },
            { key: "value", filterable: true, editable: true, compare: (a, b) => a - b },
        ],
        getRowId: r => r.id,
        ...extra,
    });
}

// =====================================================================
// Filtering
// =====================================================================

test("columnFilters: default empty Map; visibleRows unchanged", () => {
    const t = mk();
    assert.equal(t.columnFilters().size, 0);
    assert.equal(t.visibleRows().length, 5);
    t.dispose();
});

test("setColumnFilter narrows visibleRows by case-insensitive substring", () => {
    const t = mk();
    t.setColumnFilter("name", "al");
    const names = t.visibleRows().map(r => r.name);
    assert.deepEqual(names.sort(), ["Alice", "Alistair"]);
    t.dispose();
});

test("setColumnFilter is case-insensitive", () => {
    const t = mk();
    t.setColumnFilter("name", "ALICE");
    assert.deepEqual(t.visibleRows().map(r => r.name), ["Alice"]);
    t.dispose();
});

test("setColumnFilter with empty string clears that column", () => {
    const t = mk();
    t.setColumnFilter("name", "al");
    assert.equal(t.visibleRows().length, 2);
    t.setColumnFilter("name", "");
    assert.equal(t.visibleRows().length, 5);
    assert.equal(t.columnFilters().size, 0);
    t.dispose();
});

test("setColumnFilter with whitespace-only string is treated as empty", () => {
    const t = mk();
    t.setColumnFilter("name", "   ");
    assert.equal(t.visibleRows().length, 5);
    t.dispose();
});

test("setColumnFilter on non-filterable column is silently ignored", () => {
    const t = mk();
    t.setColumnFilter("id", "1");
    assert.equal(t.columnFilters().size, 0);
    assert.equal(t.visibleRows().length, 5);
    t.dispose();
});

test("setColumnFilter on unknown column is silently ignored", () => {
    const t = mk();
    t.setColumnFilter("nonexistent", "x");
    assert.equal(t.columnFilters().size, 0);
    t.dispose();
});

test("multiple column filters apply as AND", () => {
    const t = mk();
    t.setColumnFilter("role", "engineer");
    t.setColumnFilter("name", "al");
    // engineer + name~al: just Alice
    assert.deepEqual(t.visibleRows().map(r => r.name), ["Alice"]);
    t.dispose();
});

test("clearColumnFilters removes all", () => {
    const t = mk();
    t.setColumnFilter("name", "al");
    t.setColumnFilter("role", "eng");
    assert.equal(t.columnFilters().size, 2);
    t.clearColumnFilters();
    assert.equal(t.columnFilters().size, 0);
    assert.equal(t.visibleRows().length, 5);
    t.dispose();
});

test("clearColumnFilters is a no-op when no filters set (no notify)", () => {
    const t = mk();
    let notifications = 0;
    const stopWatch = t._scope.effect(() => {
        t.columnFilters();
        notifications++;
    });
    assert.equal(notifications, 1);   // initial
    t.clearColumnFilters();
    assert.equal(notifications, 1);   // no change
    stopWatch();
    t.dispose();
});

test("custom filter predicate is invoked instead of substring default", () => {
    const t = createTable({
        rows: [
            { id: 1, score: 10 },
            { id: 2, score: 50 },
            { id: 3, score: 100 },
        ],
        columns: [
            { key: "id" },
            // ">N" syntax: parse number, keep rows where score > N
            { key: "score", filterable: true, filter: (v, q) => {
                if (q.startsWith(">")) {
                    const n = Number(q.slice(1));
                    return Number.isFinite(n) && v > n;
                }
                return String(v) === q;
            }},
        ],
        getRowId: r => r.id,
    });
    t.setColumnFilter("score", ">25");
    assert.deepEqual(t.visibleRows().map(r => r.id), [2, 3]);
    t.setColumnFilter("score", "50");
    assert.deepEqual(t.visibleRows().map(r => r.id), [2]);
    t.dispose();
});

test("filter predicate receives the full row", () => {
    const calls = [];
    const t = createTable({
        rows: [
            { id: 1, a: 1, b: "x" },
            { id: 2, a: 2, b: "y" },
        ],
        columns: [
            { key: "id" },
            { key: "a", filterable: true, filter: (v, q, row) => {
                calls.push({ v, q, row });
                return true;
            }},
            { key: "b" },
        ],
        getRowId: r => r.id,
    });
    t.setColumnFilter("a", "anything");
    t.visibleRows();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].row, { id: 1, a: 1, b: "x" });
    assert.equal(calls[0].v, 1);
    assert.equal(calls[0].q, "anything");
    t.dispose();
});

test("filteredRows is exposed and matches visibleRows when no sort", () => {
    const t = mk();
    t.setColumnFilter("name", "al");
    assert.deepEqual(t.filteredRows().map(r => r.id), t.visibleRows().map(r => r.id));
    t.dispose();
});

test("filter + sort: filter applies first, then sort", () => {
    const t = mk();
    t.setColumnFilter("role", "engineer");
    t.setSort("value", "asc");
    // engineers ascending by value: Charlie(50), Dave(99), Alice(100)
    assert.deepEqual(t.visibleRows().map(r => r.value), [50, 99, 100]);
    t.dispose();
});

test("filter survives sort changes; sort survives filter changes", () => {
    const t = mk();
    t.setSort("value", "desc");
    t.setColumnFilter("role", "engineer");
    assert.deepEqual(t.visibleRows().map(r => r.value), [100, 99, 50]);
    t.setColumnFilter("role", "designer");
    assert.deepEqual(t.visibleRows().map(r => r.value), [200]);
    t.setSort("value", "asc");
    assert.deepEqual(t.visibleRows().map(r => r.value), [200]);   // only one
    t.dispose();
});

test("filter + export: visible rows already filtered", () => {
    const t = mk();
    t.setColumnFilter("name", "al");
    const csv = t.exportCsv();
    const lines = csv.split("\r\n");
    assert.equal(lines.length, 3);     // header + 2 rows
    t.dispose();
});

test("filter on null/undefined values: empty filter passes, non-empty rejects", () => {
    const t = createTable({
        rows: [
            { id: 1, name: "Alice" },
            { id: 2, name: null },
            { id: 3, name: undefined },
        ],
        columns: [
            { key: "id" },
            { key: "name", filterable: true },
        ],
        getRowId: r => r.id,
    });
    t.setColumnFilter("name", "a");
    assert.deepEqual(t.visibleRows().map(r => r.id), [1]);   // null/undefined fail
    t.dispose();
});

test("filter notifies on every set, including identity writes (fresh Map per call)", () => {
    const t = mk();
    let runs = 0;
    const stopWatch = t._scope.effect(() => {
        t.visibleRows();
        runs++;
    });
    assert.equal(runs, 1);
    t.setColumnFilter("name", "al");
    assert.equal(runs, 2);
    t.setColumnFilter("name", "al");   // identity write -- but we ALWAYS create a fresh Map
    // The signal sees a fresh Object.is-distinct Map even if contents match,
    // so this DOES notify. Documenting this trade-off: predictable + no
    // deep-equal cost on every set, at the price of one extra recompute on
    // identity writes. Trivial in practice.
    assert.equal(runs, 3);
    stopWatch();
    t.dispose();
});

// =====================================================================
// Cell editing
// =====================================================================

test("editingCell default is null", () => {
    const t = mk();
    assert.equal(t.editingCell(), null);
    assert.equal(t.editingDraft(), "");
    t.dispose();
});

test("startEdit sets editingCell + seeds editingDraft", () => {
    const t = mk();
    t.startEdit(1, "name");
    assert.deepEqual(t.editingCell(), { rowId: 1, columnKey: "name" });
    assert.equal(t.editingDraft(), "Alice");
    t.dispose();
});

test("startEdit on non-editable column is silently ignored", () => {
    const t = mk();
    t.startEdit(1, "id");
    assert.equal(t.editingCell(), null);
    t.startEdit(1, "email");
    assert.equal(t.editingCell(), null);
    t.dispose();
});

test("startEdit on unknown column is silently ignored", () => {
    const t = mk();
    t.startEdit(1, "nonexistent");
    assert.equal(t.editingCell(), null);
    t.dispose();
});

test("startEdit on unknown row keeps the edit state pointed there", () => {
    // The row may exist later (paginated source); we still allow setting the
    // edit pointer, just with an empty draft.
    const t = mk();
    t.startEdit(999, "name");
    assert.deepEqual(t.editingCell(), { rowId: 999, columnKey: "name" });
    assert.equal(t.editingDraft(), "");
    t.dispose();
});

test("commitEdit fires onCellEdit with row + old/new + columnKey", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.commitEdit("Alice Renamed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].columnKey, "name");
    assert.equal(calls[0].oldValue, "Alice");
    assert.equal(calls[0].newValue, "Alice Renamed");
    assert.equal(calls[0].row.id, 1);
    t.dispose();
});

test("commitEdit without explicit value uses editingDraft", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    // Simulate input event setting the draft
    t.editingDraft.set("Edited Name");
    t.commitEdit();
    assert.equal(calls[0].newValue, "Edited Name");
    t.dispose();
});

test("commitEdit clears editingCell + editingDraft", () => {
    const t = mk();
    t.startEdit(1, "name");
    t.commitEdit("X");
    assert.equal(t.editingCell(), null);
    assert.equal(t.editingDraft(), "");
    t.dispose();
});

test("commitEdit does NOT fire onCellEdit if value is unchanged", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.commitEdit("Alice");   // same as starting value
    assert.equal(calls.length, 0);
    t.dispose();
});

test("commitEdit with no editing in flight is a no-op", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.commitEdit("X");
    assert.equal(calls.length, 0);
    assert.equal(t.editingCell(), null);
    t.dispose();
});

test("cancelEdit clears state and does NOT fire onCellEdit", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.editingDraft.set("Mid-edit value");
    t.cancelEdit();
    assert.equal(t.editingCell(), null);
    assert.equal(t.editingDraft(), "");
    assert.equal(calls.length, 0);
    t.dispose();
});

test("isEditing predicate", () => {
    const t = mk();
    assert.equal(t.isEditing(1, "name"), false);
    t.startEdit(1, "name");
    assert.equal(t.isEditing(1, "name"), true);
    assert.equal(t.isEditing(1, "value"), false);
    assert.equal(t.isEditing(2, "name"), false);
    t.dispose();
});

test("startEdit on a different cell commits any in-flight edit first", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.editingDraft.set("Mid-edit");
    t.startEdit(2, "role");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].row.id, 1);
    assert.equal(calls[0].newValue, "Mid-edit");
    assert.deepEqual(t.editingCell(), { rowId: 2, columnKey: "role" });
    assert.equal(t.editingDraft(), "designer");   // seed for row 2 role
    t.dispose();
});

test("startEdit on the SAME cell does not commit (no-op restart)", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.editingDraft.set("Mid-edit");
    t.startEdit(1, "name");
    assert.equal(calls.length, 0);
    // Draft is NOT re-seeded (no-op) -- still holds the in-progress value
    assert.equal(t.editingDraft(), "Mid-edit");
    t.dispose();
});

test("onCellEdit handler that throws does NOT corrupt subsequent edits", () => {
    const t = mk({ onCellEdit: () => { throw new Error("handler bug"); } });
    t.startEdit(1, "name");
    t.commitEdit("X");
    // State still cleaned up
    assert.equal(t.editingCell(), null);
    // Subsequent startEdit works
    t.startEdit(2, "role");
    assert.deepEqual(t.editingCell(), { rowId: 2, columnKey: "role" });
    t.dispose();
});

test("editing + filter interaction: filtering does NOT clear edit state", () => {
    const t = mk();
    t.startEdit(1, "name");
    t.setColumnFilter("name", "bob");   // hides row 1 (Alice)
    // The edit state survives; the row is just not visible. If it scrolls
    // back into view (filter cleared, etc.), editing resumes.
    assert.deepEqual(t.editingCell(), { rowId: 1, columnKey: "name" });
    t.dispose();
});

test("editing + dispose: dispose() ends editing cleanly", () => {
    const calls = [];
    const t = mk({ onCellEdit: (p) => calls.push(p) });
    t.startEdit(1, "name");
    t.editingDraft.set("Mid-edit");
    t.dispose();
    // dispose() does NOT commit in-flight edits (consumer should commit
    // first if they care). We just verify no crash.
    assert.equal(calls.length, 0);
});

// Regression: numeric columns + no-op Enter shouldn't fire onCellEdit
// (was a footgun -- 100 !== "100" was true under strict equality).
test("commitEdit unchanged-guard coerces oldValue to string", () => {
    const calls = [];
    const t = createTable({
        rows: [{ id: 1, count: 100 }],
        columns: [
            { key: "id" },
            { key: "count", editable: true, compare: (a, b) => a - b },
        ],
        getRowId: r => r.id,
        onCellEdit: (p) => calls.push(p),
    });
    t.startEdit(1, "count");
    // Draft is seeded with String(100) = "100"; press Enter without typing
    assert.equal(t.editingDraft(), "100");
    t.commitEdit();
    assert.equal(calls.length, 0,
        "onCellEdit fired for a no-op Enter on a numeric column: " +
        "100 (number) !== \"100\" (string) under strict equality, but the " +
        "user didn't change anything.");
    t.dispose();
});

test("commitEdit unchanged-guard still fires for real numeric changes", () => {
    const calls = [];
    const t = createTable({
        rows: [{ id: 1, count: 100 }],
        columns: [
            { key: "id" },
            { key: "count", editable: true, compare: (a, b) => a - b },
        ],
        getRowId: r => r.id,
        onCellEdit: (p) => calls.push(p),
    });
    t.startEdit(1, "count");
    t.commitEdit("200");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].oldValue, 100);    // unchanged passthrough
    assert.equal(calls[0].newValue, "200");
    t.dispose();
});

test("commitEdit with non-string explicit value uses strict equality", () => {
    const calls = [];
    const t = createTable({
        rows: [{ id: 1, count: 100 }],
        columns: [
            { key: "id" },
            { key: "count", editable: true, compare: (a, b) => a - b },
        ],
        getRowId: r => r.id,
        onCellEdit: (p) => calls.push(p),
    });
    t.startEdit(1, "count");
    // Explicit non-string value: strict ===, so 100 === 100 is unchanged.
    t.commitEdit(100);
    assert.equal(calls.length, 0);
    t.startEdit(1, "count");
    t.commitEdit(200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].newValue, 200);   // passed through as number
    t.dispose();
});
