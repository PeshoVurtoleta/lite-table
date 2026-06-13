/**
 * Minimal-viable virtualization. The "what you find in a tutorial" baseline.
 *
 *   - Recomputes innerHTML on every scroll event.
 *   - DOM nodes are created and destroyed per scroll-into-view.
 *   - Each scroll event allocates `visibleCount + 2*overscan` new elements
 *     and discards the previous batch.
 *   - No reactivity, no recycling, no Object.is gating.
 *
 * This is the baseline that lite-table's slot pool + reactive bindings exist
 * to avoid. It is correct -- the grid renders the right rows -- but every
 * scroll event causes GC pressure.
 */

import { document } from "./_harness.js";

export function naiveMount(host, opts) {
    const { rows, columns, rowHeight, viewportHeight, overscan = 4 } = opts;
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;

    const root = document.createElement("div");
    root.className = "naive-root";
    root.style.cssText =
        "width:100%;height:" + viewportHeight + "px;overflow:auto;position:relative;";

    const inner = document.createElement("div");
    inner.style.cssText = "position:relative;width:100%;";
    inner.style.height = (rows.length * rowHeight) + "px";
    root.appendChild(inner);

    function render(scrollTop) {
        const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
        const end = Math.min(rows.length, start + visibleCount);

        // The pattern that makes this expensive: nuke and rebuild.
        let html = "";
        for (let i = start; i < end; i++) {
            const top = i * rowHeight;
            html += '<div class="naive-row" style="position:absolute;top:' + top +
                    'px;left:0;right:0;height:' + rowHeight +
                    'px;display:flex">';
            for (const c of columns) {
                html += '<div class="naive-cell" style="width:' + c.width +
                        'px;padding:6px 12px;overflow:hidden">' +
                        (rows[i][c.key] == null ? "" : rows[i][c.key]) +
                        '</div>';
            }
            html += '</div>';
        }
        inner.innerHTML = html;
    }

    render(0);
    root.addEventListener("scroll", () => render(root.scrollTop));
    host.appendChild(root);

    return {
        root, render,
        dispose() {
            if (root.parentNode) root.parentNode.removeChild(root);
        }
    };
}
