import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markIntervalsSyncPending, restoreIntervalsSyncButton } from "./intervals-sync-button.ts";

function button() {
  const attrs = new Map<string, string>();
  return {
    disabled: false,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    attrs,
  };
}

describe("Intervals Sync now bfcache", () => {
  it("disables the button while the request runs and re-enables it after a persisted pageshow", () => {
    const sync = button();
    markIntervalsSyncPending(sync);
    assert.equal(sync.disabled, true);
    assert.equal(sync.attrs.get("aria-busy"), "true");

    restoreIntervalsSyncButton(sync, false);
    assert.equal(sync.disabled, true);
    assert.equal(sync.attrs.get("aria-busy"), "true");

    restoreIntervalsSyncButton(sync, true);
    assert.equal(sync.disabled, false);
    assert.equal(sync.attrs.has("aria-busy"), false);
  });
});
