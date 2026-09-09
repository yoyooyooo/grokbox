import { describe, expect, test } from "bun:test";
import { modeldRootLayer } from "../src/internal/roots/modeld.runtime.ts";

describe("modeld root construction", () => {
  test("Layer construction does not send model requests", () => {
    let http = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      http += 1;
      throw new Error("no fetch");
    }) as unknown as typeof fetch;
    try {
      modeldRootLayer({ durableRoot: "/tmp", runRoot: "/tmp", serviceEpoch: "svc", env: {} });
      expect(http).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
