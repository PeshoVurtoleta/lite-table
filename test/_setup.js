/**
 * Test bootstrap: install happy-dom globals before tests import lite-table.
 *
 * happy-dom is closer to a browser than jsdom for our purposes (better
 * MutationObserver semantics, smaller surface). lite-signal-dom relies on
 * a document-level MutationObserver for auto-disposal, so we need a real
 * one -- happy-dom provides it.
 */

import { Window } from "happy-dom";
import { createRegistry, setDefaultRegistry } from "@zakkster/lite-signal";

// Use a growable registry across all tests. Default lite-signal config caps
// at 1024 nodes; a test file that creates and disposes many tables (even
// with proper disposal) can peak above that for legitimate reasons. The
// production guidance is the opposite: pick a tight cap so leaks surface
// as CapacityError. Tests grow.
setDefaultRegistry(createRegistry({
    onCapacityExceeded: "grow",
    initialNodes: 2048
}));

/**
 * Install a fresh window. Returns the window so tests can mutate it (e.g.,
 * dispatch scroll events).
 */
export function setupDom() {
    const win = new Window({
        url: "http://localhost/",
        innerWidth: 1024,
        innerHeight: 768
    });
    const g = /** @type {any} */ (globalThis);
    g.window = win;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.Element = win.Element;
    g.Node = win.Node;
    g.MutationObserver = win.MutationObserver;
    g.ResizeObserver = win.ResizeObserver;
    g.requestAnimationFrame = win.requestAnimationFrame
        ? win.requestAnimationFrame.bind(win)
        : (cb) => setTimeout(cb, 16);
    g.cancelAnimationFrame = win.cancelAnimationFrame
        ? win.cancelAnimationFrame.bind(win)
        : (id) => clearTimeout(id);
    return win;
}

/**
 * Fire a scroll event on a viewport. happy-dom does not auto-dispatch a
 * scroll event when scrollTop is set imperatively.
 */
export function fireScroll(el, top) {
    el.scrollTop = top;
    const ev = new el.ownerDocument.defaultView.Event("scroll", { bubbles: false });
    el.dispatchEvent(ev);
}

/**
 * happy-dom does not invoke ResizeObserver callbacks automatically. Tests
 * that depend on a viewport size set it directly on the axis via the mount
 * options or by patching clientHeight via Object.defineProperty.
 */
export function setClientHeight(el, h) {
    Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
}
