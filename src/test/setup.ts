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

afterEach(() => {
  cleanup();
});
