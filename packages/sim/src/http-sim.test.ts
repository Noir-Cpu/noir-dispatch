import { describe, expect, it } from "vitest";
import { runBurst } from "./http-sim";

const reset = () => Object.assign(new TypeError("fetch failed"), { cause: new Error("read ECONNRESET") });
const base = { baseUrl: "https://sim.test", token: "t", seed: 1, sleep: async () => {} };

describe("runBurst network errors", () => {
  it("retries a dropped connection instead of failing the burst", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      if (calls === 1) throw reset();
      return new Response(JSON.stringify({ error: "stop" }), { status: 500 });
    }) as typeof globalThis.fetch;
    // The 500 after the retry proves the reset was retried rather than surfaced.
    await expect(runBurst({ ...base, fetch })).rejects.toThrow(/stop/);
    expect(calls).toBe(2);
  });

  it("gives up after three attempts", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      throw reset();
    }) as typeof globalThis.fetch;
    await expect(runBurst({ ...base, fetch })).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });
});
