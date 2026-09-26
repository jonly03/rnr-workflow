import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  use: {
    baseURL: process.env.WEB_BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure"
  },
  reporter: [["list"], ["html", { open: "never" }]]
});
