import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom has no `ResizeObserver`, which `react-resizable-panels` (used by the
 * query editor, schema editors, and data table layouts) constructs on mount.
 * A no-op polyfill keeps panel-based components renderable in tests.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * jsdom omits pointer-capture and scroll APIs that Radix popups (dropdowns,
 * menus, selects) call while opening. Provide no-op fallbacks so those
 * components remain interactive in tests.
 */
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

if (typeof HTMLElement.prototype.hasPointerCapture === "undefined") {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}

afterEach(() => {
  cleanup();
});
