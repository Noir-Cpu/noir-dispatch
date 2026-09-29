import { defineConfig } from "vitest/config";

// Engine tests start an in-memory Postgres per test; CI runners are slower than laptops.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
