import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  e2eRoot,
  fakeCodexBinDirectory,
  fakeCursorAgentPath,
  repositoryRoot,
  toolTestCommandPath
} from "./e2e/support/paths";

const appPort = 38_787;
const firecrawlPort = 39_002;
const appBaseUrl = `http://127.0.0.1:${appPort}`;
const firecrawlBaseUrl = `http://127.0.0.1:${firecrawlPort}`;
delete process.env.NO_COLOR;
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  forbidOnly: Boolean(process.env.CI),
  outputDir: path.join(repositoryRoot, "test-results"),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: appBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run test:e2e:firecrawl",
      url: `${firecrawlBaseUrl}/health`,
      env: {
        ...inheritedEnv,
        E2E_FIRECRAWL_PORT: String(firecrawlPort)
      },
      timeout: 30_000,
      reuseExistingServer: false
    },
    {
      command: "npm run test:e2e:serve",
      url: `${appBaseUrl}/api/config`,
      env: {
        ...inheritedEnv,
        PORT: String(appPort),
        NODE_ENV: "development",
        VPP_E2E_HMR_PORT: String(appPort + 1),
        OPENAI_API_KEY: "e2e-not-used",
        OPENAI_BASE_URL: "http://127.0.0.1:1",
        PROJECTS_FILE: path.join(e2eRoot, "projects.json"),
        WORKSPACE_ROOT: path.join(e2eRoot, "unused-default"),
        NO_PROJECT_WORKSPACE: path.join(e2eRoot, "no-project"),
        FIRECRAWL_BASE_URL: firecrawlBaseUrl,
        CODING_AGENT: "cursor",
        CURSOR_MODEL: "cursor-e2e-model",
        CURSOR_AGENT_COMMAND: fakeCursorAgentPath,
        TEST_COMMAND: `node ${toolTestCommandPath}`,
        PATH: [fakeCodexBinDirectory, inheritedEnv.PATH].filter(Boolean).join(path.delimiter)
      },
      timeout: 60_000,
      reuseExistingServer: false
    }
  ]
});
