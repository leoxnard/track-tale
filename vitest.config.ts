import { defineConfig } from "vitest/config";

// Deliberately not vite.config.ts: the react-router plugin builds an app, and
// these tests only cover the pure ingestion/rendering logic underneath it.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
