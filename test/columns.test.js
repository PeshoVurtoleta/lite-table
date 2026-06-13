/**
 * Column operations: setColumnWidth (with clamping), setColumnHidden,
 * setColumnPin (3 buckets), setColumnOrder, moveColumn. Plus the derived
 * computeds: visibleColumns ordering, displayIndexByKey, colTemplate,
 * leftOffsets, rightOffsets.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "./_setup.js";
setupDom();

const { createTable, mountTable, _resetStylesForTest } = await import("../Table.js");

const COLS = [
    { key: "a", header: "A", width: 100 },
    { key: "b", header: "B", width: 200 },
    { key: "c", header: "C", width: 150 },
    { key: "d", header: "D", width: 80 }
];

const ROWS = [
    { id: 1, a: "a1", b: "b1", c: "c1", d: "d1" },
    { id: 2, a: "a2", b: "b2", c: "c2", d: "d2" }
];

test("columns: setColumnWidth updates colTemplate and clamps to min/max", () => {
    const t = createTable({
        rows: ROWS,
        columns: [
            { key: "a", width: 100, minWidth: 50, maxWidth: 300 },
            { key: "b", width: 200 }
        ],
        getRowId: (r) => r.id
    });
    assert.equal(t.colTemplate(), "100px 200px 1fr");
    t.setColumnWidth("a", 250);
    assert.equal(t.colTemplate(), "250px 200px 1fr");
    t.setColumnWidth("a", 10);     // below min -> clamp 50
    assert.equal(t.colTemplate(), "50px 200px 1fr");
    t.setColumnWidth("a", 10000);  // above max -> clamp 300
    assert.equal(t.colTemplate(), "300px 200px 1fr");
    t.dispose();
});

test("columns: setColumnHidden removes from visibleColumns + colTemplate", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    assert.equal(t.visibleColumns().length, 4);
    assert.equal(t.colTemplate(), "100px 200px 150px 80px 1fr");
    t.setColumnHidden("b", true);
    assert.equal(t.visibleColumns().length, 3);
    assert.equal(t.colTemplate(), "100px 150px 80px 1fr");
    t.setColumnHidden("b", false);
    assert.equal(t.visibleColumns().length, 4);
    t.dispose();
});

test("columns: setColumnPin moves columns into left/right buckets in render order", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    // Initial: a, b, c, d
    t.setColumnPin("c", "left");  // c moves to left bucket -> c, a, b, d
    t.setColumnPin("a", "right"); // a moves to right bucket -> c, b, d, a
    assert.deepEqual(t.visibleColumns().map(c => c.key), ["c", "b", "d", "a"]);
    t.dispose();
});

test("columns: leftOffsets cumulate from 0", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.setColumnPin("a", "left"); // width 100
    t.setColumnPin("b", "left"); // width 200
    const off = t.leftOffsets();
    assert.equal(off.get("a"), 0);
    assert.equal(off.get("b"), 100);
    t.dispose();
});

test("columns: rightOffsets cumulate from rightmost", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.setColumnPin("c", "right"); // width 150
    t.setColumnPin("d", "right"); // width 80
    // Visible order: a, b, c, d (c and d in right bucket).
    // Rightmost (d) has offset 0; c has offset 80 (width of d).
    const off = t.rightOffsets();
    assert.equal(off.get("d"), 0);
    assert.equal(off.get("c"), 80);
    t.dispose();
});

test("columns: setColumnOrder reorders unpinned columns", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    assert.deepEqual(t.visibleColumns().map(c => c.key), ["a", "b", "c", "d"]);
    t.setColumnOrder(["d", "c", "b", "a"]);
    assert.deepEqual(t.visibleColumns().map(c => c.key), ["d", "c", "b", "a"]);
    t.dispose();
});

test("columns: setColumnOrder rejects non-permutations", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const original = t.visibleColumns().map(c => c.key);
    t.setColumnOrder(["a", "b", "c"]);          // wrong length
    assert.deepEqual(t.visibleColumns().map(c => c.key), original);
    t.setColumnOrder(["a", "b", "c", "x"]);     // unknown key
    assert.deepEqual(t.visibleColumns().map(c => c.key), original);
    t.setColumnOrder(["a", "a", "b", "c"]);     // duplicate
    assert.deepEqual(t.visibleColumns().map(c => c.key), original);
    t.dispose();
});

test("columns: moveColumn before/after target", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    // Move "d" before "b": a, d, b, c
    t.moveColumn("d", "b", { before: true });
    assert.deepEqual(t.visibleColumns().map(c => c.key), ["a", "d", "b", "c"]);
    // Move "a" after "c": d, b, c, a
    t.moveColumn("a", "c", { before: false });
    assert.deepEqual(t.visibleColumns().map(c => c.key), ["d", "b", "c", "a"]);
    t.dispose();
});

test("columns (DOM): header cells get reactive gridColumn + display", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    const headerA = m.root.querySelector('.lt-header-cell[data-key="a"]');
    const headerB = m.root.querySelector('.lt-header-cell[data-key="b"]');
    assert.equal(headerA.style.gridColumn, "1 / span 1");
    assert.equal(headerB.style.gridColumn, "2 / span 1");

    t.setColumnHidden("a", true);
    assert.equal(headerA.style.display, "none");
    assert.equal(headerB.style.gridColumn, "1 / span 1"); // B is now first

    m.dispose();
    host.remove();
});

test("columns (DOM): pinned header gets data-pin and left/right offset", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.setColumnPin("a", "left");
    const headerA = m.root.querySelector('.lt-header-cell[data-key="a"]');
    assert.equal(headerA.getAttribute("data-pin"), "left");
    assert.equal(headerA.style.left, "0px");

    t.setColumnPin("b", "left");
    const headerB = m.root.querySelector('.lt-header-cell[data-key="b"]');
    assert.equal(headerB.style.left, "100px"); // after width of a

    t.setColumnPin("d", "right");
    const headerD = m.root.querySelector('.lt-header-cell[data-key="d"]');
    assert.equal(headerD.getAttribute("data-pin"), "right");
    assert.equal(headerD.style.right, "0px");

    m.dispose();
    host.remove();
});

test("columns (DOM): colTemplate CSS var updates when columns change", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    assert.equal(m.root.style.getPropertyValue("--lt-cols"),
        "100px 200px 150px 80px 1fr");
    t.setColumnWidth("b", 300);
    assert.equal(m.root.style.getPropertyValue("--lt-cols"),
        "100px 300px 150px 80px 1fr");
    t.setColumnHidden("c", true);
    assert.equal(m.root.style.getPropertyValue("--lt-cols"),
        "100px 300px 80px 1fr");

    m.dispose();
    host.remove();
});

test("columns: 1fr filler sits BETWEEN unpinned and right-pinned columns", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });

    // No right-pinned: trailing 1fr.
    assert.equal(t.colTemplate(), "100px 200px 150px 80px 1fr");

    // Pin d right: 1fr should be between c (last unpinned) and d.
    t.setColumnPin("d", "right");
    assert.equal(t.colTemplate(), "100px 200px 150px 1fr 80px");

    // Pin c right as well: 1fr between b and c.
    t.setColumnPin("c", "right");
    assert.equal(t.colTemplate(), "100px 200px 1fr 150px 80px");

    // All right-pinned: 1fr at the very start.
    t.setColumnPin("a", "right");
    t.setColumnPin("b", "right");
    assert.equal(t.colTemplate(), "1fr 100px 200px 150px 80px");

    t.dispose();
});

test("columns: colPlacement returns 1-indexed grid-column accounting for filler", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });

    let p = t.colPlacement();
    assert.equal(p.get("a"), 1);
    assert.equal(p.get("b"), 2);
    assert.equal(p.get("c"), 3);
    assert.equal(p.get("d"), 4);

    // Pin d right: filler at slot 4, d at 5.
    t.setColumnPin("d", "right");
    p = t.colPlacement();
    assert.equal(p.get("a"), 1);
    assert.equal(p.get("b"), 2);
    assert.equal(p.get("c"), 3);
    assert.equal(p.get("d"), 5);

    t.dispose();
});

test("columns (DOM): right-pinned cell's grid-column accounts for filler", () => {
    _resetStylesForTest();
    const host = document.createElement("div");
    document.body.appendChild(host);

    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    const m = mountTable(host, t);

    t.setColumnPin("d", "right");
    const headerD = m.root.querySelector('.lt-header-cell[data-key="d"]');
    assert.equal(headerD.style.gridColumn, "5 / span 1",
        "right-pinned col D sits at grid-column 5 (a=1, b=2, c=3, filler=4, d=5)");

    m.dispose();
    host.remove();
});

test("columns: flex emits minmax(minWidth, Nfr) and drops trailing 1fr", () => {
    const t = createTable({
        rows: ROWS,
        columns: [
            { key: "a", width: 100, minWidth: 50, flex: 1 },
            { key: "b", width: 200, minWidth: 80, flex: 2 },
            { key: "c", width: 150, minWidth: 60 }     // no flex
        ],
        getRowId: (r) => r.id
    });
    assert.equal(t.colTemplate(), "minmax(50px, 1fr) minmax(80px, 2fr) 150px");
    t.dispose();
});

test("columns: setColumnFlex switches between fixed and flex modes", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    assert.equal(t.colTemplate(), "100px 200px 150px 80px 1fr");

    t.setColumnFlex("b", 1);
    assert.equal(t.colTemplate(), "100px minmax(40px, 1fr) 150px 80px");

    t.setColumnFlex("c", 2);
    assert.equal(t.colTemplate(), "100px minmax(40px, 1fr) minmax(40px, 2fr) 80px");

    // Reset b -- only c still flex.
    t.setColumnFlex("b", 0);
    assert.equal(t.colTemplate(), "100px 200px minmax(40px, 2fr) 80px");

    // Reset all flex -- trailing 1fr returns.
    t.setColumnFlex("c", 0);
    assert.equal(t.colTemplate(), "100px 200px 150px 80px 1fr");

    t.dispose();
});

test("columns: flex + right-pinned interaction (no separate filler when any flex)", () => {
    const t = createTable({ rows: ROWS, columns: COLS, getRowId: (r) => r.id });
    t.setColumnFlex("b", 1);
    t.setColumnPin("d", "right");
    // No 1fr filler -- flex column b absorbs leftover space; right-pinned
    // d sits at the end naturally.
    assert.equal(t.colTemplate(), "100px minmax(40px, 1fr) 150px 80px");

    // colPlacement: a=1, b=2, c=3, d=4 (no filler offset because of flex).
    const p = t.colPlacement();
    assert.equal(p.get("d"), 4);

    t.dispose();
});

test("columns: colTemplate segment count is always consistent with colPlacement", () => {
    // Stress: every combo of pin and flex across 4 columns, in every order.
    // Invariant -- template-segment-count is always >= max placement value,
    // and every placement is a valid 1..N index into the template.
    const cols = [
        { key: "a", width: 80 }, { key: "b", width: 90 },
        { key: "c", width: 100 }, { key: "d", width: 110 }
    ];
    const t = createTable({ rows: [{id:1}], columns: cols, getRowId: r=>r.id });

    const scenarios = [
        () => { t.setColumnFlex("a", 1); },
        () => { t.setColumnFlex("b", 2); t.setColumnPin("d", "right"); },
        () => { t.setColumnFlex("a", 0); t.setColumnPin("a", "left"); },
        () => { t.setColumnFlex("c", 1); t.setColumnPin("a", "left"); t.setColumnPin("d", "right"); },
        () => { t.moveColumn("a", "d", { before: true }); },
        () => { t.setColumnHidden("b", true); },
        () => { t.setColumnHidden("b", false); t.setColumnFlex("b", 3); }
    ];
    for (const apply of scenarios) {
        apply();
        const tpl = t.colTemplate();
        const segs = tpl.split(/\s+(?![^(]*\))/).filter(Boolean);
        const placements = [...t.colPlacement().values()];
        for (const p of placements) {
            assert.ok(p >= 1 && p <= segs.length,
                "placement " + p + " out of range 1.." + segs.length + " for template: " + tpl);
        }
    }
    t.dispose();
});

test("columns: pinning suspends flex so sticky offsets match rendered width", () => {
    // Sticky offsets are pre-computed cumulative sums of c.width(). A pinned
    // column MUST therefore render at exactly c.width()px -- if it instead
    // got an fr-distributed track, the rendered box would be wider than the
    // sticky offset accounts for and cells would overlap. Reproducing the
    // 5-right-pinned scenario from the DOM that surfaced this bug.
    const t = createTable({
        rows: [{ id: 1 }],
        columns: [
            { key: "id",        width: 90 },
            { key: "name",      width: 180, minWidth: 120, flex: 1 },
            { key: "email",     width: 240, minWidth: 180, flex: 2 },
            { key: "value",     width: 100 },
            { key: "status",    width: 110 },
            { key: "createdAt", width: 130 }
        ],
        getRowId: (r) => r.id
    });
    // Initial: name + email flex, all unpinned -> fr expressions in template.
    assert.equal(t.colTemplate(),
        "90px minmax(120px, 1fr) minmax(180px, 2fr) 100px 110px 130px");

    // Pin 5 columns right (including the two flex columns). The flex
    // expressions must disappear -- pinned columns are fixed-width.
    t.setColumnPin("id", "right");
    t.setColumnPin("name", "right");
    t.setColumnPin("email", "right");
    t.setColumnPin("value", "right");
    t.setColumnPin("status", "right");
    const tpl = t.colTemplate();
    assert.ok(!tpl.includes("minmax"),
        "no minmax(.., fr) expressions when all flex columns are pinned; got: " + tpl);
    assert.equal(tpl, "130px 1fr 90px 180px 240px 100px 110px");

    // The 1fr filler returns (since no unpinned flex column to absorb space).
    // rightOffsets are cumulative sums of c.width() -- verify they match what
    // a 180px-wide name would expect, not a 357px fr-resolved track.
    const ro = t.rightOffsets();
    assert.equal(ro.get("status"), 0);
    assert.equal(ro.get("value"),  110);
    assert.equal(ro.get("email"),  210);  // status + value
    assert.equal(ro.get("name"),   450);  // status + value + email
    assert.equal(ro.get("id"),     630);  // status + value + email + name

    // Unpin name -> flex re-engages for it.
    t.setColumnPin("name", "none");
    const tpl2 = t.colTemplate();
    assert.ok(tpl2.includes("minmax(120px, 1fr)"),
        "flex re-engages on unpin; got: " + tpl2);

    t.dispose();
});
