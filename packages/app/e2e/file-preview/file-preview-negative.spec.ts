// Fail-closed negative probes for the packaged file-preview suite (plan task 11
// QA-failure cases). Every test here PASSES when the product refuses the bad
// input, so this file runs against the patched binary and must stay green;
// the wrong-build-identity probe is the main spec's identity preflight failing,
// executed as a separate invocation with a mismatched FILE_PREVIEW_BUILD_ID.
import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type APIRequest, type APIRequestContext, type Page } from "@playwright/test"
import path from "node:path"
import { FIXTURE_WORKSPACE_DIRNAME } from "./fixtures"

const server = `http://127.0.0.1:${process.env.FILE_PREVIEW_TEST_PORT ?? 4196}`
const workspace = path.join(process.env.FILE_PREVIEW_TEST_ROOT ?? "", FIXTURE_WORKSPACE_DIRNAME)

async function seedLayout(page: Page): Promise<void> {
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ review: { diffStyle: "split", panelOpened: true }, fileTree: { opened: true, tab: "all" } }),
      )
      localStorage.setItem(
        "opencode.global.dat:review-panel-v2",
        JSON.stringify({ sidebarOpened: true, sidebarWidth: 240, expandMode: "collapse" }),
      )
    },
    { directory: workspace },
  )
}

async function createFixtureSession(request: APIRequestContext): Promise<string> {
  const response = await request.post("/session", { params: { directory: workspace }, data: {} })
  expect(response.ok(), await response.text()).toBe(true)
  const body = (await response.json()) as { id: string }
  return body.id
}

// The auth layer must be armed before denial assertions mean anything; a fresh
// backend arms within seconds, so poll unauth health until it answers 401.
async function waitForAuthArmed(baseURL: string, request: APIRequest): Promise<void> {
  // Explicit wrong credentials: the request fixture would otherwise inherit the
  // config's httpCredentials and the "unauthenticated" probe would be authenticated.
  const anonymous = await request.newContext({
    baseURL,
    httpCredentials: { username: "anonymous", password: "invalid" },
  })
  try {
    await expect
      .poll(
        () =>
          anonymous.get("/global/health").then(
            (r) => r.status(),
            () => 0,
          ),
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(401)
  } finally {
    await anonymous.dispose()
  }
}

test.describe("fail-closed probes", () => {
  test("unauthenticated file reads are denied by the backend auth contract", async ({ playwright }) => {
    await waitForAuthArmed(server, playwright.request)
    const anonymous = await playwright.request.newContext({
      baseURL: server,
      httpCredentials: { username: "anonymous", password: "invalid" },
    })
    const denied = await anonymous.get("/file/content", {
      params: { directory: workspace, path: "readme.md" },
      maxRedirects: 0,
    })
    expect(denied.status(), "unauthenticated read must not succeed").toBe(401)
    expect(await denied.text()).toBe("")
    await anonymous.dispose()

    const authenticated = await playwright.request.newContext({
      baseURL: server,
      httpCredentials: { username: "fixture", password: "fixture-only" },
    })
    const allowed = await authenticated.get("/file/content", {
      params: { directory: workspace, path: "readme.md" },
    })
    expect(allowed.ok(), "authenticated same-origin read must succeed").toBe(true)
    expect(await allowed.text()).toContain("# File preview fixture")
    await authenticated.dispose()
  })

  test("denied targets and missing files never expose foreign content", async ({ playwright }) => {
    const authenticated = await playwright.request.newContext({
      baseURL: server,
      httpCredentials: { username: "fixture", password: "fixture-only" },
    })

    for (const path of ["denied-link.txt", "../denied/secret-marker.txt"]) {
      const denied = await authenticated.get("/file/content", {
        params: { directory: workspace, path },
      })
      const body = await denied.text()
      expect(body, `denied target ${path} leaked the marker`).not.toContain("FILE_PREVIEW_DENIED_MARKER_DO_NOT_EXPOSE")
      expect(denied.status() === 200 && body.length > 0, `denied target ${path} served content`).toBe(false)
    }

    // Disclosed backend defect (root-repair queue): a missing file reads as
    // 200 with empty content instead of 404. The fail-closed line here is that
    // no other file's bytes can come back through a missing-path read.
    const missing = await authenticated.get("/file/content", {
      params: { directory: workspace, path: "does-not-exist.md" },
    })
    const missingBody = JSON.parse(await missing.text()) as { content?: string }
    expect(missingBody.content ?? "", "a missing-path read must not carry bytes").toBe("")
    await authenticated.dispose()
  })

  test("delayed image responses never expose a raw relative src before resolution", async ({ page }) => {
    const delayedPath = "images/nested.png"
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(
      (url) => url.pathname.endsWith("/file/content"),
      async (route) => {
        const target = new URL(route.request().url())
        if (target.searchParams.get("path") === delayedPath) {
          await gate
          await route.continue()
          return
        }
        await route.continue()
      },
    )

    await seedLayout(page)
    const request = page.request
    const sessionID = await createFixtureSession(request)
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await page.locator("#review-panel").getByRole("button", { name: "Open file" }).click()
    for (const prefix of ["guide", "guide/nested"]) {
      await page.locator(`#review-panel [data-slot="file-tree-v2-row"][data-path="${prefix}"]`).click()
    }
    await page.locator('#review-panel [data-slot="file-tree-v2-row"][data-path="guide/nested/deep.md"]').click()

    const preview = page.locator('[data-component="file-preview"][data-file-preview-build]')
    await expect(preview).toBeVisible()

    const pending = await preview
      .locator("img[src]")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("src") ?? "").filter((src) => !src.startsWith("data:")),
      )
    expect(pending, "a raw relative src surfaced while the resource response was delayed").toEqual([])

    release?.()
    // The SDK fails a fetch that stays gated past its tolerance and caches the
    // failure, so the slot resolves either back to the decoded image or to the
    // explicit placeholder - never to a raw relative src.
    const image = preview.getByRole("img", { name: "nested" })
    await expect(image).toBeVisible({ timeout: 15000 })
    const resolved = await image.evaluate((element) => {
      if (element instanceof HTMLImageElement)
        return { kind: "image", naturalWidth: element.naturalWidth, src: element.src }
      return { kind: "placeholder", naturalWidth: -1, src: "" }
    })
    if (resolved.kind === "image") {
      expect(resolved.naturalWidth).toBe(1)
      expect(resolved.src.startsWith("data:image/")).toBe(true)
    } else {
      await expect(preview.locator('[data-file-preview-resource="unavailable"]')).toHaveCount(1)
    }
    const late = await preview
      .locator("img[src]")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("src") ?? "").filter((src) => !src.startsWith("data:")),
      )
    expect(late, "a raw relative src surfaced after the delayed response").toEqual([])
  })
})
