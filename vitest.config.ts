import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // Cada archivo de prueba usa su propia base en memoria (PGlite); no hace falta aislarlos más.
    pool: "forks",
  },
});
