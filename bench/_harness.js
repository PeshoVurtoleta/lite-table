/**
 * Benchmark harness. Two pieces of telemetry:
 *
 *   1. instrumentDom() patches Element.prototype methods to count actual DOM
 *      mutations -- this is the metric that proves "zero-GC scroll", because
 *      it isolates work we cause from work happy-dom would do anyway.
 *
 *   2. time() / heap() wrap perf timing and Node's heap measurement.
 *
 * Honest framing: numbers are from happy-dom under Node, not a real browser.
 * What's REAL here:
 *   - DOM mutation COUNTS are exact (we count call sites).
 *   - lite-signal graph counts (stats()) are exact.
 *   - Pool size is exact.
 *   - Relative timing between implementations under the same harness.
 * What's NOT real here:
 *   - Absolute frame times. Browsers have very different rendering costs.
 *   - GC pauses. V8 in Node has different patterns than in Chrome.
 *
 * For absolute browser numbers, open the demo and profile in DevTools.
 */

import { Window } from "happy-dom";

// ----- Global DOM setup (must happen before requiring DOM-touching libs) ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.MouseEvent = window.MouseEvent;
globalThis.PointerEvent = window.PointerEvent || window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Default lite-signal registry: grow, so bench programs can construct large
// tables without hitting the 1024 cap.
const { createRegistry, setDefaultRegistry } = await import("@zakkster/lite-signal");
setDefaultRegistry(createRegistry({
    onCapacityExceeded: "grow",
    initialNodes: 65536
}));

export { window, document };

// ----- DOM write counter ----------------------------------------------------

let _counts = null;
const _ProtoElement = window.Element.prototype;
const _ProtoNode = window.Node.prototype;

// Capture originals.
const _innerHTMLDesc = Object.getOwnPropertyDescriptor(_ProtoElement, "innerHTML")
    || Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerHTML");
// happy-dom defines textContent on Element.prototype (it overrides Node's).
// Look for the setter on Element first, fall back to Node.
const _textContentDesc =
    Object.getOwnPropertyDescriptor(_ProtoElement, "textContent")
    || Object.getOwnPropertyDescriptor(_ProtoNode, "textContent");
const _textContentTarget =
    Object.getOwnPropertyDescriptor(_ProtoElement, "textContent")
        ? _ProtoElement : _ProtoNode;
const _orig = {
    appendChild: _ProtoNode.appendChild,
    insertBefore: _ProtoNode.insertBefore,
    removeChild: _ProtoNode.removeChild,
    setAttribute: _ProtoElement.setAttribute,
    removeAttribute: _ProtoElement.removeAttribute,
    textContent: _textContentDesc,
    innerHTML: _innerHTMLDesc
};

let _patched = false;
let _inSyntheticWrite = 0;  // Re-entry guard: skip counting appendChild
                            // when it's called by happy-dom's textContent /
                            // innerHTML internals. Real browsers don't pay
                            // alloc cost for those; this restores parity.
function patch() {
    if (_patched) return;
    _patched = true;
    _ProtoNode.appendChild = function (child) {
        if (_counts && !_inSyntheticWrite) _counts.appendChild++;
        return _orig.appendChild.call(this, child);
    };
    _ProtoNode.insertBefore = function (child, ref) {
        if (_counts && !_inSyntheticWrite) _counts.insertBefore++;
        return _orig.insertBefore.call(this, child, ref);
    };
    _ProtoNode.removeChild = function (child) {
        if (_counts && !_inSyntheticWrite) _counts.removeChild++;
        return _orig.removeChild.call(this, child);
    };
    _ProtoElement.setAttribute = function (name, value) {
        if (_counts) _counts.setAttribute++;
        return _orig.setAttribute.call(this, name, value);
    };
    _ProtoElement.removeAttribute = function (name) {
        if (_counts) _counts.removeAttribute++;
        return _orig.removeAttribute.call(this, name);
    };
    Object.defineProperty(_textContentTarget, "textContent", {
        configurable: true,
        get: _orig.textContent.get,
        set: function (v) {
            if (_counts) _counts.textContent++;
            _inSyntheticWrite++;
            try { return _orig.textContent.set.call(this, v); }
            finally { _inSyntheticWrite--; }
        }
    });
    if (_orig.innerHTML && _orig.innerHTML.set) {
        const target = Object.getOwnPropertyDescriptor(_ProtoElement, "innerHTML")
            ? _ProtoElement : window.HTMLElement.prototype;
        Object.defineProperty(target, "innerHTML", {
            configurable: true,
            get: _orig.innerHTML.get,
            set: function (v) {
                if (_counts) _counts.innerHTML++;
                // innerHTML is the allocation -- the cost is in tree
                // construction. We attribute that to innerHTML itself
                // (1 alloc per call), not to its internal appendChild fanout.
                _inSyntheticWrite++;
                try { return _orig.innerHTML.set.call(this, v); }
                finally { _inSyntheticWrite--; }
            }
        });
    }
}
patch();

/** Start counting. */
export function startCounts() {
    _counts = {
        appendChild: 0, insertBefore: 0, removeChild: 0,
        setAttribute: 0, removeAttribute: 0,
        textContent: 0, innerHTML: 0
    };
}
/** Stop and return totals. */
export function stopCounts() {
    const c = _counts;
    _counts = null;
    if (!c) return null;
    // Two categories with different GC implications:
    //   - allocations: create / move / replace DOM nodes (GC pressure).
    //   - updates:     mutate existing nodes in place (no allocation).
    c.allocations = c.appendChild + c.insertBefore + c.innerHTML;
    c.updates     = c.setAttribute + c.removeAttribute + c.textContent;
    c.total = c.allocations + c.updates + c.removeChild;
    return c;
}

// ----- Timing & heap --------------------------------------------------------

export async function time(label, fn) {
    if (global.gc) global.gc();
    const t0 = performance.now();
    await fn();
    const t1 = performance.now();
    return { label, ms: t1 - t0 };
}

export function heap() {
    if (global.gc) global.gc();
    return process.memoryUsage().heapUsed;
}

export async function settle() {
    // Let happy-dom flush microtasks + any queued ResizeObservers (we stubbed
    // it, but the pattern remains).
    await new Promise((r) => setTimeout(r, 0));
}

// ----- Pretty print ---------------------------------------------------------

export function fmt(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(n);
}
export function fmtMs(ms) {
    if (ms < 1) return ms.toFixed(2) + " ms";
    if (ms < 10) return ms.toFixed(2) + " ms";
    if (ms < 100) return ms.toFixed(1) + " ms";
    return Math.round(ms) + " ms";
}
export function fmtBytes(b) {
    if (Math.abs(b) < 1024) return b + " B";
    if (Math.abs(b) < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(2) + " MB";
}

// ----- Dataset --------------------------------------------------------------

export function makeRows(n) {
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
        rows[i] = {
            id: i,
            name: "Row " + i,
            email: "u" + i + "@example.com",
            value: ((i * 0.13) % 1) * 1000,
            status: ["active", "pending", "archived"][i % 3]
        };
    }
    return rows;
}

export const STD_COLUMNS = [
    { key: "id",     header: "ID",     width: 80 },
    { key: "name",   header: "Name",   width: 180 },
    { key: "email",  header: "Email",  width: 220 },
    { key: "value",  header: "Value",  width: 100,
      compare: (a, b) => a - b },
    { key: "status", header: "Status", width: 110 }
];

// ----- Host helper ----------------------------------------------------------

export function makeHost(width = 1200, height = 480) {
    const host = document.createElement("div");
    host.style.width = width + "px";
    host.style.height = height + "px";
    // happy-dom does not lay out, but elements honor explicit clientHeight
    // returns of 0 unless we set it. Patch on instance.
    Object.defineProperty(host, "clientHeight", {
        configurable: true, get: () => height
    });
    Object.defineProperty(host, "clientWidth", {
        configurable: true, get: () => width
    });
    document.body.appendChild(host);
    return host;
}
