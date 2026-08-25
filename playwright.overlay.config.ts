import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./agents/qa-automation",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  reporter: "line",
  use: {
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
