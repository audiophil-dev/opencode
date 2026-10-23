// Permanent regression for the find-Range lifecycle gap: the actual session-ui File
// component mounts the real pierre renderer and real createFileFind; the test opens find
// through the registered handle, types into the real find input, advances to match 2/2,
// then forces the renderer's own re-render. Because the re-render replaces line DOM, the
// registered current Range collapses in place (key present, text empty) unless
// FileOptions.onPostRender re-scans. HappyDOM was measured unfaithful here (Range keeps
// its text after the endpoint node detaches), so this runs in Chromium.
import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type Page } from "@playwright/test"

const fixture = fileURLToPath(new URL("./file-find-postrender.fixture.tsx", import.meta.url))
const themeRegister = fileURLToPath(new URL("../../ui/src/context/marked-theme-register.tsx", import.meta.url))

type Snapshot = {
  bar: string | null
  query: string | null
  currentText: string[]
  currentCollapsed: boolean[]
  currentCount: number
  allCount: number
  phases: string[]
  scrollCalls: number
  lines: number
}

type Harness = {
  mode: "text" | "diff"
  focus: () => void
  snapshot: () => Snapshot
  captureAndRerender: () => { after: Snapshot; old: { text: string; connected: boolean }[] }
}

let root: string
let fixtureJs: string
let fixtureHtml: string
let browser: Browser
const ORIGIN = "http://file-find-postrender.test"

async function buildFixture() {
  const appRequire = createRequire(import.meta.url)
  const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
  const babel = solidRequire("@babel/core")
  const presetSolid = solidRequire("babel-preset-solid")
  const presetTypeScript = solidRequire("@babel/preset-typescript")
  const workerStub = `
    import { registerOpenCodeTheme } from ${JSON.stringify(themeRegister)}
    registerOpenCodeTheme()
    export function getWorkerPool() { return undefined }
  `
  const result = await Bun.build({
    entrypoints: [fixture],
    outdir: root,
    target: "browser",
    format: "esm",
    plugins: [
      {
        name: "file-find-postrender-worker-stub",
        setup(build) {
          build.onResolve({ filter: /[\\/]pierre[\\/]worker(\.ts)?$/ }, () => ({
            path: "file-find-postrender-worker",
            namespace: "test-worker",
          }))
          build.onLoad({ filter: /.*/, namespace: "test-worker" }, () => ({
            contents: workerStub,
            loader: "js",
          }))
        },
      },
      {
        name: "file-find-postrender-solid",
        setup(build) {
          build.onLoad({ filter: /\.tsx$/ }, async (args) => {
            if (args.path.includes("/node_modules/.bun/")) return
            const code = await Bun.file(args.path).text()
            const out = await babel.transformAsync(code, {
              filename: args.path,
              configFile: false,
              babelrc: false,
              presets: [
                [presetSolid, { generate: "dom", hydratable: false }],
                [presetTypeScript, {}],
              ],
            })
            return { contents: out?.code ?? code, loader: "js" }
          })
        },
      },
    ],
  })
  if (!result.success) throw new Error(`fixture build failed: ${result.logs.map(String).join("\n")}`)
}

let harness: Promise<void> | undefined

async function startHarness() {
  root = await mkdtemp(join(tmpdir(), "opencode-find-postrender-"))
  await buildFixture()
  fixtureJs = await Bun.file(join(root, "file-find-postrender.fixture.js")).text()
  fixtureHtml =
    '<!doctype html><meta charset="utf-8"><style>diffs-container{display:block;width:600px}</style>' +
    '<script type="module" src="/fixture.js"></script>'
  // Project-dedicated configs launch the installed Chromium directly; no browser download.
  browser = await chromium.launch({ executablePath: "/usr/bin/chromium" })
}

function ensureHarness() {
  harness ??= startHarness()
  return harness
}

async function open(mode: "text" | "diff"): Promise<Page> {
  const page = await browser.newPage()
  await page.route(`${ORIGIN}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/fixture.js") {
      return route.fulfill({ body: fixtureJs, contentType: "text/javascript" })
    }
    return route.fulfill({ body: fixtureHtml, contentType: "text/html" })
  })
  await page.goto(`${ORIGIN}/?mode=${mode}`)
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __fileFindPostRender?: Harness }).__fileFindPostRender
      return api != null && api.snapshot().lines > 0 && api.snapshot().phases.includes("mount")
    },
    undefined,
    { timeout: 15000 },
  )
  return page
}

async function runCase(mode: "text" | "diff") {
  await ensureHarness()
  const page = await open(mode)
  try {
    const before = await page.evaluate(() =>
      (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.snapshot(),
    )
    expect(before.currentCount).toBe(0)
    expect(before.lines).toBeGreaterThan(0)

    await page.evaluate(() => (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.focus())
    await page.waitForSelector("input", { timeout: 5000 })
    await page.locator("input").fill("answer")
    await page.waitForFunction(
      () => (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.snapshot().bar === "1/2",
      undefined,
      { timeout: 5000 },
    )
    await page.keyboard.press("Enter")
    await page.waitForFunction(
      () => (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.snapshot().bar === "2/2",
      undefined,
      { timeout: 5000 },
    )

    const found = await page.evaluate(() =>
      (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.snapshot(),
    )
    expect(found.query).toBe("answer")
    expect(found.currentText).toEqual(["answer"])
    expect(found.currentCollapsed).toEqual([false])

    const { after, old } = await page.evaluate(() =>
      (window as unknown as { __fileFindPostRender: Harness }).__fileFindPostRender.captureAndRerender(),
    )
    expect(old.length).toBeGreaterThan(0)
    expect(old.every((entry) => entry.text.includes("answer") && entry.connected === false)).toBe(true)

    // The renderer emitted its own post-render phase, and the caller hook was chained
    // (it is how the instance became reachable at all).
    expect(after.phases).toContain("update")
    expect(after.phases.length).toBe(found.phases.length + 1)

    // Match state survives: same query, same 2/2 index, live Range text restored.
    expect(after.query).toBe("answer")
    expect(after.bar).toBe("2/2")
    expect(after.currentCount).toBe(1)
    expect(after.allCount).toBe(1)
    expect(after.currentText).toEqual(["answer"])
    expect(after.currentCollapsed).toEqual([false])
    expect(after.scrollCalls).toBe(0)
  } finally {
    await page.close()
  }
}

afterAll(async () => {
  await browser?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

test("unified TextViewer restores the find Range after a renderer re-render", () => runCase("text"), 60000)

test("DiffViewer restores the find Range after a renderer re-render", () => runCase("diff"), 60000)
