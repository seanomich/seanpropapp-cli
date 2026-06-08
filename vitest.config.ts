import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.d.ts",
        // CLI bootstrap (arg parsing exercised via the cli-help integration test)
        // and the trivial version constant are not meaningful unit-coverage targets.
        "src/index.ts",
        "src/version.ts",
      ],
      // CI gate (enforced by `npm test` -> `vitest run --coverage`). Floors are
      // set just under the current baseline (stmts 75 / branch 62.9 / funcs 67.5
      // / lines 76.9) to catch regressions. The critical src/http layer (the
      // bridge endpoints + SSE) is ~96%. Raise these as coverage improves; do not
      // lower without a reason in the PR.
      thresholds: {
        statements: 73,
        branches: 60,
        functions: 65,
        lines: 74,
      },
    },
  },
});
