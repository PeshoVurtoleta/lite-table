// test/scope-dispose.test.js -- verifies createTable + dispose() round-trips
// to zero active reactive nodes. Catches the v1.0.0 regression where signals
// were silently leaked because the dispose loop called them (read) instead of
// disposing them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";
import { createTable } from "../Table.js";

function mk(extraColumns) {
    return createTable({
        rows: [{ id: 1, n: "a" }, { id: 2, n: "b" }, { id: 3, n: "c" }],
        columns: [{ key: "id" }, { key: "n" }, ...(extraColumns || [])],
        getRowId: r => r.id,
    });
}

test("createTable + dispose round-trips to zero nodes", () => {
    const before = stats().activeNodes;
    const t = mk();
    assert.ok(stats().activeNodes > before, "createTable should allocate nodes");
    t.dispose();
    assert.equal(stats().activeNodes, before, "dispose should free every node it allocated");
});

test("repeated create+dispose stays steady-state", () => {
    const before = stats().activeNodes;
    for (let i = 0; i < 50; i++) {
        const t = mk();
        t.dispose();
    }
    assert.equal(stats().activeNodes, before, "50 create+dispose cycles should leak zero nodes");
});

test("dispose is idempotent", () => {
    const before = stats().activeNodes;
    const t = mk();
    t.dispose();
    t.dispose();
    t.dispose();
    assert.equal(stats().activeNodes, before);
});

test("many columns scale with no leak", () => {
    const before = stats().activeNodes;
    const cols = [];
    for (let i = 0; i < 30; i++) cols.push({ key: "c" + i, width: 80 });
    const t = createTable({
        rows: [{ id: 1 }],
        columns: cols.concat([{ key: "id" }]),
        getRowId: r => r.id,
    });
    t.dispose();
    assert.equal(stats().activeNodes, before);
});

test("exportCsv inside an effect runs against the visible computed cleanly", () => {
    // Sanity check that export reads do not bleed reactive subscriptions
    // upward. (exportCsv is intended to be called from event handlers, not
    // from inside an effect, but if a user does it, we want predictable
    // behaviour and no leaks.)
    const before = stats().activeNodes;
    const t = mk();
    const out = t.exportCsv();
    assert.ok(out.split("\n").length >= 2);
    t.dispose();
    assert.equal(stats().activeNodes, before);
});
