// test/grouping.test.js
// -----------------------------------------------------------------------------
// M3: row grouping + aggregation. Headless behavior only -- DOM rendering
// of group-header rows / sticky headers is covered by dom.test.js additions.
//
// Coverage:
//   - Config parsing: string, string[], null groupBy; initialCollapsedGroups
//   - Tree structure: single-level, multi-level, empty-groupBy short-circuit
//   - Aggregates: sum, avg, min, max, count, custom fn; null-value handling
//   - Sort within groups: sortChain applies per leaf, groups ordered by key asc
//   - Filter interaction: filter runs BEFORE grouping (empty groups vanish)
//   - Collapse: collapse/expand/toggle single, expandAll/collapseAll,
//     nested collapse hides subtree, collapsed groups still emit their header
//   - Backwards compat: visibleRows still returns data-only, rowCount = data,
//     entryCount = interleaved total
//   - Grand total: aggregates over filteredRows regardless of collapse state
//   - groupAncestryAt: ancestor headers for a given entry index
//   - Reactive: setGroupBy re-partitions, mutating rows/filters propagates,
//     collapsed set survives groupBy change (harmless stale entries pruned)
//   - Edge cases: null group values (bucketed + sorted last), unknown group
//     keys silently dropped, empty rows source, single-row groups

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable } from "../Table.js";

const STATUSES = ["active", "pending", "archived", "blocked"];

function makeDataset(n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        rows.push({
            id: i,
            region: i < n / 2 ? "Europe" : "Asia",
            status: STATUSES[i % 4],
            value: (i + 1) * 10,
            createdAt: "2024-" + String(1 + (i % 12)).padStart(2, "0") + "-01"
        });
    }
    return rows;
}

const COLS_BASE = [
    { key: "id" },
    { key: "region" },
    { key: "status" },
    { key: "value", compare: (a, b) => a - b },
    { key: "createdAt" }
];

// -----------------------------------------------------------------------------
// Config parsing
// -----------------------------------------------------------------------------

test("grouping: groupBy defaults to [] when not configured", () => {
    const t = createTable({ rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id });
    assert.deepEqual(t.groupBy(), []);
    assert.equal(t.groupedRows(), null);
    t.dispose();
});

test("grouping: groupBy accepts a bare string", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    assert.deepEqual(t.groupBy(), ["region"]);
    t.dispose();
});

test("grouping: groupBy accepts a string array", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    assert.deepEqual(t.groupBy(), ["region", "status"]);
    t.dispose();
});

test("grouping: groupBy silently drops unknown column keys", () => {
    // Persist-your-groupBy story: if a column got removed later, the app
    // shouldn't crash. We drop the unknown key and use what's left.
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "nope", "status"]
    });
    assert.deepEqual(t.groupBy(), ["region", "status"]);
    t.dispose();
});

test("grouping: initialCollapsedGroups pre-seeds the collapsed set", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region",
        initialCollapsedGroups: [["Europe"], ["Asia"]]
    });
    assert.equal(t.isGroupCollapsed(["Europe"]), true);
    assert.equal(t.isGroupCollapsed(["Asia"]), true);
    assert.equal(t.isGroupCollapsed(["Africa"]), false);
    t.dispose();
});

// -----------------------------------------------------------------------------
// Tree structure
// -----------------------------------------------------------------------------

test("grouping: single-level partitions rows into ordered buckets", () => {
    const rows = makeDataset(20); // 10 Europe (id 0-9), 10 Asia (id 10-19)
    const t = createTable({
        rows, columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    const tree = t.groupedRows();
    assert.equal(tree.length, 2);
    // Groups sorted ascending by key -- Asia before Europe.
    assert.equal(tree[0].value, "Asia");
    assert.equal(tree[0].count, 10);
    assert.equal(tree[1].value, "Europe");
    assert.equal(tree[1].count, 10);
    // Every top-level node is a LEAF (no subGroups) because groupBy has one level.
    assert.equal(tree[0].subGroups, null);
    assert.equal(tree[1].subGroups, null);
    assert.equal(tree[0].rows.length, 10);
    t.dispose();
});

test("grouping: multi-level builds a proper tree with subGroups", () => {
    const rows = makeDataset(20);
    const t = createTable({
        rows, columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    const tree = t.groupedRows();
    assert.equal(tree.length, 2);                       // Asia, Europe
    for (const region of tree) {
        assert.equal(region.subGroups.length, 4);       // 4 status values
        assert.equal(region.rows, null);                // non-leaf: no rows
        for (const status of region.subGroups) {
            assert.equal(status.depth, 1);
            assert.equal(status.subGroups, null);       // leaf level
            assert(Array.isArray(status.rows));
            assert(status.rows.length > 0);
        }
    }
    t.dispose();
});

test("grouping: group nodes carry path + pathStr for stable keying", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    const tree = t.groupedRows();
    const asia = tree[0];
    assert.deepEqual(asia.path, ["Asia"]);
    assert.equal(asia.pathStr, "Asia");
    const asiaActive = asia.subGroups[0];
    assert.deepEqual(asiaActive.path, ["Asia", "active"]);
    // pathStr uses U+001F separator, so nested paths are unambiguous even
    // when values contain punctuation.
    assert(asiaActive.pathStr.includes("\x1f"));
    t.dispose();
});

test("grouping: null group values bucket under a null-valued node, sorted last", () => {
    const rows = [
        { id: 1, region: "Europe" },
        { id: 2, region: null },
        { id: 3, region: "Asia" },
        { id: 4, region: undefined }
    ];
    const t = createTable({
        rows, columns: [{key:"id"},{key:"region"}], getRowId: r => r.id,
        groupBy: "region"
    });
    const tree = t.groupedRows();
    assert.equal(tree.length, 3);
    assert.equal(tree[0].value, "Asia");
    assert.equal(tree[1].value, "Europe");
    assert.equal(tree[2].value, null);   // null bucket sorted last
    assert.equal(tree[2].count, 2);      // both null AND undefined get bucketed
    t.dispose();
});

// -----------------------------------------------------------------------------
// Aggregates
// -----------------------------------------------------------------------------

test("grouping: aggregate sum totals numeric values, skips nulls/NaN", () => {
    const rows = [
        { id: 1, g: "A", n: 10 },
        { id: 2, g: "A", n: 20 },
        { id: 3, g: "A", n: null },
        { id: 4, g: "A", n: NaN },
        { id: 5, g: "B", n: 5 }
    ];
    const t = createTable({
        rows, columns: [{key:"id"},{key:"g"},{key:"n",aggregate:"sum"}],
        getRowId: r => r.id, groupBy: "g"
    });
    const tree = t.groupedRows();
    assert.equal(tree[0].aggregates.get("n"), 30);   // A: 10+20, null+NaN skipped
    assert.equal(tree[1].aggregates.get("n"), 5);    // B: 5
    t.dispose();
});

test("grouping: aggregate avg means the numeric values, null for empty", () => {
    const rows = [
        { id: 1, g: "A", n: 10 },
        { id: 2, g: "A", n: 20 },
        { id: 3, g: "A", n: 30 },
        { id: 4, g: "B", n: null }   // all null -> avg is null (not 0)
    ];
    const t = createTable({
        rows, columns: [{key:"id"},{key:"g"},{key:"n",aggregate:"avg"}],
        getRowId: r => r.id, groupBy: "g"
    });
    const tree = t.groupedRows();
    assert.equal(tree[0].aggregates.get("n"), 20);
    assert.equal(tree[1].aggregates.get("n"), null);
    t.dispose();
});

test("grouping: aggregate min/max ignore nulls", () => {
    const rows = [
        { id: 1, g: "A", n: 30 },
        { id: 2, g: "A", n: 10 },
        { id: 3, g: "A", n: null },
        { id: 4, g: "A", n: 20 }
    ];
    const t = createTable({
        rows,
        columns: [{key:"id"},{key:"g"},{key:"lo",accessor:r=>r.n,aggregate:"min"},{key:"hi",accessor:r=>r.n,aggregate:"max"}],
        getRowId: r => r.id, groupBy: "g"
    });
    const g = t.groupedRows()[0];
    assert.equal(g.aggregates.get("lo"), 10);
    assert.equal(g.aggregates.get("hi"), 30);
    t.dispose();
});

test("grouping: aggregate count returns row count including null-valued rows", () => {
    const rows = [
        { id: 1, g: "A", n: 10 },
        { id: 2, g: "A", n: null },
        { id: 3, g: "A", n: undefined }
    ];
    const t = createTable({
        rows, columns: [{key:"id"},{key:"g"},{key:"n",aggregate:"count"}],
        getRowId: r => r.id, groupBy: "g"
    });
    assert.equal(t.groupedRows()[0].aggregates.get("n"), 3);
    t.dispose();
});

test("grouping: custom aggregate function receives (rows, col)", () => {
    let seenRows = null, seenCol = null;
    const t = createTable({
        rows: [{id:1,g:"A",n:1},{id:2,g:"A",n:2}],
        columns: [
            { key: "id" },
            { key: "g" },
            { key: "n", aggregate: (rows, col) => {
                seenRows = rows; seenCol = col;
                return rows.reduce((s, r) => s + r.n * r.n, 0);   // sum of squares
            } }
        ],
        getRowId: r => r.id, groupBy: "g"
    });
    assert.equal(t.groupedRows()[0].aggregates.get("n"), 5);      // 1 + 4
    assert.equal(seenRows.length, 2);
    assert.equal(seenCol.key, "n");
    t.dispose();
});

test("grouping: aggregates re-fold from LEAF rows at every depth (correct for non-associative reducers)", () => {
    // A pathological "reducer" that isn't associative: last-value-wins.
    // If we naively rolled up child aggregates, parent would see child
    // aggregate values, not raw leaf rows. Verifying we walk leaves.
    const rows = [
        { id: 1, region: "EU", status: "a", n: 1 },
        { id: 2, region: "EU", status: "a", n: 2 },
        { id: 3, region: "EU", status: "b", n: 3 },
        { id: 4, region: "EU", status: "b", n: 4 }
    ];
    let leafCalls = 0;
    const t = createTable({
        rows,
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" },
            { key: "n", aggregate: (rows) => {
                leafCalls++;
                return rows[rows.length - 1].n;     // last row's n
            } }
        ],
        getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    const tree = t.groupedRows();
    // Region "EU" folds over all 4 leaf rows -> gets n=4 (last one).
    // Each status folds its own 2 rows -> "a" gets 2, "b" gets 4.
    assert.equal(tree[0].aggregates.get("n"), 4, "region aggregate over leaves");
    assert.equal(tree[0].subGroups[0].aggregates.get("n"), 2, "status=a leaf");
    assert.equal(tree[0].subGroups[1].aggregates.get("n"), 4, "status=b leaf");
    // 1 top-level region + 2 leaf statuses = 3 calls to the aggregator.
    assert.equal(leafCalls, 3);
    t.dispose();
});

test("grouping: column with no aggregate spec is absent from the aggregates Map", () => {
    const t = createTable({
        rows: [{id:1,g:"A",n:10,m:20}],
        columns: [
            { key: "id" },
            { key: "g" },
            { key: "n", aggregate: "sum" }, // has aggregate
            { key: "m" }                    // no aggregate
        ],
        getRowId: r => r.id, groupBy: "g"
    });
    const aggs = t.groupedRows()[0].aggregates;
    assert.equal(aggs.has("n"), true);
    assert.equal(aggs.has("m"), false);
    t.dispose();
});

// -----------------------------------------------------------------------------
// visibleEntries + visibleRows contract
// -----------------------------------------------------------------------------

test("grouping: visibleEntries interleaves group headers with data rows", () => {
    const rows = makeDataset(4);         // 2 Europe (0,1), 2 Asia (2,3)
    const t = createTable({
        rows, columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    const es = t.visibleEntries();
    // Asia header, 2 data rows, Europe header, 2 data rows = 6 entries
    assert.equal(es.length, 6);
    assert.equal(es[0].type, "group-header");
    assert.equal(es[0].value, "Asia");
    assert.equal(es[1].type, "data");
    assert.equal(es[2].type, "data");
    assert.equal(es[3].type, "group-header");
    assert.equal(es[3].value, "Europe");
    t.dispose();
});

test("grouping: visibleRows returns data-only rows in display order (backwards compat)", () => {
    const rows = makeDataset(4);
    const t = createTable({
        rows, columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    const vr = t.visibleRows();
    assert.equal(vr.length, 4);
    // Order: Asia rows first (id 2, 3), then Europe rows (id 0, 1).
    assert.deepEqual(vr.map(r => r.id), [2, 3, 0, 1]);
    // No group-header objects leak into visibleRows.
    assert(vr.every(r => "id" in r));
    t.dispose();
});

test("grouping: rowCount counts DATA rows, entryCount counts total entries", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    assert.equal(t.rowCount(), 4);
    assert.equal(t.entryCount(), 6);   // + 2 group headers
    t.dispose();
});

test("grouping: ungrouped table -> visibleRows === _sortedFilteredRows (no wrap/unwrap penalty)", () => {
    const t = createTable({
        rows: makeDataset(100), columns: COLS_BASE, getRowId: r => r.id
    });
    // No groupBy, so visibleRows should short-circuit to sorted-filtered.
    const a = t.visibleRows();
    const b = t.visibleRows();
    // Two reads should return the SAME array reference (computed cache hit).
    assert.equal(a, b);
    // And entryCount should match rowCount (no header entries).
    assert.equal(t.entryCount(), t.rowCount());
    t.dispose();
});

// -----------------------------------------------------------------------------
// Sort within groups
// -----------------------------------------------------------------------------

test("grouping: sortChain applies WITHIN each leaf group", () => {
    const rows = makeDataset(20);
    const t = createTable({
        rows, columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region",
        initialSort: [{ key: "value", dir: "desc" }]
    });
    const tree = t.groupedRows();
    // Within Asia, values should descend.
    const asiaVals = tree[0].rows.map(r => r.value);
    for (let i = 1; i < asiaVals.length; i++) {
        assert(asiaVals[i] <= asiaVals[i - 1], "Asia value at " + i + " not descending");
    }
    const euVals = tree[1].rows.map(r => r.value);
    for (let i = 1; i < euVals.length; i++) {
        assert(euVals[i] <= euVals[i - 1], "Europe value at " + i + " not descending");
    }
    t.dispose();
});

test("grouping: groups themselves ordered by group key ascending (not by sortChain)", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region",
        initialSort: [{ key: "value", dir: "desc" }]
    });
    // Even with value-desc, Asia comes before Europe because groups are keyed asc.
    const tree = t.groupedRows();
    assert.equal(tree[0].value, "Asia");
    assert.equal(tree[1].value, "Europe");
    t.dispose();
});

test("grouping: sort change re-orders rows within groups reactively", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    t.setSort("value", "asc");
    const asc = t.groupedRows()[0].rows.map(r => r.value);
    t.setSort("value", "desc");
    const desc = t.groupedRows()[0].rows.map(r => r.value);
    assert.deepEqual(asc, desc.slice().reverse());
    t.dispose();
});

// -----------------------------------------------------------------------------
// Filter + group interaction
// -----------------------------------------------------------------------------

test("grouping: filter runs BEFORE grouping (empty groups vanish)", () => {
    const rows = [
        { id: 1, region: "Europe", status: "active" },
        { id: 2, region: "Europe", status: "blocked" },
        { id: 3, region: "Asia",   status: "active" }
    ];
    const t = createTable({
        rows,
        columns: [{key:"id"},{key:"region"},{key:"status",filterable:true}],
        getRowId: r => r.id,
        groupBy: "region"
    });
    // No filter -- both regions have rows.
    assert.equal(t.groupedRows().length, 2);
    // Filter status to "blocked" -- only Europe has one.
    t.setColumnFilter("status", "blocked");
    const tree = t.groupedRows();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].value, "Europe");
    assert.equal(tree[0].count, 1);
    t.dispose();
});

// -----------------------------------------------------------------------------
// Collapse / expand
// -----------------------------------------------------------------------------

test("grouping: collapseGroup hides that group's data rows but keeps its header", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    assert.equal(t.entryCount(), 6);
    t.collapseGroup(["Asia"]);
    // Asia header + Europe header + 2 Europe data rows = 4 entries.
    assert.equal(t.entryCount(), 4);
    // Asia data rows disappear from visibleRows.
    assert.equal(t.rowCount(), 2);
    // isCollapsed flag flows through into the emitted header.
    const es = t.visibleEntries();
    const asiaHeader = es.find(e => e.type === "group-header" && e.value === "Asia");
    assert.equal(asiaHeader.isCollapsed, true);
    t.dispose();
});

test("grouping: expandGroup re-emits the collapsed subtree", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    t.collapseGroup(["Asia"]);
    t.expandGroup(["Asia"]);
    assert.equal(t.entryCount(), 6);
    assert.equal(t.rowCount(), 4);
    t.dispose();
});

test("grouping: toggleGroup flips collapse state", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    assert.equal(t.isGroupCollapsed(["Asia"]), false);
    t.toggleGroup(["Asia"]);
    assert.equal(t.isGroupCollapsed(["Asia"]), true);
    t.toggleGroup(["Asia"]);
    assert.equal(t.isGroupCollapsed(["Asia"]), false);
    t.dispose();
});

test("grouping: collapsing a parent hides all descendants (multi-level)", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    // Fully expanded: 2 region headers + 2*4 status headers + 20 data = 30 entries.
    assert.equal(t.entryCount(), 30);
    t.collapseGroup(["Asia"]);
    // Asia's 4 status headers + 10 data rows -> gone (14 removed). Left: 16.
    assert.equal(t.entryCount(), 16);
    assert.equal(t.rowCount(), 10);   // only Europe's data rows
    t.dispose();
});

test("grouping: collapseAllGroups collapses every node in the tree", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    t.collapseAllGroups();
    // Only top-level headers visible (Asia, Europe). Everything below hidden.
    assert.equal(t.entryCount(), 2);
    assert.equal(t.rowCount(), 0);
    t.dispose();
});

test("grouping: expandAllGroups clears the collapsed set", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region",
        initialCollapsedGroups: [["Asia"], ["Europe"]]
    });
    assert.equal(t.entryCount(), 2);  // both collapsed
    t.expandAllGroups();
    assert.equal(t.entryCount(), 22);
    assert.equal(t.collapsedGroups().size, 0);
    t.dispose();
});

test("grouping: switching groupBy off wipes collapsedGroups (nothing left to collapse)", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    t.collapseGroup(["Asia"]);
    assert.equal(t.collapsedGroups().size, 1);
    t.setGroupBy(null);
    assert.equal(t.collapsedGroups().size, 0);
    assert.equal(t.groupBy().length, 0);
    // Tree gone, all rows visible flat.
    assert.equal(t.groupedRows(), null);
    assert.equal(t.rowCount(), 4);
    t.dispose();
});

test("grouping: setGroupBy is a no-op when the new value equals the current (no signal churn)", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    let treeReads = 0;
    t._scope.effect(() => { t.groupBy(); treeReads++; });
    const before = treeReads;
    t.setGroupBy("region");        // identical -> should not fire
    t.setGroupBy(["region"]);      // still identical (normalized) -> should not fire
    assert.equal(treeReads, before);
    t.setGroupBy(["region", "status"]);   // different -> fires
    assert(treeReads > before);
    t.dispose();
});

// -----------------------------------------------------------------------------
// Grand total
// -----------------------------------------------------------------------------

test("grouping: showGrandTotal appends a grand-total entry at the end", () => {
    const t = createTable({
        rows: makeDataset(20),
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" },
            { key: "value", aggregate: "sum" }
        ],
        getRowId: r => r.id,
        groupBy: "region",
        showGrandTotal: true
    });
    const es = t.visibleEntries();
    assert.equal(es[es.length - 1].type, "grand-total");
    assert.equal(es[es.length - 1].count, 20);
    // Sum of 10..200 in steps of 10 = 2100.
    assert.equal(es[es.length - 1].aggregates.get("value"), 2100);
    t.dispose();
});

test("grouping: grand total aggregates over filteredRows even when groups are collapsed", () => {
    const t = createTable({
        rows: makeDataset(20),
        columns: [{key:"id"},{key:"region"},{key:"value",aggregate:"sum"}],
        getRowId: r => r.id,
        groupBy: "region",
        showGrandTotal: true
    });
    const totalBefore = t.visibleEntries().at(-1).aggregates.get("value");
    t.collapseGroup(["Asia"]);
    const totalAfter = t.visibleEntries().at(-1).aggregates.get("value");
    assert.equal(totalBefore, totalAfter, "grand total is stable across collapse");
    t.dispose();
});

test("grouping: grand total works even without any grouping", () => {
    const t = createTable({
        rows: makeDataset(4),
        columns: [{key:"id"},{key:"value",aggregate:"sum"}],
        getRowId: r => r.id,
        showGrandTotal: true
    });
    // Ungrouped: 4 data entries + 1 grand-total = 5.
    assert.equal(t.entryCount(), 5);
    const gt = t.visibleEntries().at(-1);
    assert.equal(gt.type, "grand-total");
    assert.equal(gt.aggregates.get("value"), 100);   // 10+20+30+40
    t.dispose();
});

// -----------------------------------------------------------------------------
// Sticky header ancestry
// -----------------------------------------------------------------------------

test("grouping: groupAncestryAt(0) is empty (the first entry has no preceding headers)", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    // Entry 0 is the Asia header itself -- ancestors are strictly shallower.
    assert.deepEqual(t.groupAncestryAt(0), []);
    t.dispose();
});

test("grouping: groupAncestryAt on a data row returns its containing header(s)", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    // Entry 1 is the first Asia data row.
    const ancestry = t.groupAncestryAt(1);
    assert.equal(ancestry.length, 1);
    assert.equal(ancestry[0].value, "Asia");
    t.dispose();
});

test("grouping: groupAncestryAt on a nested data row returns headers at every depth", () => {
    const t = createTable({
        rows: makeDataset(20), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"]
    });
    // Find the first data row and check both ancestor levels.
    const es = t.visibleEntries();
    const dataIdx = es.findIndex(e => e.type === "data");
    const ancestry = t.groupAncestryAt(dataIdx);
    assert.equal(ancestry.length, 2);
    assert.equal(ancestry[0].depth, 0);
    assert.equal(ancestry[1].depth, 1);
    t.dispose();
});

// -----------------------------------------------------------------------------
// Reactive propagation
// -----------------------------------------------------------------------------

test("grouping: mutating rows source re-partitions the tree", () => {
    const rows = [{id:1,g:"A"},{id:2,g:"A"}];
    const t = createTable({
        rows: rows.slice(),
        columns: [{key:"id"},{key:"g"}],
        getRowId: r => r.id,
        groupBy: "g"
    });
    assert.equal(t.groupedRows().length, 1);
    // Swap in a dataset with a new group.
    // (createTable copied the initial array by reference; passing a getter or
    //  reassigning via a signal is the reactive pattern -- for this test we
    //  wire a signal-backed source.)
    t.dispose();
    // Re-do with a signal source.
    import("../node_modules/@zakkster/lite-signal/Signal.js").then(({ signal }) => {
        const rowsSig = signal([{id:1,g:"A"}]);
        const t2 = createTable({
            rows: rowsSig,
            columns: [{key:"id"},{key:"g"}],
            getRowId: r => r.id,
            groupBy: "g"
        });
        assert.equal(t2.groupedRows().length, 1);
        rowsSig.set([{id:1,g:"A"},{id:2,g:"B"}]);
        assert.equal(t2.groupedRows().length, 2);
        t2.dispose();
    });
});

test("grouping: aggregates recompute when rows change", async () => {
    const { signal } = await import("../node_modules/@zakkster/lite-signal/Signal.js");
    const rowsSig = signal([{id:1,g:"A",n:10},{id:2,g:"A",n:20}]);
    const t = createTable({
        rows: rowsSig,
        columns: [{key:"id"},{key:"g"},{key:"n",aggregate:"sum"}],
        getRowId: r => r.id,
        groupBy: "g"
    });
    assert.equal(t.groupedRows()[0].aggregates.get("n"), 30);
    rowsSig.set([{id:1,g:"A",n:100}]);
    assert.equal(t.groupedRows()[0].aggregates.get("n"), 100);
    t.dispose();
});

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

test("grouping: empty rows source -> tree with no nodes", () => {
    const t = createTable({
        rows: [],
        columns: [{key:"id"},{key:"g"}],
        getRowId: r => r.id,
        groupBy: "g"
    });
    assert.deepEqual(t.groupedRows(), []);
    assert.equal(t.visibleEntries().length, 0);
    assert.equal(t.rowCount(), 0);
    t.dispose();
});

test("grouping: single-row groups still emit a header + one data row", () => {
    const t = createTable({
        rows: [{id:1,g:"A"}],
        columns: [{key:"id"},{key:"g"}],
        getRowId: r => r.id,
        groupBy: "g"
    });
    assert.equal(t.entryCount(), 2);
    assert.equal(t.visibleEntries()[0].type, "group-header");
    assert.equal(t.visibleEntries()[0].count, 1);
    assert.equal(t.visibleEntries()[1].type, "data");
    t.dispose();
});

test("grouping: setGroupBy to unknown key after mount is a silent no-op (does not crash)", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: "region"
    });
    t.setGroupBy(["nope", "also-nope"]);
    // Both keys invalid -> falls back to no grouping.
    assert.deepEqual(t.groupBy(), []);
    assert.equal(t.groupedRows(), null);
    t.dispose();
});

test("grouping: dispose cleans up all M3 signals + computeds", () => {
    const t = createTable({
        rows: makeDataset(4), columns: COLS_BASE, getRowId: r => r.id,
        groupBy: ["region", "status"],
        showGrandTotal: true
    });
    t.collapseGroup(["Europe"]);
    // Just make sure dispose() doesn't throw with grouping state populated.
    t.dispose();
});
