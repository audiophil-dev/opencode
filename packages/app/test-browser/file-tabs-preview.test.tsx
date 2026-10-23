import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { Marked } from "marked"
import { createComponent, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { render } from "solid-js/web"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { dict as enDict } from "@/i18n/en"
import { closeSessionTab, type SessionTabState } from "../src/context/layout-tabs"
import type { SyntheticFindState } from "./file-tabs-preview-fixtures"

// The app `test:unit` runner compiles workspace `.tsx` to the React runtime, so the real Solid
// components cannot be imported as-is. Reuse the Solid compiler already installed for this
// package the same way the other test-browser suites do. Test-only, no new dependency.
const appRequire = createRequire(import.meta.url)
const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
const babel = solidRequire("@babel/core")
const presetSolid = solidRequire("babel-preset-solid")
const presetTypeScript = solidRequire("@babel/preset-typescript")

plugin({
  name: "file-tabs-preview-solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      if (args.path.includes("node_modules")) return
      const code = await Bun.file(args.path).text()
      const result = await babel.transformAsync(code, {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypeScript, {}],
        ],
      })
      return { contents: result?.code ?? code, loader: "js" }
    })
  },
})

const marked = new Marked({
  renderer: {
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : ""
      return `<a href="${href}"${titleAttr}>${text}</a>`
    },
  },
})

mock.module("../../session-ui/src/components/markdown-worker", () => ({
  parseMarkdown: (text: string) => Promise.resolve(marked.parse(text)),
  projectMarkdown: async (_key: string, text: string) => ({
    text,
    blocks: [{ raw: text, src: text, mode: "full" as const }],
  }),
  highlightStreamingCode: async () => ({ language: "text", generation: 1, stable: [], unstable: [] }),
  disposeMarkdownProjection: () => {},
  disposeStreamingCode: () => {},
  MarkdownWorkerDisposedError: class extends Error {},
  MarkdownWorkerSupersededError: class extends Error {},
  MarkdownWorkerUnavailableError: class extends Error {},
}))

mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: () => document.createElement("span") }))

const { MockButton, createSyntheticFile } = await import("./file-tabs-preview-fixtures")

// Kobalte's dist ships untransformed Solid JSX that Bun's loader cannot compile under the test
// runtime, so the existing Button primitive stands in as a native button carrying the same
// aria-pressed/onClick surface the product code sets.
mock.module("@opencode-ai/ui/button", () => ({ Button: MockButton }))
mock.module("@opencode-ai/ui/context/i18n", () => ({
  useI18n: () => ({
    t: translate,
    plural: (key: string, count: number, params?: Record<string, string>) =>
      translate(key, { ...(params ?? {}), count: String(count) }),
  }),
}))
mock.module("@/utils/toast", () => ({ showToast: (options: unknown) => toasts.push(options) }))

function translate(key: string, params?: Record<string, string>) {
  const text = (enDict as Record<string, string>)[key] ?? key
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_match, name: string) => String(params[name] ?? ""))
}

// ---------------------------------------------------------------------------
// Fake app state
// ---------------------------------------------------------------------------

type FakeFileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  error?: string
  content?: FileContent
}

type SelectedRange = { start: number; end: number; side?: string; endSide?: string }

const DIRECTORY = "/work/repo"
const SESSION_KEY = "session-1"

let fileStore: ReturnType<typeof createFileStore>
let tabsApi: ReturnType<typeof createTabsApi>
let scrollEvents: Array<{ tab: string; pos: { x: number; y: number } }>
let savedScroll: Map<string, { x: number; y: number }>
let promptCalls: Array<{ kind: string; path?: string; comment?: string; id?: string }>
let toasts: unknown[]
let handoffFiles: Record<string, SelectedRange> | undefined

function decodeTab(tab: string) {
  if (!tab.startsWith("file://")) return tab
  try {
    return decodeURIComponent(tab.slice("file://".length))
  } catch {
    return tab.slice("file://".length)
  }
}

function textContent(body: string): FileContent {
  return { type: "text", content: body } as FileContent
}

function binaryContent(body: string): FileContent {
  return { type: "binary", content: body } as FileContent
}

function imageContent(body: string): FileContent {
  return { type: "binary", content: body, mimeType: "image/png", encoding: "base64" } as FileContent
}

function createFileStore(entries: Record<string, FileContent>, initialReady = true) {
  const [store, setStore] = createStore<{ file: Record<string, FakeFileState> }>({ file: {} })
  const loads: string[] = []
  const selections: Record<string, SelectedRange | null> = {}
  const [version, setVersion] = createSignal(0)
  const [ready, setReady] = createSignal(initialReady)

  for (const [path, content] of Object.entries(entries)) {
    setStore("file", path, { path, name: path, loaded: true, content })
  }

  const encode = (input: string) => input.split("/").map(encodeURIComponent).join("/")

  return {
    loads,
    selections,
    get: (path: string) => {
      version()
      return store.file[path]
    },
    load: (input: string) => {
      const path = decodeTab(input)
      loads.push(input)
      setStore("file", path, (prev) => prev ?? { path, name: path })
      setStore("file", path, "loaded", true)
      return Promise.resolve()
    },
    ready: () => ready(),
    setReady,
    normalize: (input: string) => decodeTab(input),
    tab: (input: string) => `file://${encode(input.startsWith("file://") ? decodeTab(input) : input)}`,
    pathFromTab: (tab: string) => (tab.startsWith("file://") ? decodeTab(tab) : undefined),
    selectedLines: (path: string) => {
      version()
      return selections[path] ?? null
    },
    setSelectedLines: (path: string, range: SelectedRange | null) => {
      selections[path] = range
      setVersion((value) => value + 1)
    },
    searchFilesAndDirectories: () => Promise.resolve([]),
  }
}

function createTabsApi(initial: string[]) {
  const [state, setState] = createStore<SessionTabState>({ tabs: { all: initial, active: initial[0] } })
  return {
    all: () => state.tabs.all,
    active: () => state.tabs.active,
    // Faithful to the real tabs API contract: open only appends, activation is a
    // separate setActive call (mirrors createOpenSessionFileTab / previewTab callers).
    open: (tab: string) => {
      if (state.tabs.all.includes(tab)) return
      setState("tabs", "all", (tabs) => [...tabs, tab])
    },
    setActive: (tab: string) => setState("tabs", "active", tab),
    close: (tab: string) =>
      setState(reconcile(closeSessionTab({ tabs: { all: state.tabs.all, active: state.tabs.active } }, tab))),
  }
}

mock.module("@/context/file", () => ({
  useFile: () => fileStore,
  selectionFromLines: (range: SelectedRange) => ({
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    startChar: 0,
    endChar: 0,
  }),
}))

let commentsApi: ReturnType<typeof createComments>

function createComments() {
  const [focus, setFocus] = createSignal<{ file: string; id: string } | null>(null)
  const [list, setList] = createStore<{
    items: Array<{ id: string; file: string; selection: SelectedRange; comment: string; time: number }>
  }>({
    items: [],
  })
  return {
    focus,
    setFocus,
    clearFocus: () => setFocus(null),
    list: (file: string) => list.items.filter((comment) => comment.file === file),
    add: (input: { file: string; selection: SelectedRange; comment: string }) => {
      const saved = { id: `c${list.items.length + 1}`, time: list.items.length + 1, ...input }
      setList("items", (items) => [...items, saved])
      return saved
    },
    update: (file: string, id: string, comment: string) => {
      setList("items", (item) => item.file === file && item.id === id, "comment", comment)
    },
    remove: (file: string, id: string) => {
      setList("items", (items) => items.filter((item) => !(item.file === file && item.id === id)))
    },
  }
}

mock.module("@/context/comments", () => ({ useComments: () => commentsApi }))

mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

mock.module("@/context/prompt", () => ({
  usePrompt: () => ({
    context: {
      add: (entry: { path: string; comment?: string; commentID?: string }) =>
        promptCalls.push({ kind: "add", path: entry.path, comment: entry.comment, id: entry.commentID }),
      updateComment: (path: string, id: string, patch: { comment: string }) =>
        promptCalls.push({ kind: "update", path, id, comment: patch.comment }),
      removeComment: (path: string, id: string) => promptCalls.push({ kind: "remove", path, id }),
    },
  }),
}))

// The layout setting is signal-backed so SessionFileView's Show switches between the V1
// and V2 layouts reactively, the way the settings dialog does in the real app.
const [layoutV2, setLayoutV2] = createSignal(false)
mock.module("@/context/settings", () => ({
  useSettings: () => ({ general: { newLayoutDesigns: layoutV2 } }),
}))

mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({ directory: DIRECTORY }),
}))

mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    sessionKey: () => SESSION_KEY,
    ready: () => true,
    tabs: () => tabsApi,
    view: () => ({
      setScroll: (tab: string, pos: { x: number; y: number }) => {
        scrollEvents.push({ tab, pos })
      },
      scroll: (tab: string) => savedScroll.get(tab),
    }),
  }),
}))

mock.module("@/pages/session/handoff", () => ({
  getSessionHandoff: () => (handoffFiles ? { prompt: "", files: handoffFiles } : undefined),
}))

// Synthetic text renderer standing in for the Pierre File component. It exercises the same
// props surface the real source renderer receives (search registration, selection callbacks,
// selected lines) without Pierre's worker pool. The REAL renderer is exercised in the
// Chromium QA harness, not here.
const syntheticState: SyntheticFindState = { focusCalls: 0, registers: 0, visible: {} }
const SyntheticFile = createSyntheticFile(syntheticState)

mock.module("@opencode-ai/ui/context/file", () => ({ useFileComponent: () => SyntheticFile }))

beforeEach(() => {
  fileStore = createFileStore({})
  tabsApi = createTabsApi(["file://docs/readme.md"])
  commentsApi = createComments()
  scrollEvents = []
  savedScroll = new Map()
  promptCalls = []
  syntheticState.focusCalls = 0
  syntheticState.registers = 0
  syntheticState.visible = {}
  toasts = []
  handoffFiles = undefined
  document.body.innerHTML = ""
  const happy = window as Window &
    typeof globalThis & {
      happyDOM: { setURL: (url: string) => void; settings: { navigation: { disableMainFrameNavigation: boolean } } }
    }
  happy.happyDOM.setURL("http://localhost/")
  happy.happyDOM.settings.navigation.disableMainFrameNavigation = true
  ;(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function () {
    scrolled.push(this as Element)
  }
})

const scrolled: Element[] = []

const { FileTabPreviewStateProvider, SessionFileView, previewEligible } = await import("../src/pages/session/file-tabs")
const reloadHandoff = await import("../src/pages/session/file-tab-reload-handoff")

const HANDOFF_KEY = "opencode.file-tab-reload-handoff.v1"
const navigation = Object.getOwnPropertyDescriptor(performance, "getEntriesByType")

function stubNavigation(type?: "reload" | "navigate") {
  Object.defineProperty(performance, "getEntriesByType", {
    configurable: true,
    value: (kind: string) => (kind === "navigation" && type ? [{ type }] : []),
  })
}

function handoffRaw() {
  return sessionStorage.getItem(HANDOFF_KEY) ?? undefined
}

function handoffPayload() {
  const raw = handoffRaw()
  return raw === undefined ? undefined : JSON.parse(raw)
}

// The test knows the storage protocol, not a product test hook. The provider's document nonce
// is opaque, so a simulated new document rewrites the stored nonce to a known different value.
function simulateReloadDocument() {
  try {
    const payload = handoffPayload()
    if (payload) {
      payload.nonce = "doc-previous"
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload))
    }
  } catch {}
  stubNavigation("reload")
}

// The production write happens at exactly one site: the layout-setting flip in
// context/settings.setNewLayoutDesigns immediately before its scheduled reload. Tests call
// the same helper to arm the handoff from the provider's registered capture.
function armReloadHandoff() {
  reloadHandoff.writeFileTabReloadHandoffFromCapture()
}

function mountTabs(input: { documents: Record<string, FileContent>; tabs: string[]; ready?: boolean }) {
  fileStore = createFileStore(input.documents, input.ready ?? true)
  tabsApi = createTabsApi(input.tabs)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () =>
      createComponent(FileTabPreviewStateProvider, {
        get children() {
          return createComponent(For, {
            get each() {
              return tabsApi.all()
            },
            children: (tab: string) => createComponent(SessionFileView, { tab }),
          })
        },
      }),
    host,
  )
  return { host, dispose }
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// Mirrors the real app's single-active mount (session-side-panel renders only the active
// file tab), unlike mountTabs which mounts every tab as siblings.
function mountActiveTab(input: { documents: Record<string, FileContent>; tabs: string[]; ready?: boolean }) {
  fileStore = createFileStore(input.documents, input.ready ?? true)
  tabsApi = createTabsApi(input.tabs)
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () =>
      createComponent(FileTabPreviewStateProvider, {
        get children() {
          return createComponent(Show, {
            get when() {
              return tabsApi.active()
            },
            keyed: true,
            children: (tab: string) => createComponent(SessionFileView, { tab }),
          })
        },
      }),
    host,
  )
  return { host, dispose }
}

function modeButtons(host: HTMLElement) {
  const group = host.querySelector('[role="group"]')
  if (!group) return null
  const buttons = Array.from(group.querySelectorAll("button"))
  const preview = buttons.find(
    (button) =>
      button.getAttribute("aria-pressed") !== null && button.textContent === translate("filePreview.mode.preview"),
  )
  const source = buttons.find(
    (button) =>
      button.getAttribute("aria-pressed") !== null && button.textContent === translate("filePreview.mode.source"),
  )
  if (!preview || !source) return null
  return {
    group,
    preview,
    source,
    active: () =>
      preview.getAttribute("aria-pressed") === "true"
        ? "preview"
        : source.getAttribute("aria-pressed") === "true"
          ? "source"
          : null,
  }
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

const README = "# Readme\n\n[go](nested/other.md#target-heading)\n"
const OTHER = "# Target Heading\n\nbody\n"
// Link pair for the navigation-activation regressions: readme -> guide -> readme.
const LINKED_README = "# Readme\n\n[go](guide.md#target-heading)\n"
const GUIDE = "# Target Heading\n\n[back](readme.md)\n"

// The whole V1 behavioral suite is the V2 parity lock: every assertion here runs against
// both layouts. V2-specific controller edges live in their own describe below.
for (const layout of ["v1", "v2"] as const) {
  describe(`SessionFileView preview/source modes (${layout})`, () => {
    beforeEach(() => setLayoutV2(layout === "v2"))
    test("recognized Markdown text defaults to Preview with accessible controls", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)
      expect(modes).not.toBeNull()
      expect(modes!.active()).toBe("preview")
      expect(modes!.preview.getAttribute("aria-pressed")).toBe("true")
      expect(host.querySelector('[data-component="file-preview"]')).not.toBeNull()
      expect(host.querySelector("h1")?.textContent).toBe("Readme")
      dispose()
      host.remove()
    })

    test("non-Markdown files and binary Markdown keep the source renderer with no controls", async () => {
      const { host, dispose } = mountTabs({
        documents: {
          "docs/readme.md": binaryContent(README),
          "docs/notes.txt": textContent("plain"),
          "docs/pic.png": binaryContent("raw"),
        },
        tabs: ["file://docs/readme.md", "file://docs/notes.txt", "file://docs/pic.png"],
      })
      await flush()
      expect(modeButtons(host)).toBeNull()
      expect(host.querySelector('[data-component="file-preview"]')).toBeNull()
      expect(host.querySelectorAll('[data-component="synthetic-file"]').length).toBe(3)
      dispose()
      host.remove()
    })

    test("toggling to Source and back keeps the visited renderer mounted and hidden", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!
      click(modes.source)
      await flush()
      expect(modes.active()).toBe("source")
      expect(host.querySelector('[data-component="file-preview"]')).toBeNull()
      const sourcePane = host.querySelector('[data-component="synthetic-file"]')
      expect(sourcePane).not.toBeNull()

      click(modes.preview)
      await flush()
      expect(modes.active()).toBe("preview")
      expect(host.querySelector('[data-component="file-preview"]')).not.toBeNull()
      const hiddenPane = host.querySelector<HTMLElement>('[data-slot="file-source-pane"]')
      expect(hiddenPane).not.toBeNull()
      expect(hiddenPane!.style.display).toBe("none")
      expect(hiddenPane!.querySelector('[data-component="synthetic-file"]')).not.toBeNull()
      dispose()
      host.remove()
    })

    test("selections survive a Preview roundtrip and a hidden null selection end clears nothing", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!
      click(modes.source)
      await flush()

      const endRange = host.querySelector('[data-testid="synthetic-end-range"]')!
      click(endRange)
      await flush()
      expect(fileStore.selections["docs/readme.md"]).toEqual({ start: 2, end: 3 })

      click(modes.preview)
      await flush()
      // The hidden source reports a selection end while Preview is up: it must be ignored.
      click(host.querySelector('[data-testid="synthetic-end-null"]')!)
      await flush()
      expect(fileStore.selections["docs/readme.md"]).toEqual({ start: 2, end: 3 })

      click(modes.source)
      await flush()
      const pane = host.querySelector<HTMLElement>('[data-component="synthetic-file"]')!
      expect(pane.getAttribute("data-synthetic-selection")).toBe(JSON.stringify({ start: 2, end: 3 }))
      expect(pane.style.display).not.toBe("none")
      dispose()
      host.remove()
    })

    test("comment focus switches to Source and restores the comment's exact lines", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!
      expect(modes.active()).toBe("preview")

      commentsApi.add({ file: "docs/readme.md", selection: { start: 4, end: 6 }, comment: "note" })
      commentsApi.setFocus({ file: "docs/readme.md", id: "c1" })
      await flush()
      await flush()

      expect(modes.active()).toBe("source")
      const pane = host.querySelector<HTMLElement>('[data-component="synthetic-file"]')!
      expect(pane.getAttribute("data-synthetic-selection")).toBe(JSON.stringify({ start: 4, end: 6 }))
      expect(commentsApi.focus()).toBeNull()
      dispose()
      host.remove()
    })

    test("an existing preserved selection alone does not force Source mode", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      fileStore.selections["docs/readme.md"] = { start: 2, end: 3 }
      await flush()
      expect(modeButtons(host)!.active()).toBe("preview")
      dispose()
      host.remove()
    })

    test("cross-document heading navigation reuses the already-mounted destination tab", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README), "docs/nested/other.md": textContent(OTHER) },
        tabs: ["file://docs/readme.md", "file://docs/nested/other.md"],
      })
      await flush()
      expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/nested/other.md"])

      const sourceTabPreview = host.querySelectorAll('[data-component="file-preview"]')[0]!
      sourceTabPreview.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()

      expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/nested/other.md"])
      expect(fileStore.loads).toContain("file://docs/nested/other.md")
      expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
      dispose()
      host.remove()
    })

    test("closing a tab resets its mode and anchor; reopening starts from Preview", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README), "docs/nested/other.md": textContent(OTHER) },
        tabs: ["file://docs/readme.md", "file://docs/nested/other.md"],
      })
      await flush()

      // Send the destination tab to Source via a comment focus transition.
      commentsApi.add({ file: "docs/nested/other.md", selection: { start: 1, end: 2 }, comment: "note" })
      commentsApi.setFocus({ file: "docs/nested/other.md", id: "c1" })
      await flush()
      await flush()

      // Navigate again so the destination holds an anchor intent.
      const sourceTabPreview = host.querySelectorAll('[data-component="file-preview"]')[0]!
      sourceTabPreview.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()

      tabsApi.close("file://docs/nested/other.md")
      await flush()
      expect(tabsApi.all()).toEqual(["file://docs/readme.md"])
      expect(host.querySelectorAll('[data-component="file-preview"]').length).toBe(1)

      tabsApi.open("file://docs/nested/other.md")
      await flush()
      expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/nested/other.md"])
      expect(host.querySelectorAll('[data-component="file-preview"]').length).toBe(2)
      expect(modeButtons(host)!.active()).toBe("preview")

      // The reopened tab re-anchors from scratch and scrolls to the target heading again.
      host
        .querySelectorAll('[data-component="file-preview"]')[0]!
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
      expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
      dispose()
      host.remove()
    })

    test("preview and source scroll states are separate and the preview never feeds the source scroll sync", async () => {
      savedScroll.set("file://docs/readme.md", { x: 5, y: 40 })
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()

      const modes = modeButtons(host)!
      click(modes.source)
      await flush()
      const viewport = host.querySelector<HTMLElement>('[data-component="synthetic-file"]')!.closest("div")!
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      await flush()
      expect(scrollEvents.length).toBeGreaterThan(0)
      const sourceCount = scrollEvents.length

      click(modes.preview)
      await flush()
      const previewRoot = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
      scrollEvents.length = 0
      previewRoot.scrollTop = 500
      previewRoot.dispatchEvent(new Event("scroll", { bubbles: true }))
      await flush()
      expect(scrollEvents).toEqual([])
      expect(sourceCount).toBeGreaterThan(0)
      dispose()
      host.remove()
    })

    test("Cmd/Ctrl+F reaches the source find only in Source mode", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      expect(syntheticState.focusCalls).toBe(0)

      const press = () => {
        const event = new KeyboardEvent("keydown", {
          key: "f",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
        window.dispatchEvent(event)
        return event
      }

      let event = press()
      await flush()
      expect(syntheticState.focusCalls).toBe(0)
      expect(event.defaultPrevented).toBe(false)

      click(modeButtons(host)!.source)
      await flush()
      event = press()
      await flush()
      expect(syntheticState.focusCalls).toBe(1)
      expect(event.defaultPrevented).toBe(true)
      dispose()
      host.remove()
    })

    test("the portaled find bar hides on Preview and while another tab is active, keeping its controller", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README), "docs/nested/other.md": textContent(OTHER) },
        tabs: ["file://docs/readme.md", "file://docs/nested/other.md"],
      })
      try {
        await flush()
        expect(tabsApi.active()).toBe("file://docs/readme.md")

        click(modeButtons(host)!.source)
        await flush()
        const visible = syntheticState.visible["docs/readme.md"]!
        expect(visible).not.toBeUndefined()
        // Active tab in Source: visible.
        expect(visible()).toBe(true)

        // Active Source owns Ctrl/Cmd+F: intercepts it and focuses the registered find.
        const press = () => {
          const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true })
          window.dispatchEvent(event)
          return event
        }
        let event = press()
        await flush()
        expect(event.defaultPrevented).toBe(true)
        expect(syntheticState.focusCalls).toBe(1)

        // Back to Preview: the visited source stays mounted-hidden and its bar must hide;
        // native find applies, so the hidden handler must not intercept or focus.
        click(modeButtons(host)!.preview)
        await flush()
        expect(visible()).toBe(false)
        event = press()
        await flush()
        expect(event.defaultPrevented).toBe(false)
        expect(syntheticState.focusCalls).toBe(1)

        click(modeButtons(host)!.source)
        await flush()

        // Review selected: createSessionTabs has no review callback here, so activeFileTab
        // falls back to the first opened file tab; visibility must use the selected tab.
        tabsApi.setActive("review")
        await flush()
        expect(visible()).toBe(false)
        // Review owns the key: native find applies, the hidden bar is not focused.
        event = press()
        await flush()
        expect(event.defaultPrevented).toBe(false)
        expect(syntheticState.focusCalls).toBe(1)

        // Context selected: activeFileTab resolves undefined, the bar stays hidden too.
        tabsApi.setActive("context")
        await flush()
        expect(visible()).toBe(false)
        event = press()
        await flush()
        expect(event.defaultPrevented).toBe(false)
        expect(syntheticState.focusCalls).toBe(1)

        tabsApi.setActive("file://docs/nested/other.md")
        await flush()
        expect(visible()).toBe(false)

        // Reselecting the original restores visibility; the find controller never remounted
        // (the second tab never visited Source, so only readme ever registered one).
        tabsApi.setActive("file://docs/readme.md")
        await flush()
        expect(visible()).toBe(true)
        expect(syntheticState.registers).toBe(1)
        // Selection restored: the handler owns Ctrl+F again.
        event = press()
        await flush()
        expect(event.defaultPrevented).toBe(true)
        expect(syntheticState.focusCalls).toBe(2)
      } finally {
        dispose()
        host.remove()
      }
    })

    test("an unsent comment draft survives a Preview roundtrip while the source is hidden", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!
      click(modes.source)
      await flush()

      // Opening a draft through the real controller: onLineSelectionEnd(range) opens it.
      click(host.querySelector('[data-testid="synthetic-end-range"]')!)
      await flush()
      expect(host.querySelector('[data-component="synthetic-file"]')!.getAttribute("data-synthetic-draft")).toBe(
        "draft:docs/readme.md",
      )

      click(modes.preview)
      await flush()
      // The hidden source reports a null selection end during the mode-only hide: it must
      // not cancel the draft.
      click(host.querySelector('[data-testid="synthetic-end-null"]')!)
      await flush()

      click(modes.source)
      await flush()
      expect(host.querySelector('[data-component="synthetic-file"]')!.getAttribute("data-synthetic-draft")).toBe(
        "draft:docs/readme.md",
      )
      dispose()
      host.remove()
    })

    test("an embedded local image resolves to a data URL inside the V1 preview", async () => {
      const { host, dispose } = mountTabs({
        documents: {
          "docs/readme.md": textContent("# Readme\n\n![p](pic.png)\n"),
          "docs/pic.png": imageContent("AAAA"),
        },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const img = host.querySelector('[data-component="file-preview"] img')
      expect(img).not.toBeNull()
      expect(img!.getAttribute("src")).toBe("data:image/png;base64,AAAA")
      dispose()
      host.remove()
    })

    test("a preview transform failure offers Source and the button switches modes", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent("# Readme\n\n![p](pic.png)\n") },
        tabs: ["file://docs/readme.md"],
      })
      // Make the referenced-image lookup throw so the real transform rejects.
      const originalGet = fileStore.get
      fileStore.get = (path: string) => {
        if (path === "docs/pic.png") throw new Error("read failed")
        return originalGet(path)
      }
      await flush()
      const error = host.querySelector("[data-file-preview-error]")
      expect(error).not.toBeNull()
      const button = error!.querySelector("button")
      expect(button?.textContent).toBe(translate("filePreview.error.viewSource"))
      click(button!)
      await flush()
      expect(modeButtons(host)!.active()).toBe("source")
      expect(host.querySelector('[data-component="synthetic-file"]')).not.toBeNull()
      dispose()
      host.remove()
    })

    test("a source over 5 MiB defaults to Source with the localized explanation and no preview parse", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent("x".repeat(5 * 1024 * 1024 + 1)) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      expect(modeButtons(host)).toBeNull()
      expect(host.querySelector('[data-component="file-preview"]')).toBeNull()
      const banner = host.querySelector("[data-file-preview-too-large]")
      expect(banner?.textContent).toBe(translate("filePreview.tooLarge", { size: "5 MiB" }))
      expect(host.querySelector('[data-component="synthetic-file"]')).not.toBeNull()
      dispose()
      host.remove()
    })

    test("a source of exactly 5 MiB stays Preview-eligible", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent("x".repeat(5 * 1024 * 1024)) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      expect(modeButtons(host)!.active()).toBe("preview")
      expect(host.querySelector('[data-component="file-preview"]')).not.toBeNull()
      expect(host.querySelector("[data-file-preview-too-large]")).toBeNull()
      dispose()
      host.remove()
    }, 20000) // Parsing a real 5 MiB fixture takes seconds; 20s absorbs resource-loaded runs without hiding a boundary-loop regression.

    test("anchored navigation to an oversized Markdown target stays in Source without parsing it", async () => {
      const { host, dispose } = mountTabs({
        documents: {
          "docs/readme.md": textContent("# Readme\n\n[big](huge.md#big-heading)\n"),
          "docs/huge.md": textContent("# Huge\n\n" + "x".repeat(5 * 1024 * 1024)),
        },
        tabs: ["file://docs/readme.md", "file://docs/huge.md"],
      })
      await flush()
      expect(host.querySelectorAll('[data-component="file-preview"]').length).toBe(1)

      host
        .querySelector('[data-component="file-preview"]')!
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()

      expect(fileStore.loads).toContain("file://docs/huge.md")
      expect(host.querySelectorAll('[data-component="file-preview"]').length).toBe(1)
      const hugeView = Array.from(host.querySelectorAll('[data-component="synthetic-file"]')).find(
        (pane) => pane.getAttribute("data-synthetic-name") === "docs/huge.md",
      )!
      expect(hugeView).not.toBeUndefined()
      expect(hugeView.closest<HTMLElement>('[data-slot="file-source-pane"]')!.style.display).not.toBe("none")
      dispose()
      host.remove()
    })

    test("a fresh external selection selects Source and returning to Preview is not re-forced", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!
      expect(modes.active()).toBe("preview")

      fileStore.setSelectedLines("docs/readme.md", { start: 4, end: 6 })
      await flush()
      expect(modes.active()).toBe("source")
      expect(host.querySelector('[data-component="synthetic-file"]')!.getAttribute("data-synthetic-selection")).toBe(
        JSON.stringify({ start: 4, end: 6 }),
      )

      click(modes.preview)
      await flush()
      expect(modes.active()).toBe("preview")
      // The preserved old range must not continuously drag the view back to Source.
      await flush()
      expect(modes.active()).toBe("preview")
      expect(fileStore.selections["docs/readme.md"]).toEqual({ start: 4, end: 6 })

      // Clearing the selection while in Preview is not a request: no mode switch either.
      fileStore.setSelectedLines("docs/readme.md", null)
      await flush()
      expect(modes.active()).toBe("preview")
      dispose()
      host.remove()
    })

    test("a handoff selection opens Source at readiness and Preview remains stable afterwards", async () => {
      handoffFiles = { "docs/readme.md": { start: 4, end: 6 } }
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
        ready: false,
      })
      await flush()
      const modes = modeButtons(host)!
      expect(modes.active()).toBe("preview")

      // Readiness arrives before any store write: the pending handoff request must still
      // consume once and select Source.
      fileStore.setReady(true)
      await flush()
      await flush()
      expect(modes.active()).toBe("source")

      // The handoff apply then lands the same range in the file store.
      fileStore.setSelectedLines("docs/readme.md", { start: 4, end: 6 })
      await flush()
      expect(host.querySelector('[data-component="synthetic-file"]')!.getAttribute("data-synthetic-selection")).toBe(
        JSON.stringify({ start: 4, end: 6 }),
      )

      click(modes.preview)
      await flush()
      await flush()
      expect(modes.active()).toBe("preview")
      expect(fileStore.selections["docs/readme.md"]).toEqual({ start: 4, end: 6 })
      dispose()
      host.remove()
    })

    test("a preserved selection hydrated at the readiness boundary stays Preview without a handoff", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
        ready: false,
      })
      // Old preserved range already in the store, no handoff entry: the memo's
      // null -> range switch at the readiness boundary is hydration, not a request.
      fileStore.selections["docs/readme.md"] = { start: 2, end: 3 }
      await flush()
      const modes = modeButtons(host)!
      expect(modes.active()).toBe("preview")

      fileStore.setReady(true)
      await flush()
      await flush()
      expect(modes.active()).toBe("preview")

      // A genuinely new range request once ready must still select Source.
      fileStore.setSelectedLines("docs/readme.md", { start: 4, end: 6 })
      await flush()
      expect(modes.active()).toBe("source")
      dispose()
      host.remove()
    })

    test("anchored navigation to a tab open in Source switches it to Preview and keeps its source state", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README), "docs/nested/other.md": textContent(OTHER) },
        tabs: ["file://docs/readme.md", "file://docs/nested/other.md"],
      })
      await flush()
      const groups = () => Array.from(host.querySelectorAll('[role="group"]'))
      const groupMode = (group: Element) => {
        const buttons = Array.from(group.querySelectorAll("button")).filter(
          (button) => button.getAttribute("aria-pressed") !== null,
        )
        const preview = buttons.find((button) => button.textContent === translate("filePreview.mode.preview"))!
        const source = buttons.find((button) => button.textContent === translate("filePreview.mode.source"))!
        return preview.getAttribute("aria-pressed") === "true" ? "preview" : "source"
      }
      expect(groupMode(groups()[1]!)).toBe("preview")

      // Put the destination tab into Source with a selection before navigating to it.
      click(groups()[1]!.querySelectorAll("button")[1]!)
      await flush()
      expect(groupMode(groups()[1]!)).toBe("source")
      const destinationView = groups()[1]!.parentElement!
      click(
        destinationView
          .querySelector('[data-component="synthetic-file"]')!
          .querySelector('[data-testid="synthetic-end-range"]')!,
      )
      await flush()
      expect(fileStore.selections["docs/nested/other.md"]).toEqual({ start: 2, end: 3 })

      host
        .querySelectorAll('[data-component="file-preview"]')[0]!
        .querySelector("a")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()

      expect(groupMode(groups()[1]!)).toBe("preview")
      expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
      const hidden = destinationView.querySelector<HTMLElement>('[data-slot="file-source-pane"]')!
      expect(hidden).not.toBeUndefined()
      expect(hidden.style.display).toBe("none")
      expect(hidden.querySelector('[data-component="synthetic-file"]')!.getAttribute("data-synthetic-selection")).toBe(
        JSON.stringify({ start: 2, end: 3 }),
      )
      dispose()
      host.remove()
    })

    test("preview scroll restores across a Source roundtrip without feeding the source scroll slot", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(README) },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      const modes = modeButtons(host)!

      const previewRoot = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
      previewRoot.scrollTop = 500
      previewRoot.dispatchEvent(new Event("scroll", { bubbles: true }))
      await flush()

      click(modes.source)
      await flush()
      expect(host.querySelector('[data-component="file-preview"]')).toBeNull()

      click(modes.preview)
      await flush()
      const restored = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
      expect(restored.scrollTop).toBe(500)
      expect(savedScroll.get("file://docs/readme.md")).toBeUndefined()
      expect(scrollEvents).toEqual([])
      dispose()
      host.remove()
    })

    test("navigation loads through the encoded tab input, not the decoded path", async () => {
      const { host, dispose } = mountTabs({
        documents: {
          "docs/readme.md": textContent("# Readme\n\n[go](weird%231.md#frag)\n"),
          "docs/weird#1.md": textContent("# Weird\n"),
        },
        tabs: ["file://docs/readme.md"],
      })
      await flush()
      host
        .querySelector('[data-component="file-preview"] a')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      await flush()
      expect(tabsApi.all()).toContain("file://docs/weird%231.md")
      expect(fileStore.loads).toContain("file://docs/weird%231.md")
      dispose()
      host.remove()
    })

    test("cross-file navigation activates the destination tab and the return link reuses it", async () => {
      const { host, dispose } = mountActiveTab({
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        tabs: ["file://docs/readme.md"],
      })
      try {
        await flush()
        expect(tabsApi.active()).toBe("file://docs/readme.md")

        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()

        // The destination is a new tab: appended once, activated, and actually rendered.
        expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/guide.md"])
        expect(tabsApi.active()).toBe("file://docs/guide.md")
        expect(host.querySelectorAll('[data-component="file-preview"]').length).toBe(1)
        expect(host.querySelector('[data-component="file-preview"]')!.textContent).toContain("Target Heading")

        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()

        // The return link reuses the existing readme tab: no duplicate, selection moves back.
        expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/guide.md"])
        expect(tabsApi.active()).toBe("file://docs/readme.md")
        expect(host.querySelector('[data-component="file-preview"]')!.textContent).toContain("Readme")
      } finally {
        dispose()
        host.remove()
      }
    })

    test("anchored navigation to an already-open Source tab activates it without duplicating", async () => {
      const { host, dispose } = mountTabs({
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        tabs: ["file://docs/readme.md", "file://docs/guide.md"],
      })
      try {
        await flush()
        const groups = () => Array.from(host.querySelectorAll('[role="group"]'))
        // Put the already-open destination into Source before navigating to it.
        click(groups()[1]!.querySelectorAll("button")[1]!)
        await flush()

        host
          .querySelectorAll('[data-component="file-preview"]')[0]!
          .querySelector("a")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
        await flush()

        expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/guide.md"])
        expect(tabsApi.active()).toBe("file://docs/guide.md")
        expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
      } finally {
        dispose()
        host.remove()
      }
    })
  })
}

describe("SessionFileViewV2 line-comment edges", () => {
  beforeEach(() => setLayoutV2(true))

  test("a visible null selection end in Source clears the selection and draft", async () => {
    const { host, dispose } = mountTabs({
      documents: { "docs/readme.md": textContent(README) },
      tabs: ["file://docs/readme.md"],
    })
    await flush()
    click(modeButtons(host)!.source)
    await flush()

    const pane = host.querySelector('[data-component="synthetic-file"]')!
    click(pane.querySelector('[data-testid="synthetic-end-range"]')!)
    await flush()
    expect(fileStore.selections["docs/readme.md"]).toEqual({ start: 2, end: 3 })
    expect(pane.getAttribute("data-synthetic-draft")).toBe("draft:docs/readme.md")

    click(pane.querySelector('[data-testid="synthetic-end-null"]')!)
    await flush()
    expect(fileStore.selections["docs/readme.md"]).toBeNull()
    expect(pane.getAttribute("data-synthetic-draft")).toBe("")
    dispose()
    host.remove()
  })

  test("a line-number-only selection opens the draft without a prior line selection", async () => {
    const { host, dispose } = mountTabs({
      documents: { "docs/readme.md": textContent(README) },
      tabs: ["file://docs/readme.md"],
    })
    await flush()
    click(modeButtons(host)!.source)
    await flush()

    const pane = host.querySelector('[data-component="synthetic-file"]')!
    expect(fileStore.selections["docs/readme.md"]).toBeUndefined()
    click(pane.querySelector('[data-testid="synthetic-linenumber-end"]')!)
    await flush()
    expect(pane.getAttribute("data-synthetic-draft")).toBe("draft:docs/readme.md")
    expect(fileStore.selections["docs/readme.md"]).toEqual({
      start: 5,
      end: 2,
      side: "additions",
      endSide: "deletions",
    })
    dispose()
    host.remove()
  })

  test("a reversed line-number selection drives the annotation side from endSide", async () => {
    const { host, dispose } = mountTabs({
      documents: { "docs/readme.md": textContent(README) },
      tabs: ["file://docs/readme.md"],
    })
    await flush()
    click(modeButtons(host)!.source)
    await flush()

    const pane = host.querySelector('[data-component="synthetic-file"]')!
    click(pane.querySelector('[data-testid="synthetic-linenumber-end"]')!)
    await flush()
    expect(pane.getAttribute("data-synthetic-draft-side")).toBe("deletions")
    dispose()
    host.remove()
  })
})

describe("layout switch continuity", () => {
  test("switching layouts keeps the open tab's mode, selection and draft without mixing scroll state", async () => {
    setLayoutV2(false)
    const { host, dispose } = mountActiveTab({
      documents: { "docs/readme.md": textContent(README) },
      tabs: ["file://docs/readme.md"],
    })
    await flush()

    // V1: preview scroll 500, then Source with a selection and an open draft.
    const previewRoot = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
    previewRoot.scrollTop = 500
    previewRoot.dispatchEvent(new Event("scroll", { bubbles: true }))
    await flush()
    click(modeButtons(host)!.source)
    await flush()
    const v1Pane = host.querySelector('[data-component="synthetic-file"]')!
    click(v1Pane.querySelector('[data-testid="synthetic-end-range"]')!)
    await flush()
    expect(modeButtons(host)!.active()).toBe("source")

    // Switch to V2 with the same open tab: mode, selection and scroll ownership must
    // survive the remount. (An unsent draft is controller-local per layout mount and is
    // intentionally not migrated; mode-switch draft survival is locked per layout above.)
    setLayoutV2(true)
    await flush()
    expect(tabsApi.all()).toEqual(["file://docs/readme.md"])
    expect(modeButtons(host)!.active()).toBe("source")
    const v2Pane = host.querySelector('[data-component="synthetic-file"]')!
    expect(v2Pane).not.toBeNull()
    expect(v2Pane.getAttribute("data-synthetic-selection")).toBe(JSON.stringify({ start: 2, end: 3 }))
    const v2SourceWrapper = host.querySelector<HTMLElement>('[data-slot="file-source-pane"]')!
    expect(v2SourceWrapper.style.display).not.toBe("none")

    // Back to Preview in V2: the preview restores its own scroll, the source scroll slot
    // is untouched by it.
    click(modeButtons(host)!.preview)
    await flush()
    const v2Preview = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
    expect(v2Preview.scrollTop).toBe(500)
    expect(scrollEvents.every((event) => event.tab === "file://docs/readme.md" && event.pos.y !== 500)).toBe(true)

    // And back to V1 with the tab still in Preview: mode continuity holds both ways.
    setLayoutV2(false)
    await flush()
    expect(modeButtons(host)!.active()).toBe("preview")
    expect(host.querySelector('[data-component="file-preview"]')).not.toBeNull()
    dispose()
    host.remove()
  })
})

describe("previewEligible", () => {
  test("recognizes markdown text and rejects binaries and other routes", () => {
    expect(previewEligible("docs/a.md", textContent("x"))).toBe(true)
    expect(previewEligible("docs/a.MD", textContent("x"))).toBe(true)
    expect(previewEligible("docs/a.markdown", textContent("x"))).toBe(true)
    expect(previewEligible("docs/a.mdx", textContent("x"))).toBe(true)
    expect(previewEligible("docs/a.md", binaryContent("x"))).toBe(false)
    expect(previewEligible("docs/a.txt", textContent("x"))).toBe(false)
    expect(previewEligible("docs/md", textContent("x"))).toBe(false)
    expect(previewEligible(undefined, textContent("x"))).toBe(false)
  })

  test("binds the 5 MiB limit to UTF-8 bytes, not JS characters, with an inclusive boundary", () => {
    expect(previewEligible("docs/a.md", textContent("é".repeat(2_621_440)))).toBe(true)
    expect(previewEligible("docs/a.md", textContent("é".repeat(2_621_441)))).toBe(false)
    expect(previewEligible("docs/a.md", textContent("x".repeat(5 * 1024 * 1024)))).toBe(true)
    expect(previewEligible("docs/a.md", textContent("x".repeat(5 * 1024 * 1024 + 1)))).toBe(false)
  })
})

describe("layout reload mode handoff", () => {
  const README_DOC = { "docs/readme.md": textContent(README) }
  const README_TAB = ["file://docs/readme.md"]

  beforeEach(() => {
    sessionStorage.removeItem(HANDOFF_KEY)
    stubNavigation("navigate")
  })

  afterEach(() => {
    if (navigation) Object.defineProperty(performance, "getEntriesByType", navigation)
    else delete (performance as unknown as Record<string, unknown>).getEntriesByType
  })

  test("Source survives the layout flip reload and Preview survives the next one", async () => {
    const first = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(first.host)!.source)
    await flush()
    armReloadHandoff()
    expect(handoffRaw()).not.toBeUndefined()
    first.dispose()
    first.host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("source")
    expect(handoffRaw()).toBeUndefined()

    click(modeButtons(second.host)!.preview)
    await flush()
    armReloadHandoff()
    second.dispose()
    second.host.remove()

    simulateReloadDocument()
    const third = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(third.host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    third.dispose()
    third.host.remove()
  })

  test("a same-document provider remount before the reload neither consumes nor restores", async () => {
    const first = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(first.host)!.source)
    await flush()
    armReloadHandoff()
    first.dispose()
    first.host.remove()

    // Same document: the session view can remount before the scheduled reload fires.
    const remount = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(remount.host)!.active()).toBe("preview")
    expect(handoffRaw()).not.toBeUndefined()
    remount.dispose()
    remount.host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("source")
    expect(handoffRaw()).toBeUndefined()
    second.dispose()
    second.host.remove()
  })

  test("a tab closed before the flip is not resurrected and reopens at the default", async () => {
    const documents = { "docs/readme.md": textContent(README), "docs/nested/other.md": textContent(OTHER) }
    const tabs = ["file://docs/readme.md", "file://docs/nested/other.md"]
    // createTabsApi wraps the given array in a store whose reconcile mutates it on close,
    // so each mount passes its own copy.
    const { host, dispose } = mountTabs({ documents, tabs: [...tabs] })
    await flush()

    const groups = () => Array.from(host.querySelectorAll('[role="group"]'))
    click(groups()[0]!.querySelectorAll("button")[1]!)
    click(groups()[1]!.querySelectorAll("button")[1]!)
    await flush()

    tabsApi.close("file://docs/nested/other.md")
    await flush()
    armReloadHandoff()
    const payload = handoffPayload()!
    expect(payload.owner).toBe(SESSION_KEY)
    expect(Object.keys(payload.tabs)).toEqual(["file://docs/readme.md"])
    dispose()
    host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents, tabs: [...tabs] })
    await flush()
    expect(tabsApi.all()).toEqual(tabs)
    const secondGroups = Array.from(second.host.querySelectorAll('[role="group"]'))
    const groupMode = (group: Element) =>
      group.querySelectorAll("button")[0]!.getAttribute("aria-pressed") === "true" ? "preview" : "source"
    expect(groupMode(secondGroups[0]!)).toBe("source")
    expect(groupMode(secondGroups[1]!)).toBe("preview")
    second.dispose()
    second.host.remove()
  })

  test("preview scroll rides the same one-time handoff without becoming durable", async () => {
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    const previewRoot = host.querySelector<HTMLElement>('[data-component="file-preview"]')!
    previewRoot.scrollTop = 500
    previewRoot.dispatchEvent(new Event("scroll", { bubbles: true }))
    await flush()
    armReloadHandoff()
    dispose()
    host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("preview")
    expect(second.host.querySelector<HTMLElement>('[data-component="file-preview"]')!.scrollTop).toBe(500)
    expect(handoffRaw()).toBeUndefined()
    second.dispose()
    second.host.remove()
  })

  test("an ordinary Source selection alone never arms a handoff", async () => {
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(host)!.source)
    await flush()
    expect(handoffRaw()).toBeUndefined()
    dispose()
    host.remove()
  })

  test("an ordinary reload without the layout flag does not restore a stale choice", async () => {
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(host)!.source)
    await flush()
    expect(handoffRaw()).toBeUndefined()
    dispose()
    host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    second.dispose()
    second.host.remove()
  })

  test("a non-reload entry is discarded and a later reload cannot resurrect it", async () => {
    const first = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(first.host)!.source)
    await flush()
    armReloadHandoff()
    first.dispose()
    first.host.remove()

    const payload = handoffPayload()!
    payload.nonce = "doc-previous"
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload))

    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    second.dispose()
    second.host.remove()

    simulateReloadDocument()
    const third = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(third.host)!.active()).toBe("preview")
    third.dispose()
    third.host.remove()
  })

  test("a denied storage getter does not break the layout write path", async () => {
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    click(modeButtons(host)!.source)
    await flush()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError")
      },
    })
    try {
      expect(() => armReloadHandoff()).not.toThrow()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor)
      else delete (globalThis as unknown as Record<string, unknown>).sessionStorage
    }
    expect(modeButtons(host)!.active()).toBe("source")
    dispose()
    host.remove()
  })

  test("a handoff owned by another session is discarded and cannot resurrect later", async () => {
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({
        nonce: "doc-previous",
        owner: "other-session",
        tabs: { "file://docs/readme.md": { mode: "source" } },
      }),
    )
    stubNavigation("reload")
    const first = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(first.host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    first.dispose()
    first.host.remove()

    simulateReloadDocument()
    const second = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(second.host)!.active()).toBe("preview")
    second.dispose()
    second.host.remove()
  })

  test("malformed handoff storage is ignored and cleared safely", async () => {
    sessionStorage.setItem(HANDOFF_KEY, "not json")
    stubNavigation("reload")
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    dispose()
    host.remove()
  })

  test("untrusted handoff payloads drop invalid modes, scrolls and non-file tabs", async () => {
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({
        nonce: "doc-previous",
        owner: SESSION_KEY,
        tabs: {
          "file://docs/readme.md": { mode: "ultra", scroll: { x: Number.NaN, y: 1 } },
          context: { mode: "source" },
          "file://docs/other.md": { mode: "source" },
        },
      }),
    )
    stubNavigation("reload")
    const { host, dispose } = mountTabs({ documents: README_DOC, tabs: README_TAB })
    await flush()
    expect(modeButtons(host)!.active()).toBe("preview")
    expect(handoffRaw()).toBeUndefined()
    dispose()
    host.remove()
  })
})
