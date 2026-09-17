import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * jsdom has no layout engine, so `scrollIntoView` is simply absent. The chat
 * calls it after every render; without this stub every test would fail on a
 * missing method rather than on anything it meant to assert.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});
