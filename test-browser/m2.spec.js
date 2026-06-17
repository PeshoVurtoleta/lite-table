// test-browser/m2.spec.js -- M2: filtering + editing end-to-end in the demo
import { test, expect } from "@playwright/test";

const ROUTE = "/demo/index.html";

test.describe("lite-table M2: filtering", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(ROUTE, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__demoReady === true);
        await page.waitForTimeout(150);
    });

    test("filter row renders one input per filterable column", async ({ page }) => {
        const count = await page.evaluate(() =>
            document.querySelectorAll(".lt-filter-input").length);
        expect(count).toBe(5);   // name, email, role, team, value
    });

    test("non-filterable columns have no input in the filter row", async ({ page }) => {
        const hasIdInput = await page.evaluate(() =>
            !!document.querySelector('.lt-filter-cell[data-key="id"] input'));
        const hasActiveInput = await page.evaluate(() =>
            !!document.querySelector('.lt-filter-cell[data-key="active"] input'));
        expect(hasIdInput).toBe(false);
        expect(hasActiveInput).toBe(false);
    });

    test("typing into name filter narrows visibleRows", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Name"]').fill("al");
        await page.waitForTimeout(80);
        const state = await page.evaluate(() => ({
            visible: window.__demo.table.visibleRows().length,
            filterCount: window.__demo.table.columnFilters().size,
        }));
        expect(state.visible).toBeGreaterThan(0);
        expect(state.visible).toBeLessThan(25);
        expect(state.filterCount).toBe(1);
    });

    test("custom filter on value column with > and < operators", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Value"]').fill(">500");
        await page.waitForTimeout(80);
        const allOver = await page.evaluate(() =>
            window.__demo.table.visibleRows().every(r => r.value > 500));
        expect(allOver).toBe(true);

        await page.locator('.lt-filter-input[aria-label="Filter Value"]').fill("<100");
        await page.waitForTimeout(80);
        const allUnder = await page.evaluate(() =>
            window.__demo.table.visibleRows().every(r => r.value < 100));
        expect(allUnder).toBe(true);
    });

    test("multiple filters apply as AND", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Role"]').fill("engineer");
        await page.locator('.lt-filter-input[aria-label="Filter Name"]').fill("al");
        await page.waitForTimeout(80);
        const state = await page.evaluate(() => {
            const rows = window.__demo.table.visibleRows();
            return {
                count: rows.length,
                allMatch: rows.every(r => r.role === "engineer" && r.name.toLowerCase().includes("al")),
            };
        });
        expect(state.allMatch).toBe(true);
    });

    test("Escape on filter input clears that column's filter", async ({ page }) => {
        const input = page.locator('.lt-filter-input[aria-label="Filter Name"]');
        await input.fill("alice");
        await page.waitForTimeout(50);
        await input.focus();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(50);
        const state = await page.evaluate(() => ({
            inputValue: document.querySelector('.lt-filter-input[aria-label="Filter Name"]').value,
            filterCount: window.__demo.table.columnFilters().size,
        }));
        expect(state.inputValue).toBe("");
        expect(state.filterCount).toBe(0);
    });

    test("clear-filters button empties all inputs + state", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Name"]').fill("a");
        await page.locator('.lt-filter-input[aria-label="Filter Role"]').fill("eng");
        await page.waitForTimeout(50);
        await page.click("#clear-filters");
        await page.waitForTimeout(50);
        const state = await page.evaluate(() => ({
            filterCount: window.__demo.table.columnFilters().size,
            allEmpty: Array.from(document.querySelectorAll(".lt-filter-input"))
                .every(i => i.value === ""),
        }));
        expect(state.filterCount).toBe(0);
        expect(state.allEmpty).toBe(true);
    });

    test("filter + sort interact correctly (filter first, then sort)", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Role"]').fill("engineer");
        await page.waitForTimeout(50);
        // Click value header to sort asc
        await page.evaluate(() => window.__demo.table.setSort("value", "asc"));
        await page.waitForTimeout(50);
        const rows = await page.evaluate(() =>
            window.__demo.table.visibleRows().map(r => ({ role: r.role, value: r.value })));
        expect(rows.every(r => r.role === "engineer")).toBe(true);
        // Ascending order
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i].value).toBeGreaterThanOrEqual(rows[i - 1].value);
        }
    });

    test("filter + export: visible rows are already filtered", async ({ page }) => {
        await page.locator('.lt-filter-input[aria-label="Filter Role"]').fill("engineer");
        await page.waitForTimeout(80);
        const csv = await page.evaluate(() => window.__demo.table.exportCsv());
        const lines = csv.split("\r\n");
        // Every data line should have "engineer" somewhere
        const dataLines = lines.slice(1).filter(l => l.length > 0);
        expect(dataLines.every(l => l.toLowerCase().includes("engineer"))).toBe(true);
    });
});

test.describe("lite-table M2: cell editing", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(ROUTE, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__demoReady === true);
        await page.waitForTimeout(150);
    });

    test("dblclick on editable cell starts editing", async ({ page }) => {
        await page.locator('.lt-row').first().locator('[data-key="name"]').dblclick();
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            hasContenteditable: !!document.querySelector('.lt-cell[data-key="name"][contenteditable="true"]'),
            hasIsEditing: !!document.querySelector('.lt-cell[data-key="name"].is-editing'),
        }));
        expect(state.editingCell).toEqual({ rowId: 1, columnKey: "name" });
        expect(state.hasContenteditable).toBe(true);
        expect(state.hasIsEditing).toBe(true);
    });

    test("dblclick on non-editable cell does NOT start editing", async ({ page }) => {
        await page.locator('.lt-row').first().locator('[data-key="id"]').dblclick();
        await page.waitForTimeout(100);
        const editingCell = await page.evaluate(() => window.__demo.table.editingCell());
        expect(editingCell).toBe(null);
    });

    test("Enter commits edit + fires onCellEdit", async ({ page }) => {
        const cell = page.locator('.lt-row').first().locator('[data-key="name"]');
        await cell.dblclick();
        await page.waitForTimeout(100);
        await page.keyboard.press("Control+A");
        await page.keyboard.type("Edited Name");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            firstRowName: window.__demo.allRows[0].name,
            editLog: document.getElementById("edit-log").textContent,
        }));
        expect(state.editingCell).toBe(null);
        expect(state.firstRowName).toBe("Edited Name");
        expect(state.editLog).toMatch(/edited row 1.*name.*Edited Name/);
    });

    test("Escape cancels edit without firing onCellEdit", async ({ page }) => {
        const beforeName = await page.evaluate(() => window.__demo.allRows[0].name);
        const cell = page.locator('.lt-row').first().locator('[data-key="name"]');
        await cell.dblclick();
        await page.waitForTimeout(100);
        await page.keyboard.press("Control+A");
        await page.keyboard.type("WOULD_BE_CANCELLED");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            firstRowName: window.__demo.allRows[0].name,
        }));
        expect(state.editingCell).toBe(null);
        expect(state.firstRowName).toBe(beforeName);
    });

    test("blur (focus loss) commits the edit", async ({ page }) => {
        const cell = page.locator('.lt-row').first().locator('[data-key="email"]');
        await cell.dblclick();
        await page.waitForTimeout(100);
        await page.keyboard.press("Control+A");
        await page.keyboard.type("new@x.com");
        // Click outside to blur
        await page.click("h1");
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            firstRowEmail: window.__demo.allRows[0].email,
        }));
        expect(state.editingCell).toBe(null);
        expect(state.firstRowEmail).toBe("new@x.com");
    });

    test("commitEdit skips onCellEdit when value unchanged", async ({ page }) => {
        const beforeLog = await page.evaluate(() =>
            document.getElementById("edit-log").textContent);
        const cell = page.locator('.lt-row').first().locator('[data-key="name"]');
        await cell.dblclick();
        await page.waitForTimeout(100);
        // Don't change anything, just press Enter
        await page.keyboard.press("Enter");
        await page.waitForTimeout(100);
        const afterLog = await page.evaluate(() =>
            document.getElementById("edit-log").textContent);
        // Log unchanged because onCellEdit didn't fire
        expect(afterLog).toBe(beforeLog);
    });

    test("Tab commits + moves focus right", async ({ page }) => {
        const cell = page.locator('.lt-row').first().locator('[data-key="name"]');
        await cell.dblclick();
        await page.waitForTimeout(100);
        await page.keyboard.press("Control+A");
        await page.keyboard.type("Tabbed");
        await page.keyboard.press("Tab");
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            focusedCell: window.__demo.table.focusedCell(),
            firstRowName: window.__demo.allRows[0].name,
        }));
        expect(state.editingCell).toBe(null);
        expect(state.firstRowName).toBe("Tabbed");
        // moveFocus("right") moved focus to the next column
        expect(state.focusedCell?.columnKey).toBe("email");
    });

    test("F2 on focused cell starts editing", async ({ page }) => {
        // Click the name cell to focus it (without starting edit)
        const cell = page.locator('.lt-row').first().locator('[data-key="name"]');
        await cell.click();
        await page.waitForTimeout(100);
        // Make sure root has focus
        await page.evaluate(() => document.querySelector(".lt-root").focus());
        await page.keyboard.press("F2");
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
        }));
        expect(state.editingCell).toEqual({ rowId: 1, columnKey: "name" });
    });

    test("starting edit on a second cell commits the first", async ({ page }) => {
        // Edit name
        await page.locator('.lt-row').first().locator('[data-key="name"]').dblclick();
        await page.waitForTimeout(100);
        await page.keyboard.press("Control+A");
        await page.keyboard.type("First Edit");
        // Now dblclick another editable cell (email)
        await page.locator('.lt-row').first().locator('[data-key="email"]').dblclick();
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => ({
            editingCell: window.__demo.table.editingCell(),
            firstRowName: window.__demo.allRows[0].name,
        }));
        // First edit auto-committed
        expect(state.firstRowName).toBe("First Edit");
        // Now editing email
        expect(state.editingCell?.columnKey).toBe("email");
    });
});
