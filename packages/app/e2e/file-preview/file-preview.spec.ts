// Packaged file-preview browser matrix, parameterized by the app's layout setting
// exactly as the app reads it (settings.general.newLayoutDesigns), per plan task 11.
//
// Mode contract:
// - Patched run (default): every test must pass against the staged binary.
// - Baseline comparison run (FILE_PREVIEW_BASELINE_COMPARISON=1): the same
//   behavioral assertions run unchanged and FAIL because the Preview feature is
//   absent on the unpatched baseline. No test.fail markers are applied, so the
//   suite exits nonzero with the Preview-control failures preserved as the red
//   reason. Only the packaged-identity preflight is bypassed in that mode.
// The navigation/setup test is unmarked on both sides: a failure there is a
// fixture or routing problem, never a feature result.
import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  BUDGET_DOC_PATH,
  BUDGET_IMAGE_PATH,
  FIXTURE_WORKSPACE_DIRNAME,
  fixtureEntries,
  GALLERY_DOC_PATH,
  galleryImagePaths,
  oversizedImageBase64,
  PNG_1PX_ALT,
} from "./fixtures"

const server = `http://127.0.0.1:${process.env.FILE_PREVIEW_TEST_PORT ?? 4196}`
const testRoot = process.env.FILE_PREVIEW_TEST_ROOT ?? ""
const workspace = path.join(testRoot, FIXTURE_WORKSPACE_DIRNAME)
const buildId = process.env.FILE_PREVIEW_BUILD_ID ?? ""
const baseline = process.env.FILE_PREVIEW_BASELINE_COMPARISON === "1"
const evidenceDir = process.env.FILE_PREVIEW_EVIDENCE_DIR ?? ""
// Seeded into app-version.v1 so the launch-state upgrade migration keeps the
// stored layout preference. Derived from the authenticated health endpoint (the
// request fixture carries the config's httpCredentials) because it is the only
// source that reports the real version of both patched and BASE binaries.
async function appVersion(request: APIRequestContext): Promise<string> {
  const response = await request.get("/global/health")
  expect(response.ok(), await response.text()).toBe(true)
  const body = (await response.json()) as { version: string }
  expect(body.version, "health endpoint returned no version").not.toBe("")
  return body.version
}

const readme = "readme.md"

type Layout = { name: string; newLayoutDesigns: boolean }
const layouts: Layout[] = [
  { name: "layout-v1", newLayoutDesigns: false },
  { name: "layout-v2", newLayoutDesigns: true },
]

// The mode a file tab is in BEFORE the settings flag flip must be the mode after the
// reload. Preview is the default and arms no chosen entry; Source is an actual user
// selection, so it is the variant that proves the one-time handoff. The browser key is
// the real one the product helper reads; it is asserted here, never seeded.
const RELOAD_HANDOFF_STORAGE_KEY = "opencode.file-tab-reload-handoff.v1"
type ChosenMode = { name: "preview" | "source"; selectSource: boolean }
const chosenModes: ChosenMode[] = [
  { name: "preview", selectSource: false },
  { name: "source", selectSource: true },
]

// Relative-resource markers that must never appear in browser requests: the preview
// resolves them to data URLs through the SDK, so any hit means a raw fetch leaked.
const RAW_RESOURCE_MARKERS = [
  "dot.png",
  "photo.jpg",
  "picture.webp",
  "diagram.svg",
  "nested.png",
  "pic.png",
  "a%20b/",
  "a b/",
  "%C3%BCber",
]

type CapturedRequests = { urls: string[]; contentPaths: string[] }

async function captureRequests(page: Page): Promise<CapturedRequests> {
  const captured: CapturedRequests = { urls: [], contentPaths: [] }
  page.on("request", (request) => {
    const url = request.url()
    captured.urls.push(url)
    try {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith("/file/content")) {
        captured.contentPaths.push(parsed.searchParams.get("path") ?? "")
      }
    } catch {
      // Non-URL request target; recorded in urls only.
    }
  })
  return captured
}

function assertSameOriginOnly(captured: CapturedRequests): void {
  const foreign = captured.urls.filter((url) => !url.startsWith(server + "/"))
  expect(foreign, `requests left the packaged origin: ${foreign.join(", ")}`).toEqual([])
}

function assertNoRawResourceRequests(captured: CapturedRequests): void {
  // Pathname-only: the SDK's own /file/content?path=... reads legitimately contain these names.
  const leaked = captured.urls.filter((url) => {
    try {
      return RAW_RESOURCE_MARKERS.some((marker) => new URL(url).pathname.includes(marker))
    } catch {
      return RAW_RESOURCE_MARKERS.some((marker) => url.includes(marker))
    }
  })
  expect(leaked, `raw relative resource requests leaked: ${leaked.join(", ")}`).toEqual([])
}

function assertContentPathsInWorkspace(captured: CapturedRequests): void {
  const allowed = new Set(fixtureEntries().map((entry) => entry.path))
  const outside = captured.contentPaths.filter((entry) => entry !== "" && !allowed.has(entry))
  expect(outside, `file reads outside the fixture corpus: ${outside.join(", ")}`).toEqual([])
}

async function createFixtureSession(request: APIRequestContext): Promise<string> {
  const response = await request.post("/session", { params: { directory: workspace }, data: {} })
  expect(response.ok(), await response.text()).toBe(true)
  const body = (await response.json()) as { id: string }
  return body.id
}

// Upstream retires the legacy interface at local midnight 2026-09-14
// (settings.tsx oldInterfaceSunset). The matrix must still exercise the V1
// layout, so only the Date constructor is normalized to a fixed pre-sunset
// fixture instant. Performance, timers and the native
// PerformanceNavigationTiming the reload handoff reads stay untouched.
const FIXTURE_NOW = Date.parse("2026-09-01T12:00:00Z")

function fixtureDate(now: number) {
  const NativeDate = Date
  const FixedDate = new Proxy(NativeDate, {
    construct(target, args) {
      return args.length === 0 ? new target(now) : Reflect.construct(target, args)
    },
    apply() {
      return new NativeDate(now).toString()
    },
    get(target, property, receiver) {
      if (property === "now") return () => now
      return Reflect.get(target, property, receiver)
    },
  })
  globalThis.Date = FixedDate
}

async function seedLayout(page: Page, newLayoutDesigns: boolean, version: string): Promise<void> {
  // No page.clock here: it also replaces the performance/navigation surfaces,
  // and the product's reload handoff reads the native
  // PerformanceNavigationTiming type. Date is the only normalized surface.
  await page.addInitScript(fixtureDate, FIXTURE_NOW)
  await page.addInitScript(
    ({ appVersion, directory, newLayoutDesigns }) => {
      // Init scripts re-run on every document. The layout flip reloads the page
      // (settings.tsx setNewLayoutDesigns -> window.location.reload), so an
      // unconditional re-seed would erase the app's own writes - the open file
      // tab (sessionTabs) and the flipped preference - on the reload document.
      // Seed only keys that are not present yet: first navigation of a fresh
      // browser context seeds fully; later same-origin reloads keep app state.
      if (localStorage.getItem("settings.v3") === null)
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ general: { newLayoutDesigns, shouldDisplayTabsToast: false } }),
        )
      if (localStorage.getItem("app-version.v1") === null)
        localStorage.setItem("app-version.v1", JSON.stringify({ version: appVersion }))
      if (localStorage.getItem("opencode.global.dat:server") === null)
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
      if (localStorage.getItem("opencode.global.dat:layout") === null)
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({ review: { diffStyle: "split", panelOpened: true }, fileTree: { opened: true, tab: "all" } }),
        )
      if (localStorage.getItem("opencode.global.dat:review-panel-v2") === null)
        localStorage.setItem(
          "opencode.global.dat:review-panel-v2",
          JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }),
        )
    },
    { appVersion: version, directory: workspace, newLayoutDesigns },
  )
}

async function openFixtureSession(page: Page, sessionID: string): Promise<void> {
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
}

const panel = (page: Page) => page.locator("#review-panel")
const controls = (page: Page) => page.getByRole("group", { name: "File view" })
const previewButton = (page: Page) => page.getByRole("button", { name: "Preview", exact: true })
const sourceButton = (page: Page) => page.getByRole("button", { name: "Source", exact: true })
const previewRoot = (page: Page) => page.locator('[data-component="file-preview"][data-file-preview-build]')
const sourcePane = (page: Page) => page.locator('[data-slot="file-source-pane"]')
const findInput = (page: Page) => page.locator('input[placeholder="Find"]')
const sourceViewport = (page: Page) => sourcePane(page).locator(".scroll-view__viewport")

async function openFile(page: Page, layout: Layout, relPath: string): Promise<void> {
  const segments = relPath.split("/")
  const name = segments[segments.length - 1]!
  if (layout.newLayoutDesigns) {
    await panel(page).getByRole("button", { name: "Open file" }).click()
    let prefix = ""
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]
      const row = panel(page).locator(`[data-slot="file-tree-v2-row"][data-path="${prefix}"]`)
      // Expand-only walk: rows expose aria-expanded; re-clicking an expanded row collapses it.
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
      const childPath = `${prefix}/${segments[index + 1]}`
      await expect(panel(page).locator(`[data-slot="file-tree-v2-row"][data-path="${childPath}"]`)).toBeVisible()
    }
    await panel(page).locator(`[data-slot="file-tree-v2-row"][data-path="${relPath}"]`).click()
  } else {
    const tree = page.locator("#file-tree-panel")
    await tree.getByRole("tab", { name: "All files" }).click()
    // Each directory is a Collapsible root whose Content holds only that
    // directory's rows. Descending one Content at a time keeps the leaf locator
    // inside the logical parent, so an identical basename in a sibling branch
    // (iso/one/doc.md vs iso/two/doc.md) is never part of the target locator,
    // even when the sibling rows render later.
    let scope = tree.locator('[data-component="filetree"]')
    for (const directory of segments.slice(0, -1)) {
      const trigger = scope
        .locator('xpath=./div[@data-scope="filetree"]/button[@data-slot="collapsible-trigger"]')
        .and(scope.getByRole("button", { name: directory, exact: true }))
      await expect(trigger).toHaveCount(1)
      // Expand-only walk: legacy triggers expose aria-expanded; re-clicking an expanded row collapses it.
      if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      scope = trigger.locator(
        'xpath=following-sibling::*[@data-slot="collapsible-content"]/div[@data-component="filetree"]',
      )
      await expect(scope).toHaveCount(1)
    }
    const row = scope.locator("xpath=./button").and(scope.getByRole("button", { name }))
    await expect(row).toHaveCount(1)
    await row.click()
  }
  // Same-basename files open two same-named tabs; state-scope to the selected one
  // instead of resolving ambiguously (strict mode) or picking positionally.
  await expect(panel(page).getByRole("tab", { name: path.basename(relPath), selected: true })).toHaveAttribute(
    "data-selected",
    "",
  )
}

async function expectLayoutApplied(page: Page, layout: Layout): Promise<void> {
  if (layout.newLayoutDesigns) {
    await expect(panel(page).getByRole("button", { name: "Open file" })).toBeVisible()
  } else {
    await expect(page.locator("#file-tree-panel")).toBeVisible()
  }
}

function decodedDataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",")
  if (!dataUrl.startsWith("data:") || comma === -1) throw new Error(`not a data URL: ${dataUrl.slice(0, 60)}`)
  return Uint8Array.from(Buffer.from(dataUrl.slice(comma + 1), "base64"))
}

async function expectFixtureImage(preview: Locator, name: string, relPath: string): Promise<void> {
  const image = preview.getByRole("img", { name })
  await expect(image).toBeVisible()
  const info = await image.evaluate((element) => {
    const el = element as HTMLImageElement
    return { naturalWidth: el.naturalWidth, src: el.src }
  })
  expect(info.naturalWidth, `${relPath} must decode with the fixture's 1px width`).toBe(1)
  expect(info.src.startsWith("data:image/"), `${relPath} must render as an app-generated data URL`).toBe(true)
  const onDisk = await readFile(path.join(workspace, relPath))
  expect(
    Buffer.from(decodedDataUrlBytes(info.src)).equals(onDisk),
    `${relPath} data URL bytes must equal the fixture bytes`,
  ).toBe(true)
}

async function expectNoRelativeImageSrc(preview: Locator): Promise<void> {
  const relative = await preview
    .locator("img[src]")
    .evaluateAll((images) =>
      images.map((image) => image.getAttribute("src") ?? "").filter((src) => !src.startsWith("data:")),
    )
  expect(relative, `non-data image srcs reached the DOM: ${relative.join(", ")}`).toEqual([])
}

// The comment card's "More options" menu renders in a body-level portal (V1
// DropdownMenu.Portal, V2 MenuV2.Portal), outside #review-panel. While a modal menu is
// open the trigger is aria-hidden, so the open menu is resolved page-wide by its role.
async function openCommentMenu(page: Page, trigger: Locator, item: "Edit" | "Delete"): Promise<void> {
  await expect(trigger).toHaveCount(1)
  await trigger.click()
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await menu.getByRole("menuitem", { name: item, exact: true }).click()
}

async function dragLineSelection(page: Page, fromLine: number, toLine: number): Promise<void> {
  // The code editor mounts its virtualized rows asynchronously (a freshly opened row can
  // report a 0x0 rect for a few ms), so visibility alone does not imply a geometry box.
  // Scope to the active source pane and wait for each row's real box before dragging.
  const from = sourcePane(page).locator(`diffs-container [data-line="${fromLine}"]`)
  const to = sourcePane(page).locator(`diffs-container [data-line="${toLine}"]`)
  for (const row of [from, to]) {
    await expect(row).toBeVisible()
    await expect
      .poll(() => row.boundingBox().then((box) => box !== null && box.height > 0 && box.width > 0), { timeout: 5000 })
      .toBe(true)
  }
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  if (!fromBox || !toBox) throw new Error("source line rows had no layout boxes")
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 4 })
  await page.mouse.up()
}

async function saveEvidenceScreenshot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  if (!evidenceDir) return
  const target = path.join(evidenceDir, name)
  await page.screenshot({ path: target, fullPage: false })
  testInfo.attach(name, { path: target, contentType: "image/png" })
}

for (const layout of layouts) {
  test.describe(layout.name, () => {
    test.beforeEach(async ({ page, request }) => {
      await seedLayout(page, layout.newLayoutDesigns, await appVersion(request))
    })

    // Unmarked: a failure here is a real fixture/navigation/setup failure.
    test("opens the fixture workspace through app navigation", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await expectLayoutApplied(page, layout)
      await openFile(page, layout, readme)
      await expect(panel(page).getByRole("tab", { name: readme })).toHaveAttribute("data-selected", "")
    })

    // Identity preflight: bypassed only in baseline comparison mode so the run
    // reaches the behavioral Preview assertions instead of stopping on identity.
    test("packaged build identity matches the served UI and manifest", async ({ page, request }) => {
      test.skip(baseline, "baseline comparison bypasses the identity preflight to reach feature assertions")
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, readme)
      await expect(previewRoot(page)).toHaveAttribute("data-file-preview-build", buildId)

      const identity = await request.get("/file-preview-build.json")
      expect(identity.ok(), await identity.text()).toBe(true)
      expect(((await identity.json()) as { buildId: string }).buildId).toBe(buildId)
    })

    test("Markdown defaults to Preview and round-trips to Source", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, readme)
      await expect(controls(page)).toBeVisible()

      await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")
      await expect(sourceButton(page)).toHaveAttribute("aria-pressed", "false")
      await expect(previewRoot(page)).toBeVisible()
      await expect(previewRoot(page).getByRole("heading", { name: "File preview fixture" })).toBeVisible()

      await sourceButton(page).click()
      await expect(sourceButton(page)).toHaveAttribute("aria-pressed", "true")
      await expect(sourcePane(page)).toBeVisible()
      await expect(previewRoot(page)).toHaveCount(0)
      await expect(sourcePane(page).getByText("A local image and a nested link.")).toBeVisible()

      await previewButton(page).click()
      await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")
      await expect(previewRoot(page)).toBeVisible()
    })

    test("frontmatter renders as escaped YAML with the body intact", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "frontmatter/bom.md")
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      await expect(preview.getByRole("code")).toContainText("title: BOM doc")
      await expect(preview.getByRole("heading", { name: "Body" })).toBeVisible()

      await openFile(page, layout, "frontmatter/crlf.md")
      await expect(preview.getByRole("code")).toContainText("title: CRLF doc")
      await expect(preview.getByRole("heading", { name: "Body" })).toBeVisible()
    })

    test("table list and fenced code render and code copy works", async ({ page, browserName, context, request }) => {
      test.skip(browserName !== "chromium", "clipboard permission grant is chromium-specific")
      await context.grantPermissions(["clipboard-read", "clipboard-write"])
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "content/blocks.md")
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      const table = preview.getByRole("table")
      await expect(table).toBeVisible()
      await expect(table.getByRole("cell", { name: "1", exact: true })).toBeVisible()
      await expect(table.getByRole("cell", { name: "2", exact: true })).toBeVisible()
      await expect(preview.getByRole("code")).toContainText("const answer = 42")
      await expect(preview.getByText("todo")).toBeVisible()
      await expect(preview.getByText("done")).toBeVisible()

      await preview.locator('[data-slot="markdown-copy-button"] button').first().click()
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
        .toBe("const answer = 42")
    })

    test("nested reference raw spaces and unicode images resolve with fixture identity", async ({ page, request }) => {
      const captured = await captureRequests(page)
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)

      await openFile(page, layout, readme)
      await expectFixtureImage(previewRoot(page), "dot", "images/dot.png")

      await openFile(page, layout, "guide/nested/deep.md")
      await expectFixtureImage(previewRoot(page), "nested", "images/nested.png")

      await openFile(page, layout, "render/reference.md")
      await expectFixtureImage(previewRoot(page), "ref image", "images/nested.png")

      await openFile(page, layout, "render/raw-html.md")
      await expectFixtureImage(previewRoot(page), "raw image", "images/nested.png")
      await expectNoRelativeImageSrc(previewRoot(page))

      await openFile(page, layout, "render/unicode.md")
      await expectFixtureImage(previewRoot(page), "über bild", "a b/über.png")
      await expectNoRelativeImageSrc(previewRoot(page))

      assertNoRawResourceRequests(captured)
      assertSameOriginOnly(captured)
      assertContentPathsInWorkspace(captured)
    })

    test("plain text keeps source-only behavior without preview controls", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "plain.txt")

      await expect(controls(page)).toHaveCount(0)
      await expect(previewRoot(page)).toHaveCount(0)
      await expect(sourcePane(page)).toBeVisible()
      await expect(sourcePane(page).getByText("plain text, not markdown")).toBeVisible()
    })

    test("direct image files keep the media viewer without markdown controls", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "images/photo.jpg")

      await expect(controls(page)).toHaveCount(0)
      await expect(previewRoot(page)).toHaveCount(0)
      const image = panel(page).locator("img").first()
      await expect(image).toBeVisible()
      const naturalWidth = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
      expect(naturalWidth).toBeGreaterThan(0)
      expect(await image.evaluate((element) => (element as HTMLImageElement).src.startsWith("data:"))).toBe(true)
    })

    test("same bytes in two directories resolve against their own base", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)

      await openFile(page, layout, "iso/one/doc.md")
      const onePreview = previewRoot(page)
      await expect(onePreview.getByRole("heading", { name: "Shared document" })).toBeVisible()
      await expectFixtureImage(onePreview, "pic", "iso/one/pic.png")
      const oneSrc = await onePreview.getByRole("img", { name: "pic" }).getAttribute("src")

      await openFile(page, layout, "iso/two/doc.md")
      const twoPreview = previewRoot(page)
      await expect(twoPreview.getByRole("heading", { name: "Shared document" })).toBeVisible()
      // The provider serves SVG bytes under a .png name as text without an image
      // mime, so the feature renders the designed unavailable placeholder (same
      // contract as the missing-image case); it must never reuse iso/one's image.
      const twoImage = twoPreview.getByRole("img", { name: "pic" })
      await expect(twoImage).toBeVisible()
      await expect(twoImage).toHaveAttribute("data-file-preview-resource", "unavailable")
      await expect(twoImage).toHaveAttribute("aria-label", "pic")
      expect(await twoImage.getAttribute("src")).not.toBe(oneSrc)
      await expectNoRelativeImageSrc(twoPreview)
    })

    test("same-document anchor scrolls the preview without reload", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "render/anchors.md")
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      await expect(preview.getByRole("link", { name: "jump to sections" })).toBeVisible()
      const before = await preview.evaluate((element) => (element as HTMLDivElement).scrollTop)
      await preview.getByRole("link", { name: "jump to sections" }).click()
      await expect
        .poll(() => preview.evaluate((element) => (element as HTMLDivElement).scrollTop), { timeout: 5000 })
        .toBeGreaterThan(before)
      expect(page.url()).toContain(`/session/${sessionID}`)
    })

    test("cross-file navigation reuses the file tab both ways", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, readme)

      const preview = previewRoot(page)
      await preview.getByRole("link", { name: "nested guide" }).click()
      await expect(panel(page).getByRole("tab", { name: "intro.md" })).toHaveAttribute("data-selected", "")
      if (layout.newLayoutDesigns) {
        // V2 opened readme as the session preview slot, so the cross-file open replaces
        // it in place: only intro remains.
        await expect(panel(page).getByRole("tab", { name: readme })).toHaveCount(0)
      } else {
        // V1 opened readme permanently through the file tree (no preview slot), so the
        // cross-file open appends intro and readme stays open, deselected.
        await expect(panel(page).getByRole("tab", { name: readme })).toHaveCount(1)
        await expect(panel(page).getByRole("tab", { name: readme })).not.toHaveAttribute("data-selected", "")
      }
      const intro = previewRoot(page)
      await expect(intro.getByRole("heading", { name: "Intro" })).toBeVisible()

      await intro.getByRole("link", { name: "readme" }).click()
      await expect(panel(page).getByRole("tab", { name: readme })).toHaveAttribute("data-selected", "")
      await expect(previewRoot(page).getByRole("heading", { name: "File preview fixture" })).toBeVisible()
    })

    test("cross-file link into nested directories resolves the target image", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "render/anchors.md")

      await previewRoot(page).getByRole("link", { name: "deep guide" }).click()
      await expect(panel(page).getByRole("tab", { name: "deep.md" })).toHaveAttribute("data-selected", "")
      await expectFixtureImage(previewRoot(page), "nested", "images/nested.png")
    })

    test("external links keep target and rel protections and never fetch off-origin", async ({ page, request }) => {
      const captured = await captureRequests(page)
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "unsafe/urls.md")
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      const external = preview.getByRole("link", { name: "external" })
      await expect(external).toHaveAttribute("target", "_blank")
      await expect(external).toHaveAttribute("rel", /noopener/)
      await expect(external).toHaveAttribute("rel", /noreferrer/)

      // The shared sanitizer drops anchors with a blocked scheme entirely, so the
      // security contract is navigation impossibility, not scheme-stripped hrefs.
      for (const name of ["js", "data", "file"]) {
        await expect(
          preview.getByRole("link", { name }),
          `${name} scheme anchor must not render as a navigable link`,
        ).toHaveCount(0)
      }
      await expect(
        preview.locator("[onclick], [onerror], [onload], [onmouseover]"),
        "inline event handlers must not survive sanitization",
      ).toHaveCount(0)

      // Every href that does render must resolve to an allowed protocol; blocked
      // schemes must never survive in any rendered anchor.
      const hrefs = await preview
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""))
      const blocked = hrefs.filter((href) => {
        try {
          const protocol = new URL(href, "https://opencode.invalid").protocol
          return protocol !== "https:" && protocol !== "http:" && protocol !== "mailto:"
        } catch {
          return true
        }
      })
      expect(blocked, `blocked protocols survived in rendered hrefs: ${blocked.join(", ")}`).toEqual([])
      expect(hrefs, "the external https link must keep its target").toContain("https://example.com/")

      assertSameOriginOnly(captured)
      expect(
        captured.urls.filter((url) => url.includes("example.com")),
        "off-origin request leaked",
      ).toEqual([])
    })

    test("image watcher refreshes the preview while markdown stays constant", async ({ page, request }) => {
      const imagePath = path.join(workspace, "images", "nested.png")
      const original = await readFile(imagePath)
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "guide/nested/deep.md")

      const image = previewRoot(page).getByRole("img", { name: "nested" })
      await expect(image).toBeVisible()
      const before = await image.evaluate((element) => (element as HTMLImageElement).src)
      expect(before.startsWith("data:image/")).toBe(true)

      try {
        const { writeFile: rewrite } = await import("node:fs/promises")
        await rewrite(imagePath, PNG_1PX_ALT)
        await expect
          .poll(() => image.evaluate((element) => (element as HTMLImageElement).src), { timeout: 15000 })
          .not.toBe(before)
        const after = await image.evaluate((element) => (element as HTMLImageElement).src)
        expect(Buffer.from(decodedDataUrlBytes(after)).equals(PNG_1PX_ALT)).toBe(true)
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1)
        await expect(previewRoot(page).getByRole("heading", { name: "Deep" })).toBeVisible()
      } finally {
        const { writeFile: restore } = await import("node:fs/promises")
        await restore(imagePath, original)
      }
    })

    test("source search highlights matches and preview find stays native", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "content/blocks.md")
      await expect(controls(page)).toBeVisible()

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await page.keyboard.press("Control+f")
      await expect(findInput(page)).toBeVisible()
      await findInput(page).fill("answer")
      await expect(page.getByText("1/1", { exact: true })).toBeVisible()

      // file-find.ts sets the ACTIVE match into "opencode-find-current" and only fills
      // "opencode-find" with the non-active rest, so a 1/1 query must expose exactly the
      // current Range and its text must equal the query.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const highlights = (globalThis as unknown as { CSS?: { highlights?: Map<string, Iterable<Range>> } }).CSS
              ?.highlights
            const current = highlights?.get("opencode-find-current")
            return current
              ? Array.from(current)
                  .map((range) => range.toString())
                  .join("|")
              : ""
          }),
        )
        .toBe("answer")

      // Retention contract: the source find overlay is retained once visited, including
      // across a Preview switch - it must not be destroyed, must keep its query, and must
      // leave Control+f native while Preview is active.
      await page.evaluate(() => {
        ;(globalThis as unknown as { __filePreviewFindKeydown?: boolean }).__filePreviewFindKeydown = undefined
        document.addEventListener("keydown", (event) => {
          if (event.ctrlKey && event.key === "f") {
            ;(globalThis as unknown as { __filePreviewFindKeydown?: boolean }).__filePreviewFindKeydown =
              event.defaultPrevented
          }
        })
      })
      await previewButton(page).click()
      await expect(previewRoot(page)).toBeVisible()
      await expect(findInput(page)).toHaveCount(1)
      // Presentation gate (file-tabs find bar visibility): the retained input is hidden
      // in Preview; count-1 retention must not be satisfied by a visible bar.
      await expect(findInput(page)).not.toBeVisible()
      await expect(findInput(page)).toHaveValue("answer")
      await page.keyboard.press("Control+f")
      const prevented = await page.evaluate(
        () => (globalThis as unknown as { __filePreviewFindKeydown?: boolean }).__filePreviewFindKeydown,
      )
      expect(prevented, "source find must not intercept Control+f while Preview is active").toBe(false)
      await expect(findInput(page)).not.toBeFocused()

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await expect(findInput(page)).toBeVisible()
      await expect(findInput(page)).toHaveValue("answer")
    })

    test("line selection opens a comment that edits and deletes without loss", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "content/blocks.md")
      await expect(controls(page)).toBeVisible()

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await dragLineSelection(page, 3, 4)

      const draft = panel(page).getByRole("textbox")
      await expect(draft).toBeVisible()
      await draft.fill("line comment")
      await panel(page).getByRole("button", { name: "Comment", exact: true }).filter({ hasText: "Comment" }).click()
      await expect(panel(page).getByText("line comment")).toBeVisible()

      // Exactly one comment exists in this workflow, so the panel-scoped trigger is the
      // active card's trigger; strict uniqueness fails loudly if that ever changes.
      const moreOptions = panel(page).getByRole("button", { name: "More options" })
      await openCommentMenu(page, moreOptions, "Edit")
      const editor = panel(page).getByRole("textbox")
      await expect(editor).toBeVisible()
      await editor.fill("edited comment")
      await panel(page).getByRole("button", { name: "Save", exact: true }).click()
      await expect(panel(page).getByText("edited comment")).toBeVisible()
      await expect(panel(page).getByText("line comment", { exact: true })).toHaveCount(0)

      await openCommentMenu(page, moreOptions, "Delete")
      await expect(panel(page).getByText("edited comment")).toHaveCount(0)

      await previewButton(page).click()
      await expect(previewRoot(page)).toBeVisible()
    })

    test("unsent comment draft survives a Preview round trip", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "content/blocks.md")
      await expect(controls(page)).toBeVisible()

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await dragLineSelection(page, 3, 3)
      const draft = panel(page).getByRole("textbox")
      await expect(draft).toBeVisible()
      await draft.fill("keep this draft")

      await previewButton(page).click()
      await expect(previewRoot(page)).toBeVisible()
      await sourceButton(page).click()
      await expect(panel(page).getByRole("textbox")).toHaveValue("keep this draft")
    })

    test("preview and source scroll positions stay separate", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, "content/scroll.md")
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      // Overflow gate: the fixture must actually overflow each surface before any
      // scroll is attempted - assigning scrollTop to a non-overflowing element
      // clamps to 0 and proves nothing (a7 root-cause finding).
      await expect
        .poll(() =>
          preview.evaluate((element) => {
            const el = element as HTMLDivElement
            return el.scrollHeight > el.clientHeight + 200
          }),
        )
        .toBe(true)
      await preview.evaluate((element) => {
        const el = element as HTMLDivElement
        el.scrollTop = 600
        el.dispatchEvent(new Event("scroll"))
      })
      await expect.poll(() => preview.evaluate((element) => (element as HTMLDivElement).scrollTop)).toBeGreaterThan(0)
      const previewScroll = await preview.evaluate((element) => (element as HTMLDivElement).scrollTop)

      await sourceButton(page).click()
      const viewport = sourceViewport(page)
      await expect(viewport).toBeVisible()
      await expect
        .poll(() =>
          viewport.evaluate((element) => {
            const el = element as HTMLElement
            return el.scrollHeight > el.clientHeight + 200
          }),
        )
        .toBe(true)
      await viewport.evaluate((element) => {
        const el = element as HTMLElement
        el.scrollTop = 400
        el.dispatchEvent(new Event("scroll"))
      })
      await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).scrollTop)).toBeGreaterThan(0)
      const sourceScroll = await viewport.evaluate((element) => (element as HTMLElement).scrollTop)
      expect(sourceScroll, "the two surfaces must end at distinct offsets").not.toBe(previewScroll)

      // Exact restoration, not merely nonzero: each surface must return to its
      // own recorded offset after the round trip.
      await previewButton(page).click()
      await expect(preview).toBeVisible()
      await expect.poll(() => preview.evaluate((element) => (element as HTMLDivElement).scrollTop)).toBe(previewScroll)

      await sourceButton(page).click()
      await expect(viewport).toBeVisible()
      await expect.poll(() => viewport.evaluate((element) => (element as HTMLElement).scrollTop)).toBe(sourceScroll)
    })

    // The settings flip is a FULL document reload; the chosen Preview/Source mode must
    // cross it exactly once (file-tab-reload-handoff.v1) while the tab and the applied
    // layout stay intact. Both directions run per layout, and the Source variant selects
    // Source BEFORE the flip so the handoff is actually armed.
    for (const mode of chosenModes) {
      test(`layout toggling through the real settings UI keeps the chosen ${mode.name} mode`, async ({
        page,
        request,
      }) => {
        const sessionID = await createFixtureSession(request)
        await openFixtureSession(page, sessionID)
        await openFile(page, layout, readme)
        await expect(controls(page)).toBeVisible()
        await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")

        if (mode.selectSource) {
          await sourceButton(page).click()
          await expect(sourceButton(page)).toHaveAttribute("aria-pressed", "true")
          await expect(sourcePane(page)).toBeVisible()
        }

        const chosen = mode.selectSource ? sourceButton : previewButton
        const other = mode.selectSource ? previewButton : sourceButton

        // Runs only on a reloaded document, after the tab store has hydrated and the
        // provider has consumed the carrier: exact restored mode, preserved tab, applied
        // layout, and no re-armed carrier.
        const assertReloaded = async (flipped: Layout) => {
          await expect(panel(page).getByRole("tab", { name: readme })).toHaveAttribute("data-selected", "")
          await expect(controls(page)).toBeVisible()
          await expect(chosen(page)).toHaveAttribute("aria-pressed", "true")
          await expect(other(page)).toHaveAttribute("aria-pressed", "false")
          if (mode.selectSource) await expect(sourcePane(page)).toBeVisible()
          else await expect(previewRoot(page)).toBeVisible()
          await expectLayoutApplied(page, flipped)
          expect(
            await page.evaluate((key) => sessionStorage.getItem(key), RELOAD_HANDOFF_STORAGE_KEY),
            "the reload handoff carrier must be consumed exactly once and not re-armed",
          ).toBeNull()
        }

        await page.keyboard.press("Control+,")
        const toggle = page.locator('[data-action="settings-new-layout-designs"]').getByRole("switch")
        await expect(toggle).toBeVisible()
        // The switch input is the focusable native checkbox; the control/thumb cover
        // it for the pointer (hit-target interception), but it is the real keyboard
        // target (switch-v2.css focus-visible styles), so Space is the actual toggle.
        // Flipping reloads the page (setNewLayoutDesigns -> window.location.reload) and
        // unmounts the settings surface in BOTH directions, so the reload wait is
        // registered before the press and every post-flip assertion runs on the
        // reloaded document, never on the destroyed surface.
        const firstReload = page.waitForEvent("load")
        await toggle.press("Space")
        await firstReload
        await expect(page.locator('[data-action="settings-new-layout-designs"]')).toHaveCount(0)

        await assertReloaded({ ...layout, newLayoutDesigns: !layout.newLayoutDesigns })

        await page.keyboard.press("Control+,")
        await expect(toggle).toBeVisible()
        // The reload destroyed the original surface; the persisted flip is
        // observable only on this reopened one, so it is asserted here before
        // flipping back.
        await expect(toggle).toHaveAttribute("aria-checked", String(!layout.newLayoutDesigns))
        const secondReload = page.waitForEvent("load")
        await toggle.press("Space")
        await secondReload
        await expect(page.locator('[data-action="settings-new-layout-designs"]')).toHaveCount(0)

        await assertReloaded(layout)
      })
    }

    test("exactly 5 MiB stays eligible while one byte over falls back to source", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)

      await openFile(page, layout, "limits/exact-5mib.md")
      await expect(controls(page)).toBeVisible()
      await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator("[data-file-preview-too-large]")).toHaveCount(0)

      await openFile(page, layout, "limits/over-5mib.md")
      await expect(page.locator("[data-file-preview-too-large]")).toBeVisible()
      await expect(page.locator("[data-file-preview-too-large]")).toContainText("5 MiB")
      await expect(controls(page)).toHaveCount(0)
      await expect(previewRoot(page)).toHaveCount(0)
      await expect(sourcePane(page)).toBeVisible()
    })

    test("missing image shows a placeholder while oversized data stays inert", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)

      await openFile(page, layout, "broken/missing-image.md")
      const preview = previewRoot(page)
      const placeholder = preview.locator('[data-file-preview-resource="unavailable"]')
      await expect(placeholder).toHaveCount(1)
      await expect(placeholder).toHaveAttribute("aria-label", "missing")
      await expect(preview.getByRole("heading", { name: "Missing" })).toBeVisible()
      await expectNoRelativeImageSrc(preview)

      // broken/oversized-base64.md is itself over the 5 MiB file cap (8 MiB of
      // base64 payload inside the markdown), so the file-level limit wins before
      // any data-URL handling: the document falls back to source with the size
      // explanation, exactly like the over-limit case above.
      await openFile(page, layout, "broken/oversized-base64.md")
      await expect(page.locator("[data-file-preview-too-large]")).toBeVisible()
      await expect(page.locator("[data-file-preview-too-large]")).toContainText("5 MiB")
      await expect(controls(page)).toHaveCount(0)
      await expect(previewRoot(page)).toHaveCount(0)
      await expect(sourcePane(page)).toBeVisible()
    })

    test("network and DOM contract holds cold and warm", async ({ page, request }) => {
      const captured = await captureRequests(page)
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)

      await openFile(page, layout, readme)
      const preview = previewRoot(page)
      await expectFixtureImage(preview, "dot", "images/dot.png")
      await expectNoRelativeImageSrc(preview)
      expect(
        await page.evaluate(() => (window as { __filePreviewScriptRan?: boolean }).__filePreviewScriptRan),
      ).toBeUndefined()
      assertNoRawResourceRequests(captured)
      assertSameOriginOnly(captured)
      assertContentPathsInWorkspace(captured)

      // Exact path ownership, not a global image tally: this document references
      // exactly images/dot.png; review-panel changed-file prefetch is a different
      // surface with its own reads and must not fail this contract.
      const dotReadsCold = captured.contentPaths.filter((entry) => entry === "images/dot.png").length
      expect(dotReadsCold, "cold preview reads the referenced image exactly once").toBe(1)

      await preview.getByRole("link", { name: "nested guide" }).click()
      await expect(panel(page).getByRole("tab", { name: "intro.md" })).toHaveAttribute("data-selected", "")
      await previewRoot(page).getByRole("link", { name: "readme" }).click()
      await expect(panel(page).getByRole("tab", { name: readme })).toHaveAttribute("data-selected", "")
      await expectFixtureImage(previewRoot(page), "dot", "images/dot.png")

      const dotReadsTotal = captured.contentPaths.filter((entry) => entry === "images/dot.png").length
      expect(dotReadsTotal, "warm revisit must not re-read the referenced image").toBe(dotReadsCold)
      assertNoRawResourceRequests(captured)
    })

    // Resource budget: the document is small (no source-cap fallback); only the
    // referenced image's real SDK response is replaced with a 16 MiB well-formed
    // base64 payload, so rejection can only come from resource admission. The
    // response really carries the allocation - this is not a transport cap.
    test("oversized image payload is rejected at resource admission without an inline URL", async ({
      page,
      request,
    }) => {
      const captured = await captureRequests(page)
      const oversized = oversizedImageBase64()
      await page.route(
        (url) => url.pathname.endsWith("/file/content"),
        async (route) => {
          const target = new URL(route.request().url())
          if (target.searchParams.get("path") !== BUDGET_IMAGE_PATH) {
            await route.continue()
            return
          }
          const response = await route.fetch()
          const body = (await response.json()) as Record<string, unknown>
          if (typeof body.content !== "string") throw new Error("fixture route: unexpected FileContent shape")
          await route.fulfill({ response, json: { ...body, content: oversized } })
        },
      )

      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, BUDGET_DOC_PATH)
      await expect(controls(page)).toBeVisible()
      await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")

      const preview = previewRoot(page)
      await expect(preview.getByRole("heading", { name: "Image budget" })).toBeVisible()
      await expect(preview.getByText("Rest of the document stays visible.")).toBeVisible()
      // The source-file cap is a different mechanism; this small document must not hit it.
      await expect(page.locator("[data-file-preview-too-large]")).toHaveCount(0)
      const placeholder = preview.locator('[data-file-preview-resource="unavailable"]')
      await expect(placeholder).toHaveCount(1)
      await expect(placeholder).toHaveAttribute("aria-label", "budget image")

      // The rejected payload must never become a rendered image or any oversized attribute.
      await expect(preview.locator("img")).toHaveCount(0)
      const oversizedAttributes = await preview.evaluate((element) =>
        Array.from(element.querySelectorAll("*")).flatMap((node) =>
          Array.from(node.attributes)
            .filter((attribute) => attribute.value.length > 1024 * 1024)
            .map((attribute) => attribute.name),
        ),
      )
      expect(oversizedAttributes, "no oversized URL may be inserted into the preview").toEqual([])

      const reads = () => ({
        doc: captured.contentPaths.filter((entry) => entry === BUDGET_DOC_PATH).length,
        image: captured.contentPaths.filter((entry) => entry === BUDGET_IMAGE_PATH).length,
      })
      await expect.poll(() => reads().image, { timeout: 15000 }).toBe(1)
      expect(reads().doc, "the small document is read once").toBe(1)

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await previewButton(page).click()
      await expect(previewRoot(page).locator('[data-file-preview-resource="unavailable"]')).toHaveCount(1)

      // Warm revisit through another file and back: the bounded rejection is retained
      // and neither the document nor the image is read again.
      await openFile(page, layout, readme)
      await openFile(page, layout, BUDGET_DOC_PATH)
      await expect(previewRoot(page).getByRole("heading", { name: "Image budget" })).toBeVisible()
      await expect(previewRoot(page).locator('[data-file-preview-resource="unavailable"]')).toHaveCount(1)
      expect(reads()).toEqual({ doc: 1, image: 1 })
    })

    // Entry cap: the document plus forty distinct referenced images exceed the global
    // 40-entry content cache. The document keeps its slot, so thirty-nine images decode
    // and the last becomes the explicit placeholder with no document reload or
    // alternating image reads on a repeat view.
    test("40-image gallery holds 39 decoded images plus the last placeholder at the entry cap", async ({
      page,
      request,
    }) => {
      const captured = await captureRequests(page)
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, GALLERY_DOC_PATH)
      await expect(controls(page)).toBeVisible()

      const preview = previewRoot(page)
      await expect(preview.getByRole("heading", { name: "Gallery" })).toBeVisible()
      await expect(preview.locator("img")).toHaveCount(39)
      await expect
        .poll(
          () =>
            preview
              .locator("img")
              .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth === 1)),
          { timeout: 30000 },
        )
        .toBe(true)
      const decoded = await preview.locator("img").evaluateAll((images) =>
        images.map((image) => ({
          alt: image.getAttribute("alt") ?? "",
          src: (image as HTMLImageElement).src,
        })),
      )
      expect(decoded.map((entry) => entry.alt)).toEqual(
        galleryImagePaths()
          .slice(0, 39)
          .map((entry) => path.basename(entry, ".png")),
      )
      expect(
        decoded.every((entry) => entry.src.startsWith("data:image/")),
        "each admitted image is an app-generated data URL",
      ).toBe(true)

      const placeholder = preview.locator('[data-file-preview-resource="unavailable"]')
      await expect(placeholder).toHaveCount(1)
      await expect(placeholder).toHaveAttribute("aria-label", "img-39")
      await expect(preview.getByText("Gallery body stays visible after the last placeholder.")).toBeVisible()

      const expectedImages = galleryImagePaths().map(() => 1)
      const reads = () => ({
        doc: captured.contentPaths.filter((entry) => entry === GALLERY_DOC_PATH).length,
        images: galleryImagePaths().map((entry) => captured.contentPaths.filter((path) => path === entry).length),
      })
      await expect.poll(() => reads().images.reduce((sum, count) => sum + count, 0), { timeout: 30000 }).toBe(40)
      expect(reads().doc, "the gallery document is read once").toBe(1)
      expect(reads().images, "each referenced image is read exactly once").toEqual(expectedImages)

      // Repeat view without another document load: a Source/Preview round trip and a
      // tab close/reopen reuse the cache; the rejected last image stays rejected.
      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await previewButton(page).click()
      await expect(previewRoot(page).locator("img")).toHaveCount(39)
      await expect(previewRoot(page).locator('[data-file-preview-resource="unavailable"]')).toHaveCount(1)

      await panel(page).getByRole("button", { name: "Close tab" }).click()
      await expect(panel(page).getByRole("tab", { name: "gallery.md" })).toHaveCount(0)
      await openFile(page, layout, GALLERY_DOC_PATH)
      await expect(previewRoot(page).locator("img")).toHaveCount(39)
      await expect(previewRoot(page).locator('[data-file-preview-resource="unavailable"]')).toHaveCount(1)
      expect(reads()).toEqual({ doc: 1, images: expectedImages })
    })

    test("evidence screenshot of rendered document and preserved source comment", async ({
      page,
      request,
    }, testInfo) => {
      test.skip(baseline, "baseline evidence is the failure record, not screenshots")
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, readme)
      await expect(controls(page)).toBeVisible()
      await expect(previewRoot(page).getByRole("img", { name: "dot" })).toBeVisible()
      await saveEvidenceScreenshot(page, `task-11-${layout.name}-preview.png`, testInfo)

      await sourceButton(page).click()
      await expect(sourcePane(page)).toBeVisible()
      await dragLineSelection(page, 1, 2)
      const draft = panel(page).getByRole("textbox")
      await expect(draft).toBeVisible()
      await draft.fill("preserved source comment")
      await panel(page).getByRole("button", { name: "Comment", exact: true }).filter({ hasText: "Comment" }).click()
      await expect(panel(page).getByText("preserved source comment")).toBeVisible()
      await saveEvidenceScreenshot(page, `task-11-${layout.name}-source-comment.png`, testInfo)

      await previewButton(page).click()
      await expect(previewRoot(page)).toBeVisible()
      await sourceButton(page).click()
      await expect(panel(page).getByText("preserved source comment")).toBeVisible()
    })

    test("tab close and reopen returns to the default preview mode", async ({ page, request }) => {
      const sessionID = await createFixtureSession(request)
      await openFixtureSession(page, sessionID)
      await openFile(page, layout, readme)
      await expect(controls(page)).toBeVisible()

      await sourceButton(page).click()
      await expect(sourceButton(page)).toHaveAttribute("aria-pressed", "true")
      await panel(page).getByRole("button", { name: "Close tab" }).click()
      await expect(panel(page).getByRole("tab", { name: readme })).toHaveCount(0)

      await openFile(page, layout, readme)
      await expect(previewButton(page)).toHaveAttribute("aria-pressed", "true")
    })
  })
}
