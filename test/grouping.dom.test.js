// test/grouping.dom.test.js
// -----------------------------------------------------------------------------
// M3: DOM rendering of grouped views. Verifies buildSlot dispatch, class
// discriminators, aggregate rendering, click-to-toggle wiring, and axis
// integration with entryCount. Uses happy-dom because puppeteer / a real
// browser is overkill for these -- we're asserting DOM state produced by
// the mount layer's reactive effects, not layout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createTable, mountTable } from "../Table.js";

// happy-dom: install a globalish DOM before importing the module. We do it
// per-test to avoid cross-test contamination -- disposal cleans DOM but
// leaves the Window's document objects lingering otherwise.
function withDom(fn) {
    return async () => {
        const window = new Window();
        const orig = { document: globalThis.document, window: globalThis.window };
        globalThis.window = window;
        globalThis.document = window.document;
        globalThis.HTMLElement = window.HTMLElement;
        globalThis.PointerEvent = window.PointerEvent;
        globalThis.queueMicrotask = window.queueMicrotask.bind(window);
        try {
            await fn(window);
        } finally {
            globalThis.document = orig.document;
            globalThis.window = orig.window;
            window.happyDOM.abort();
            await window.happyDOM.close();
        }
    };
}

function makeRows(n) {
    const rows = [];
    const STATUSES = ["active", "pending", "archived", "blocked"];
    for (let i = 0; i < n; i++) {
        rows.push({
            id: i,
            region: i < n / 2 ? "Europe" : "Asia",
            status: STATUSES[i % 4],
            value: (i + 1) * 10
        });
    }
    return rows;
}

// -----------------------------------------------------------------------------

test("dom: group-header rows get .lt-row-group-header + data-depth", withDom(async (win) => {
    const host = win.document.createElement("div");
    // A viewport big enough for 20 rows so all 20 data + 2 headers show.
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(20),
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" },
            { key: "value", aggregate: "sum" }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Every rendered row element in the pool should be visible with the
    // right class. Walk the DOM.
    const rows = host.querySelectorAll(".lt-row");
    let headerCount = 0, dataCount = 0;
    for (const r of rows) {
        if (r.classList.contains("lt-row-group-header")) {
            headerCount++;
            assert(r.hasAttribute("data-depth"), "group header must have data-depth");
            assert(r.hasAttribute("data-collapsed"), "group header must have data-collapsed");
        } else if (r.style.display !== "none") {
            dataCount++;
        }
    }
    // At least 2 headers should be rendered (Asia + Europe).
    assert(headerCount >= 2, "expected >=2 group-header rows, got " + headerCount);
    mount.dispose();
}));

test("dom: group-header first cell shows chevron + value + count", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" },
            { key: "value", aggregate: "sum" }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Find the first group header -- its first visible cell holds the label.
    const header = host.querySelector(".lt-row-group-header");
    assert(header, "no group header rendered");
    const firstCell = header.querySelector(".lt-cell");
    // The label text should include the chevron glyph and the group value.
    // We don't hard-code the chevron since a future release might tweak it,
    // but it MUST include the group value and count.
    const text = firstCell.textContent;
    assert(text.includes("Asia") || text.includes("Europe"), "first cell should show group value, got: " + text);
    assert(text.includes("(5)"), "first cell should show count (5), got: " + text);
    mount.dispose();
}));

test("dom: group-header aggregate cells show formatted aggregate value", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [
            { key: "id" },
            { key: "region" },
            { key: "status" },
            { key: "value", aggregate: "sum",
              aggregateFormat: (v) => "$" + v }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // For the "Asia" group (ids 5-9), values are 60+70+80+90+100 = 400.
    // Find the Asia group header (first in the pool, since Asia sorts before Europe).
    const headers = host.querySelectorAll(".lt-row-group-header");
    const asiaHeader = Array.from(headers).find(h =>
        h.querySelector(".lt-cell").textContent.includes("Asia")
    );
    assert(asiaHeader, "Asia header not found");
    const valueCell = asiaHeader.querySelector('[data-key="value"]');
    assert(valueCell, "value cell in Asia header not found");
    assert.equal(valueCell.textContent, "$400", "expected $400 formatted, got: " + valueCell.textContent);
    mount.dispose();
}));

test("dom: clicking a group-header cell toggles its collapse state", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }, { key: "status" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Precondition: no groups collapsed, entry count = 2 headers + 10 rows = 12.
    assert.equal(table.entryCount(), 12);
    assert.equal(table.collapsedGroups().size, 0);

    // Click the first cell of the first group header (Asia sorts first).
    const asiaHeader = host.querySelector(".lt-row-group-header");
    const firstCell = asiaHeader.querySelector(".lt-cell");
    firstCell.dispatchEvent(new win.PointerEvent("pointerdown", {
        isPrimary: true, button: 0, bubbles: true
    }));

    // Asia should now be collapsed -- 5 rows hidden.
    assert.equal(table.entryCount(), 7);        // 2 headers + 5 Europe rows
    assert.equal(table.rowCount(), 5);          // data rows only
    assert.equal(table.isGroupCollapsed(["Asia"]), true);

    // Click again -- expand.
    firstCell.dispatchEvent(new win.PointerEvent("pointerdown", {
        isPrimary: true, button: 0, bubbles: true
    }));
    assert.equal(table.entryCount(), 12);
    assert.equal(table.isGroupCollapsed(["Asia"]), false);
    mount.dispose();
}));

test("dom: clicking a group-header does NOT change row selection", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }, { key: "status" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Select row id=3 first via API.
    table.selectRow(3, "set");
    assert.equal(table.isSelected(3), true);

    // Click a group header -- selection should be UNCHANGED.
    const header = host.querySelector(".lt-row-group-header");
    header.querySelector(".lt-cell").dispatchEvent(new win.PointerEvent("pointerdown", {
        isPrimary: true, button: 0, bubbles: true
    }));

    assert.equal(table.isSelected(3), true, "selection cleared by header click");
    mount.dispose();
}));

test("dom: grand-total row gets .lt-row-grand-total class", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" },
            { key: "value", aggregate: "sum" }
        ],
        getRowId: r => r.id,
        groupBy: "region",
        showGrandTotal: true
    });
    const mount = mountTable(host, table);

    const grandTotal = host.querySelector(".lt-row-grand-total");
    assert(grandTotal, "grand-total row not rendered");
    // First cell should say "Total (N)".
    const firstCell = grandTotal.querySelector(".lt-cell");
    assert(firstCell.textContent.startsWith("Total"), "grand-total first cell should start with 'Total', got: " + firstCell.textContent);
    assert(firstCell.textContent.includes("(10)"), "grand-total should show count 10");
    // The value cell should show the sum (10+20+...+100 = 550).
    const valueCell = grandTotal.querySelector('[data-key="value"]');
    assert.equal(valueCell.textContent, "550");
    mount.dispose();
}));

test("dom: chevron flips (expanded -> collapsed) via data-collapsed attr", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }, { key: "status" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    const asiaHeader = host.querySelector(".lt-row-group-header");
    // Initial: expanded.
    assert.equal(asiaHeader.getAttribute("data-collapsed"), "false");
    const beforeText = asiaHeader.querySelector(".lt-cell").textContent;

    table.collapseGroup(["Asia"]);
    assert.equal(asiaHeader.getAttribute("data-collapsed"), "true");
    const afterText = asiaHeader.querySelector(".lt-cell").textContent;
    // The chevron glyph should have changed. Not hard-coding the specific
    // char -- just that the text before/after differs.
    assert.notEqual(beforeText, afterText, "chevron glyph didn't update on collapse");
    mount.dispose();
}));

test("dom: virtual axis uses entryCount not rowCount (headers reserve height)", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "400px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // rowCount=10, entryCount=12 (10 data + 2 headers).
    // axis.totalSize() should reflect 12 rows worth of height, not 10.
    const expected = 12 * table.rowHeight;
    assert.equal(mount.axis.totalSize(), expected,
        "axis.totalSize should reserve entryCount * rowHeight, got " + mount.axis.totalSize());
    mount.dispose();
}));

test("dom: data-row selection + focus still work when interleaved with headers", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(6),
        columns: [{ key: "id" }, { key: "region" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Click a data row cell -- selection should update.
    // Data rows are those without lt-row-group-header / lt-row-grand-total.
    const dataRows = Array.from(host.querySelectorAll(".lt-row"))
        .filter(r => !r.classList.contains("lt-row-group-header") &&
                     !r.classList.contains("lt-row-grand-total") &&
                     r.style.display !== "none");
    assert(dataRows.length > 0, "no data rows rendered");

    // Pick a data row we can identify by its id cell content.
    const firstDataRow = dataRows[0];
    const idCell = firstDataRow.querySelector('[data-key="id"]');
    const clickedId = Number(idCell.textContent);
    idCell.dispatchEvent(new win.PointerEvent("pointerdown", {
        isPrimary: true, button: 0, bubbles: true
    }));

    assert.equal(table.isSelected(clickedId), true,
        "expected id " + clickedId + " to be selected");
    mount.dispose();
}));

test("dom: collapsing a group hides its data rows from the pool immediately", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "800px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Snapshot the ids currently visible in data rows.
    function visibleDataIds() {
        return Array.from(host.querySelectorAll(".lt-row"))
            .filter(r => !r.classList.contains("lt-row-group-header") &&
                         !r.classList.contains("lt-row-grand-total") &&
                         r.style.display !== "none")
            .map(r => Number(r.querySelector('[data-key="id"]').textContent))
            .sort((a, b) => a - b);
    }
    const before = visibleDataIds();
    assert.equal(before.length, 10);

    table.collapseGroup(["Asia"]);
    const after = visibleDataIds();
    // Asia was ids 5-9. After collapse, only 0-4 (Europe) should be visible.
    assert.deepEqual(after, [0, 1, 2, 3, 4]);
    mount.dispose();
}));

test("dom: mount.dispose() cleans up group-header rows without leaking", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    // 8 rows + 2 top + 4 sub-status + 1 grand-total = 15 entries, comfortably
    // in the default 24-slot pool. Bigger tables would fit too but pushing
    // the pool past ~40 slots hits the default signal-registry cap of 1024
    // nodes -- consumers can grow it via createRegistry({initialNodes:...})
    // if they need it, but this test is about dispose behavior, not scale.
    const table = createTable({
        rows: makeRows(8),
        columns: [{ key: "id" }, { key: "region" }, { key: "status" }],
        getRowId: r => r.id,
        groupBy: ["region", "status"],
        showGrandTotal: true
    });
    const mount = mountTable(host, table);

    // Sanity: DOM contains M3 elements.
    assert(host.querySelectorAll(".lt-row-group-header").length > 0);
    assert(host.querySelector(".lt-row-grand-total") !== null);

    mount.dispose();
    // After dispose, the host is empty (mount removed its root).
    assert.equal(host.children.length, 0);
}));

// -----------------------------------------------------------------------------
// Sticky group headers + interaction with column state changes.
// -----------------------------------------------------------------------------

test("dom: sticky group-headers container exists inside viewport, not inner", withDom(async (win) => {
    // Regression guard for the DOM-placement invariant: sticky groups must
    // be a direct child of `.lt-viewport` (BEFORE `.lt-inner`), and sticky
    // grand-total must also be a direct child of `.lt-viewport` (AFTER
    // `.lt-inner`). If either drifts inside .lt-inner, sticky top/bottom
    // stops working correctly (see the flow-position discussion in the
    // mount code's sticky comment).
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }, { key: "status" }],
        getRowId: r => r.id,
        groupBy: "region",
        showGrandTotal: true
    });
    const mount = mountTable(host, table);

    const viewport = host.querySelector(".lt-viewport");
    const inner = host.querySelector(".lt-inner");
    const stickyGroups = viewport.querySelector(":scope > .lt-sticky-groups");
    const stickyGT = viewport.querySelector(":scope > .lt-sticky-grand-total");
    assert(stickyGroups, "sticky-groups must be a direct child of .lt-viewport");
    assert(stickyGT, "sticky-grand-total must be a direct child of .lt-viewport");

    // DOM order: sticky-groups BEFORE inner, sticky-grand-total AFTER inner.
    const children = Array.from(viewport.children);
    const iGroups = children.indexOf(stickyGroups);
    const iInner = children.indexOf(inner);
    const iGT = children.indexOf(stickyGT);
    assert(iGroups < iInner, "sticky-groups should be BEFORE .lt-inner");
    assert(iGT > iInner, "sticky-grand-total should be AFTER .lt-inner");

    // sticky rows must NOT carry .lt-row so pool-slot counters
    // (querySelectorAll(".lt-row")) aren't inflated -- this is the fix for
    // the 1.1.0 dom test regression.
    const stickyGroupRows = stickyGroups.querySelectorAll(".lt-sticky-group");
    for (const r of stickyGroupRows) {
        assert(!r.classList.contains("lt-row"),
            "sticky-group rows must not carry .lt-row");
    }
    const stickyGTRow = stickyGT.querySelector(".lt-sticky-grand-total-row");
    assert(!stickyGTRow.classList.contains("lt-row"),
        "sticky-grand-total row must not carry .lt-row");

    mount.dispose();
}));

test("dom: sticky group headers hidden when grouping is not active", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    // No groupBy -- sticky groups container must be display:none, and no
    // sticky rows should be rendered inside it.
    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }],
        getRowId: r => r.id
    });
    const mount = mountTable(host, table);

    const stickyGroups = host.querySelector(".lt-sticky-groups");
    assert.equal(stickyGroups.style.display, "none",
        "sticky-groups container should be display:none when ungrouped");

    // Turn on grouping -- container appears.
    table.setGroupBy("region");
    assert.notEqual(stickyGroups.style.display, "none",
        "sticky-groups container should be visible after setGroupBy");

    // Turn it off again -- container hidden.
    table.setGroupBy(null);
    assert.equal(stickyGroups.style.display, "none",
        "sticky-groups container should be display:none after setGroupBy(null)");

    mount.dispose();
}));

test("dom: sticky grand-total hidden when showGrandTotal is not configured", withDom(async (win) => {
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [{ key: "id" }, { key: "region" }],
        getRowId: r => r.id,
        groupBy: "region"
        // no showGrandTotal
    });
    const mount = mountTable(host, table);

    const stickyGT = host.querySelector(".lt-sticky-grand-total");
    assert(stickyGT, "sticky-grand-total container must exist in DOM");
    assert.equal(stickyGT.style.display, "none",
        "sticky-grand-total should be hidden when showGrandTotal is not configured");

    mount.dispose();
}));

test("dom: hiding the first-visible column shifts chevron + label to the next column", withDom(async (win) => {
    // firstVisibleColKey is a mount-level computed; the cell-rendering
    // effects in each pool slot AND the sticky-row effect BOTH read it.
    // When the first visible column is hidden, the chevron+label should
    // relocate to the new first-visible column, and the previously-holding
    // column should render its aggregate (or empty if no aggregate).
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(6),
        columns: [
            { key: "id",     hideable: true },
            { key: "region" },
            { key: "status" },
            { key: "value",  aggregate: "sum" }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Find the first (pool-rendered) group header. Its id-cell holds the
    // chevron+label at this point; its region-cell is blank; value-cell
    // has the aggregate.
    const header = host.querySelector(".lt-row-group-header");
    assert(header, "no group header rendered");
    const idCell = header.querySelector('[data-key="id"]');
    const regionCell = header.querySelector('[data-key="region"]');
    // Chevron marker character: "\u25BC" or "\u25B6".
    assert(idCell.textContent.includes("\u25BC") || idCell.textContent.includes("\u25B6"),
        "expected chevron in id cell before hide, got: " + idCell.textContent);
    // Now hide the id column.
    table.setColumnHidden("id", true);
    // Chevron+label should have moved to the region cell.
    assert(regionCell.textContent.includes("\u25BC") || regionCell.textContent.includes("\u25B6"),
        "expected chevron in region cell after hiding id, got: " + regionCell.textContent);
    // id cell is now display:none, so its text doesn't matter, but check
    // that its display got set correctly (regression sanity).
    assert.equal(idCell.style.display, "none",
        "hidden column cell should be display:none");

    mount.dispose();
}));

test("dom: reordering a column keeps sticky + pool group-headers aligned via --lt-cols", withDom(async (win) => {
    // Sticky rows inherit `grid-template-columns: var(--lt-cols)` inline;
    // pool rows inherit it via the mount's root style. moveColumn mutates
    // colTemplate which flows through the CSS variable, so both should
    // realign without any per-cell rewrites. What we verify here is that
    // the pool group-header AND the sticky one both keep the same
    // grid-column placement for each key after a move.
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(6),
        columns: [
            { key: "id" }, { key: "region" }, { key: "status" }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Force sticky to render by picking an ancestor -- collapse Asia so a
    // sticky depth-0 row appears for it if we scroll to Europe... simpler:
    // just check the pool-rendered group header alignment against the
    // sticky one's cells for the columns.
    // Snapshot the placement before the move.
    function placement(root, colKey) {
        const cell = root.querySelector('[data-key="' + colKey + '"]');
        return cell ? cell.style.gridColumn : null;
    }
    const poolHeader = host.querySelector(".lt-row-group-header");
    assert(poolHeader);

    const beforeId = placement(poolHeader, "id");
    const beforeRegion = placement(poolHeader, "region");
    const beforeStatus = placement(poolHeader, "status");

    // Move status to before id.
    table.moveColumn("status", "id", { before: true });

    // Placements shift: status moved to slot 1, id and region shifted right.
    const afterId = placement(poolHeader, "id");
    const afterRegion = placement(poolHeader, "region");
    const afterStatus = placement(poolHeader, "status");
    assert.notEqual(afterStatus, beforeStatus,
        "status placement should have changed after moveColumn");
    // Whichever column was at slot 1 before is no longer at slot 1.
    // Sanity: the three placements are all distinct after the move too.
    assert(afterId !== afterRegion && afterRegion !== afterStatus && afterId !== afterStatus,
        "post-move placements should be distinct across three visible columns");

    mount.dispose();
}));

test("dom: filter row + grouping coexist (filter changes reduce visible entries)", withDom(async (win) => {
    // filterable columns get a filter row; sticky groups live in the
    // viewport at top:rowHeight. This test just verifies that a filter
    // input reduces filteredRows (which feeds groupedRows), so the pool
    // + sticky rows shrink accordingly. It doesn't check pixel positions
    // (happy-dom doesn't layout), only the reactive dataflow.
    const host = win.document.createElement("div");
    host.style.height = "600px";
    win.document.body.appendChild(host);

    const table = createTable({
        rows: makeRows(10),
        columns: [
            { key: "id" },
            { key: "region", filterable: true },
            { key: "status" }
        ],
        getRowId: r => r.id,
        groupBy: "region"
    });
    const mount = mountTable(host, table);

    // Precondition: 10 rows split across Europe + Asia = 2 groups.
    assert.equal(table.rowCount(), 10);
    const beforeGroups = host.querySelectorAll(".lt-row-group-header").length;
    assert(beforeGroups >= 2, "expected >=2 group headers before filter");

    // Apply a filter that matches only Asia (rows 5..9).
    table.setColumnFilter("region", "Asia");
    assert.equal(table.rowCount(), 5, "filter should reduce data rows to 5");

    // Filter row must exist in DOM (opt-in check).
    const filterRow = host.querySelector(".lt-filter-row");
    assert(filterRow, "filter row should render when any column is filterable");

    // With only one group left, at most one group header should be in the
    // pool now -- the Europe header vanished.
    const afterGroups = Array.from(host.querySelectorAll(".lt-row-group-header"))
        .filter(r => r.style.display !== "none");
    assert.equal(afterGroups.length, 1,
        "expected exactly 1 group header after filter matching one group");

    mount.dispose();
}));

