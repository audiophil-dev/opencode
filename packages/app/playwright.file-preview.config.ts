// Dedicated, fail-closed Playwright config for the packaged file-preview suite.
// It deliberately does NOT import the upstream playwright.config.ts, which targets
// the production backend port 4096 and may reuse an existing server.
import { defineConfig, devices } from "@playwright/test"

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]+$/

const missing: string[] = []
const requireVar = (name: string): string => {
  const value = process.env[name]
  if (!value) missing.push(name)
  return value ?? ""
}

const bin = requireVar("FILE_PREVIEW_BIN")
const testRoot = requireVar("FILE_PREVIEW_TEST_ROOT")
const buildId = requireVar("FILE_PREVIEW_BUILD_ID")
if (missing.length > 0) {
  throw new Error(`playwright.file-preview.config.ts: missing required fixture environment: ${missing.join(", ")}`)
}
if (!bin.startsWith("/"))
  throw new Error(`playwright.file-preview.config.ts: FILE_PREVIEW_BIN must be absolute, got ${bin}`)
if (!testRoot.startsWith("/"))
  throw new Error(`playwright.file-preview.config.ts: FILE_PREVIEW_TEST_ROOT must be absolute, got ${testRoot}`)
if (!BUILD_ID_PATTERN.test(buildId)) {
  throw new Error(
    `playwright.file-preview.config.ts: FILE_PREVIEW_BUILD_ID must match ${BUILD_ID_PATTERN}, got ${buildId}`,
  )
}

const port = process.env.FILE_PREVIEW_TEST_PORT ? Number(process.env.FILE_PREVIEW_TEST_PORT) : 4196
if (port === 4096 || port === 4097) throw new Error(`playwright.file-preview.config.ts: port ${port} is reserved`)
const baseURL = `http://127.0.0.1:${port}`

const reporters: import("@playwright/test").ReporterDescription[] = [["line"]]
if (process.env.FILE_PREVIEW_RESULTS_JSON) {
  reporters.push(["json", { outputFile: process.env.FILE_PREVIEW_RESULTS_JSON }])
}

export default defineConfig({
  testDir: "./e2e/file-preview",
  testMatch: "**/*.spec.ts",
  outputDir: "./e2e/file-preview-results",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: reporters,
  webServer: {
    // `exec` makes the wrapper replace the shell so the tracked pid is the
    // process that owns the signal handlers and the fixture backend.
    command: "exec bun e2e/file-preview/server.ts",
    // Readiness is the wrapper's own stdout line, printed only after its
    // authed-200 + anonymous-401 health proof. No `url`: Playwright's HTTP
    // probe is unbounded and can return early on an unarmed 200/401.
    wait: { stdout: /file-preview fixture backend ready at/ },
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env } as Record<string, string>,
  },
  use: {
    baseURL,
    httpCredentials: { username: "fixture", password: "fixture-only" },
    trace: "on",
    screenshot: "on",
    // No browser downloads are permitted on this machine; the suite runs on the
    // installed system Chromium (task 3 contract).
    launchOptions: { executablePath: "/usr/bin/chromium" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
