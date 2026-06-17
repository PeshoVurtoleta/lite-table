// test-browser/demo.spec.js
// End-to-end browser tests against the M1.1 demo: pagination via reactive
// row source, page-size dropdown, exportCsv + exportJson buttons.

import { test, expect } from "@playwright/test";

const ROUTE = "/demo/index.html";

test.describe("lite-table M1.1 demo", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(ROUTE, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__demoReady === true);
        await page.waitForTimeout(150);
    });

    test("initial state: page 1 of 200 with size 25, 5000 master rows", async ({ page }) => {
        const state = await page.evaluate(() => ({
            pageSize: window.__demo.pageSize(),
            pageIndex: window.__demo.pageIndex(),
            pageCount: window.__demo.pageCount(),
            rowsInView: window.__demo.table.visibleRows().length,
            master: window.__demo.allRows.length,
            statusText: document.getElementById("page-status").textContent,
        }));
        expect(state.pageSize).toBe(25);
        expect(state.pageIndex).toBe(0);
        expect(state.pageCount).toBe(200);
        expect(state.rowsInView).toBe(25);
        expect(state.master).toBe(5000);
        expect(state.statusText).toBe("page 1 / 200");
    });

    test("page-size dropdown recomputes visibleRows via reactive rowsGetter", async ({ page }) => {
        await page.selectOption("#page-size", "10");
        await page.waitForTimeout(50);
        let n = await page.evaluate(() => window.__demo.table.visibleRows().length);
        expect(n).toBe(10);

        await page.selectOption("#page-size", "100");
        await page.waitForTimeout(50);
        n = await page.evaluate(() => window.__demo.table.visibleRows().length);
        expect(n).toBe(100);

        await page.selectOption("#page-size", "0");   // "All"
        await page.waitForTimeout(80);
        const state = await page.evaluate(() => ({
            n: window.__demo.table.visibleRows().length,
            status: document.getElementById("page-status").textContent,
        }));
        expect(state.n).toBe(5000);
        expect(state.status).toMatch(/all 5000/);
    });

    test("changing page size resets pageIndex to 0", async ({ page }) => {
        await page.click("#page-next");
        await page.click("#page-next");
        let idx = await page.evaluate(() => window.__demo.pageIndex());
        expect(idx).toBe(2);

        await page.selectOption("#page-size", "50");
        await page.waitForTimeout(50);
        idx = await page.evaluate(() => window.__demo.pageIndex());
        expect(idx).toBe(0);
    });

    test("first/prev/next/last buttons drive pageIndex correctly", async ({ page }) => {
        // page 1 -> next -> page 2
        await page.click("#page-next");
        expect(await page.evaluate(() => window.__demo.pageIndex())).toBe(1);

        // last -> page 200
        await page.click("#page-last");
        expect(await page.evaluate(() => window.__demo.pageIndex())).toBe(199);

        // first -> page 1
        await page.click("#page-first");
        expect(await page.evaluate(() => window.__demo.pageIndex())).toBe(0);

        // prev at first is no-op (the button is disabled, asserted in the
        // disabled-state test); dispatch the click directly to verify the
        // handler itself clamps -- defensive belt-and-braces, the button
        // should never reach the handler when disabled but the logic is
        // robust anyway.
        await page.evaluate(() => {
            document.getElementById("page-prev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(await page.evaluate(() => window.__demo.pageIndex())).toBe(0);
    });

    test("first/prev disabled at page 1; next/last disabled at last page", async ({ page }) => {
        await page.waitForTimeout(50);   // let reactive disabled-state settle
        let s = await page.evaluate(() => ({
            first: document.getElementById("page-first").disabled,
            prev: document.getElementById("page-prev").disabled,
            next: document.getElementById("page-next").disabled,
            last: document.getElementById("page-last").disabled,
        }));
        expect(s.first).toBe(true);
        expect(s.prev).toBe(true);
        expect(s.next).toBe(false);
        expect(s.last).toBe(false);

        await page.click("#page-last");
        await page.waitForTimeout(50);
        s = await page.evaluate(() => ({
            first: document.getElementById("page-first").disabled,
            prev: document.getElementById("page-prev").disabled,
            next: document.getElementById("page-next").disabled,
            last: document.getElementById("page-last").disabled,
        }));
        expect(s.first).toBe(false);
        expect(s.prev).toBe(false);
        expect(s.next).toBe(true);
        expect(s.last).toBe(true);
    });

    test("visibleRows on page N matches the N-th slice of allRows", async ({ page }) => {
        await page.selectOption("#page-size", "10");
        await page.click("#page-next");
        await page.click("#page-next");   // page 3, rows 21..30
        await page.waitForTimeout(80);

        const data = await page.evaluate(() => ({
            ids: window.__demo.table.visibleRows().map(r => r.id),
            firstMasterId: window.__demo.allRows[20].id,   // rows 21..30 → indices 20..29
            lastMasterId: window.__demo.allRows[29].id,
        }));
        expect(data.ids[0]).toBe(data.firstMasterId);
        expect(data.ids.at(-1)).toBe(data.lastMasterId);
        expect(data.ids.length).toBe(10);
    });

    test("exportCsv of visible page contains exactly that page's rows + header", async ({ page }) => {
        await page.selectOption("#page-size", "10");
        await page.click("#page-next");   // page 2
        await page.waitForTimeout(80);

        const csv = await page.evaluate(() => window.__demo.table.exportCsv());
        const lines = csv.split("\r\n");
        expect(lines.length).toBe(11);   // 1 header + 10 rows
        expect(lines[0]).toBe("ID,Name,Email,Role,Team,Value,Active");
        // page 2 with size 10 = master indices 10..19 = ids 11..20
        expect(lines[1]).toMatch(/^11,/);
        expect(lines[10]).toMatch(/^20,/);
    });

    test("exportCsv with formatter title-cases the role column", async ({ page }) => {
        // The demo's first button uses a formatter for col.key === "role"
        await page.click("#export-csv");
        // The download is triggered programmatically, but the preview also
        // shows the bytes; assert the preview contains a title-cased role.
        await page.waitForTimeout(150);
        const preview = await page.evaluate(() => document.getElementById("preview").textContent);
        // First page (25 rows) — at least one of the roles should be title-cased
        expect(preview).toMatch(/,Engineer,/);
    });

    test("selectAll + export selected against master gives 5000-row CSV", async ({ page }) => {
        await page.click("#select-all");
        await page.waitForTimeout(50);

        const csv = await page.evaluate(() =>
            window.__demo.table.exportCsv({
                rows: window.__demo.table.selectedRows(window.__demo.allRows),
            }));
        const lines = csv.split("\r\n");
        expect(lines.length).toBe(5001);
        expect(lines[0]).toBe("ID,Name,Email,Role,Team,Value,Active");
        expect(lines.at(-1)).toMatch(/^5000,/);
    });

    test("clearSelection drops selection back to 0", async ({ page }) => {
        await page.click("#select-all");
        await page.waitForTimeout(50);
        let cnt = await page.evaluate(() => window.__demo.table.selectedCount());
        expect(cnt).toBeGreaterThan(0);

        await page.click("#clear-sel");
        await page.waitForTimeout(50);
        cnt = await page.evaluate(() => window.__demo.table.selectedCount());
        expect(cnt).toBe(0);
    });

    test("exportJson against master gives a 5000-entry array", async ({ page }) => {
        const json = await page.evaluate(() =>
            window.__demo.table.exportJson({
                rows: window.__demo.allRows,
                columns: ["id", "name", "email"],
            }));
        const parsed = JSON.parse(json);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(5000);
        expect(Object.keys(parsed[0])).toEqual(["id", "name", "email"]);
        expect(parsed[0].id).toBe(1);
        expect(parsed.at(-1).id).toBe(5000);
    });

    test("exportJson with format:array returns raw array, not stringified", async ({ page }) => {
        const result = await page.evaluate(() => {
            const out = window.__demo.table.exportJson({
                rows: window.__demo.allRows,
                columns: ["id"],
                format: "array",
            });
            return { isArr: Array.isArray(out), count: out.length, first: out[0] };
        });
        expect(result.isArr).toBe(true);
        expect(result.count).toBe(5000);
        expect(result.first).toEqual({ id: 1 });
    });

    test("rendered table actually mounts and shows row data on page change", async ({ page }) => {
        // Verify the DOM shows what visibleRows says. Use .lt-row to scope to
        // data rows only (skipping the header + filter row that share role=row).
        await page.waitForTimeout(150);
        const cellsPage1 = await page.evaluate(() => {
            const rows = document.querySelectorAll(".lt-row");
            return Array.from(rows).slice(0, 3).map(r => r.textContent?.trim().slice(0, 30));
        });
        // First data row of page 1 should contain id 1
        expect(cellsPage1[0]).toMatch(/1.*Alice/);

        await page.click("#page-next");
        await page.waitForTimeout(100);
        const cellsPage2 = await page.evaluate(() => {
            const rows = document.querySelectorAll(".lt-row");
            return Array.from(rows).slice(0, 3).map(r => r.textContent?.trim().slice(0, 30));
        });
        // Page 2 with size 25 starts at id 26
        expect(cellsPage2[0]).toMatch(/26/);
    });

    test("zero memory leak: open/close 50 times keeps activeNodes flat", async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { stats } = await import("/node_modules/@zakkster/lite-signal/Signal.js");
            const { createTable } = await import("/Table.js");
            const before = stats().activeNodes;
            for (let i = 0; i < 50; i++) {
                const t = createTable({
                    rows: [{id: 1, n: "a"}, {id: 2, n: "b"}],
                    columns: [{key: "id"}, {key: "n"}],
                    getRowId: r => r.id,
                });
                t.dispose();
            }
            return { before, after: stats().activeNodes };
        });
        expect(result.after).toBe(result.before);
    });
});
