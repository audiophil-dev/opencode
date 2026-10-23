import { beforeEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { Marked } from "marked"
import { batch, createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { dict as enDict } from "@/i18n/en"
import { closeSessionTab, openSessionTab, type SessionTabState, type SessionTabs } from "../src/context/layout-tabs"

// Cross-file link navigation against a REAL controlled Tabs collection fed by the REAL
// tab store shape. The other test-browser suites mock the tabs API and never render a
// Kobalte root, so the documented transient - the Tabs root briefly selecting its first
// trigger (Review) while the trigger list registers a newly opened tab - cannot happen
// there. This file mounts the real @opencode-ai/ui/tabs (Kobalte) around the real
// SessionFileView, drives the actual openPreviewTarget flow through a preview link
// click, and feeds it the same store chain the layout provider uses: the real
// openSessionTab reducer, the persisted sessionTabs + ephemeral sessionTabPreview
// double-write apply batch, and the createSessionTabs activeTab memo. The destination
// file is not preloaded: the app starts its async SDK load at click time.

const appRequire = createRequire(import.meta.url)
const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
const babel = solidRequire("@babel/core")
const presetSolid = solidRequire("babel-preset-solid")
const presetTypeScript = solidRequire("@babel/preset-typescript")

plugin({
  name: "file-tabs-registration-solid-jsx",
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

type FakeFileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  error?: string
  content?: FileContent
}

const DIRECTORY = "/work/repo"
let sessionState: { key: string }

let fileStore: ReturnType<typeof createFileStore>
let tabsApi: ReturnType<typeof createTabsApi>
let toasts: unknown[]

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

function createFileStore(input: { documents: Record<string, FileContent>; preload?: string[] }, initialReady = true) {
  const documents = input.documents
  const [store, setStore] = createStore<{ file: Record<string, FakeFileState> }>({ file: {} })
  const loads: string[] = []
  const [version, setVersion] = createSignal(0)
  const [ready, setReady] = createSignal(initialReady)

  for (const path of input.preload ?? Object.keys(documents)) {
    setStore("file", path, { path, name: path, loaded: true, content: documents[path] })
  }

  const encode = (input: string) => input.split("/").map(encodeURIComponent).join("/")

  return {
    loads,
    get: (path: string) => {
      version()
      return store.file[path]
    },
    load: (input: string) => {
      const path = decodeTab(input)
      loads.push(input)
      // Same shape as the real file store: the entry exists immediately (the tab can
      // render), the content lands asynchronously.
      setStore("file", path, (prev: FakeFileState | undefined) => prev ?? { path, name: path })
      setStore("file", path, "loaded", true)
      return Promise.resolve().then(() => {
        const content = documents[path]
        if (content) setStore("file", path, "content", content)
      })
    },
    ready,
    setReady,
    normalize: (input: string) => decodeTab(input),
    tab: (input: string) => `file://${encode(input.startsWith("file://") ? decodeTab(input) : input)}`,
    pathFromTab: (tab: string) => (tab.startsWith("file://") ? decodeTab(tab) : undefined),
    selectedLines: () => null,
    searchFilesAndDirectories: () => Promise.resolve([]),
  }
}

function createTabsStore(initial: SessionTabState, events: string[]) {
  // Same store chain as layout.tsx tabs(): a persisted sessionTabs store plus an
  // ephemeral sessionTabPreview store, written through the same batched apply, with
  // the real openSessionTab/closeSessionTab reducers owning every transition. A bare
  // append-only mock is NOT the actual API: open sets active itself and the preview
  // slot decides replace-in-place vs append.
  const [persisted, setPersisted] = createStore<Record<string, SessionTabs>>({ "session-1": initial.tabs })
  const [ephemeral, setEphemeral] = createStore<Record<string, string | undefined>>({
    "session-1": initial.preview,
  })
  const session = () => sessionState.key
  const apply = (next: ReturnType<typeof openSessionTab>) => {
    batch(() => {
      setPersisted(session(), next.tabs)
      setEphemeral(session(), next.preview)
    })
  }
  return {
    all: () => (persisted[session()]?.all ?? []).filter((tab) => tab !== "review"),
    active: () => persisted[session()]?.active,
    preview: () => ephemeral[session()],
    open: async (tab: string) => {
      events.push(`open:${tab}`)
      apply(openSessionTab({ tabs: persisted[session()] ?? { all: [] }, preview: ephemeral[session()] }, tab))
    },
    setActive: (tab: string | undefined) => {
      events.push(`setActive:${String(tab)}`)
      if (!persisted[session()]) setPersisted(session(), { all: [], active: tab })
      else setPersisted(session(), "active", tab)
    },
    close: (tab: string) => {
      events.push(`close:${tab}`)
      if (!persisted[session()]) return
      apply(closeSessionTab({ tabs: persisted[session()], preview: ephemeral[session()] }, tab))
    },
  }
}

mock.module("@/context/file", () => ({
  useFile: () => fileStore,
  selectionFromLines: (range: { start: number; end: number }) => ({
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    startChar: 0,
    endChar: 0,
  }),
}))

mock.module("@/context/comments", () => ({
  useComments: () => ({
    focus: () => null,
    list: () => [],
    annotations: () => [],
  }),
}))

mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

mock.module("@/context/prompt", () => ({
  usePrompt: () => ({ context: { add: () => {}, updateComment: () => {}, removeComment: () => {} } }),
}))

const [layoutV2, setLayoutV2] = createSignal(false)
mock.module("@/context/settings", () => ({
  useSettings: () => ({ general: { newLayoutDesigns: layoutV2 } }),
}))

mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({ directory: DIRECTORY }),
}))

mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    sessionKey: () => sessionState.key,
    ready: () => true,
    tabs: () => tabsApi,
    view: () => ({
      setScroll: () => {},
      scroll: () => undefined,
    }),
  }),
}))

mock.module("@/pages/session/handoff", () => ({ getSessionHandoff: () => undefined }))

const syntheticState = { focusCalls: 0, registers: 0, visible: {} as Record<string, () => boolean | undefined> }
const SyntheticFile = createSyntheticFile(syntheticState)
mock.module("@opencode-ai/ui/context/file", () => ({ useFileComponent: () => SyntheticFile }))

beforeEach(() => {
  sessionState = { key: "session-1" }
  fileStore = createFileStore({ documents: {} })
  tabsApi = createTabsStore({ tabs: { all: [], active: "review" } }, [])
  syntheticState.focusCalls = 0
  syntheticState.registers = 0
  syntheticState.visible = {}
  toasts = []
  setLayoutV2(false)
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

const { FileTabPreviewStateProvider } = await import("../src/pages/session/file-tabs")
const { RegistrationPanelFixture } = await import("./file-tabs-registration-fixture")

async function flush() {
  // The whole Solid flush - including Kobalte trigger registration and its fallback
  // onChange - is synchronous, so queued microtasks settle everything the fix relies
  // on. Same rounds as the other test-browser suites for the async preview pipeline.
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function mountPanel(input: {
  documents: Record<string, FileContent>
  preload?: string[]
  state: SessionTabState
  events: string[]
}) {
  fileStore = createFileStore({ documents: input.documents, preload: input.preload })
  tabsApi = createTabsStore(input.state, input.events)
  sessionState.key = "session-1"
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () =>
      createComponent(FileTabPreviewStateProvider, {
        get children() {
          return createComponent(RegistrationPanelFixture, {
            canReview: () => true,
            all: () => tabsApi.all(),
            active: () => tabsApi.active(),
            pathFromTab: (tab: string) => fileStore.pathFromTab(tab),
            normalizeTab: (tab: string) => (tab.startsWith("file://") ? fileStore.tab(tab) : tab),
            activate: (tab: string) => {
              // Same shape as the side panel's activateTab: normalize, load, select.
              const next = tab.startsWith("file://") ? fileStore.tab(tab) : tab
              const path = fileStore.pathFromTab(next)
              if (path) void fileStore.load(next)
              tabsApi.setActive(next)
            },
          })
        },
      }),
    host,
  )
  return { host, dispose }
}

function triggers(host: HTMLElement) {
  const map = new Map<string, HTMLElement>()
  for (const el of host.querySelectorAll<HTMLElement>('[role="tab"][data-slot="tabs-trigger"]')) {
    const key = el.getAttribute("data-value")
    if (key) map.set(key, el)
  }
  return map
}

function selectedValues(host: HTMLElement) {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="tab"][data-slot="tabs-trigger"]'))
    .filter((el) => el.getAttribute("aria-selected") === "true")
    .map((el) => el.getAttribute("data-value"))
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

const LINKED_README = "# Readme\n\n[go](guide.md#target-heading)\n"
const GUIDE = "# Target Heading\n\n[back](readme.md)\n"

for (const layout of ["v1", "v2"] as const) {
  describe(`openPreviewTarget against a real controlled Tabs collection (${layout})`, () => {
    beforeEach(() => setLayoutV2(layout === "v2"))

    test("a link into a new file lands on the new trigger, not the Review fallback", async () => {
      const events: string[] = []
      const { host, dispose } = mountPanel({
        // guide.md is deliberately not preloaded: the destination loads only at click time.
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        preload: ["docs/readme.md"],
        state: { tabs: { all: ["file://docs/readme.md"], active: "file://docs/readme.md" } },
        events,
      })
      try {
        await flush()
        expect(selectedValues(host)).toEqual(["file://docs/readme.md"])

        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()

        // The destination is appended once and ACTUALLY selected in the widget: the
        // Kobalte fallback (first trigger = Review) must not survive the settlement.
        expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/guide.md"])
        expect(tabsApi.active()).toBe("file://docs/guide.md")
        expect(selectedValues(host)).toEqual(["file://docs/guide.md"])
        expect(triggers(host).get("review")!.getAttribute("aria-selected")).not.toBe("true")
        expect(host.querySelector('[data-component="file-preview"]')!.textContent).toContain("Target Heading")
      } finally {
        dispose()
        host.remove()
      }
    })

    test("a link into a new file replaces a preview-slot tab in place", async () => {
      const events: string[] = []
      const { host, dispose } = mountPanel({
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        preload: ["docs/readme.md"],
        // readme holds the session preview slot, as after a v2 file-browser open:
        // the reducer then replaces it in place instead of appending.
        state: {
          tabs: { all: ["file://docs/readme.md"], active: "file://docs/readme.md" },
          preview: "file://docs/readme.md",
        },
        events,
      })
      try {
        await flush()
        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()

        expect(tabsApi.all()).toEqual(["file://docs/guide.md"])
        expect(tabsApi.active()).toBe("file://docs/guide.md")
        expect(selectedValues(host)).toEqual(["file://docs/guide.md"])
        expect(events.indexOf("open:file://docs/guide.md")).toBeLessThan(
          events.lastIndexOf("setActive:file://docs/guide.md"),
        )
      } finally {
        dispose()
        host.remove()
      }
    })

    test("a return link reuses the existing tab and does not duplicate it", async () => {
      const events: string[] = []
      const { host, dispose } = mountPanel({
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        state: { tabs: { all: ["file://docs/readme.md", "file://docs/guide.md"], active: "file://docs/readme.md" } },
        events,
      })
      try {
        await flush()
        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()
        expect(selectedValues(host)).toEqual(["file://docs/guide.md"])

        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()
        expect(tabsApi.all()).toEqual(["file://docs/readme.md", "file://docs/guide.md"])
        expect(selectedValues(host)).toEqual(["file://docs/readme.md"])
      } finally {
        dispose()
        host.remove()
      }
    })

    test("a real user click on Review still selects Review after a link navigation", async () => {
      const events: string[] = []
      const { host, dispose } = mountPanel({
        documents: { "docs/readme.md": textContent(LINKED_README), "docs/guide.md": textContent(GUIDE) },
        state: { tabs: { all: ["file://docs/readme.md"], active: "file://docs/readme.md" } },
        events,
      })
      try {
        await flush()
        click(host.querySelector('[data-component="file-preview"] a')!)
        await flush()
        expect(selectedValues(host)).toEqual(["file://docs/guide.md"])

        click(triggers(host).get("review")!)
        await flush()
        expect(tabsApi.active()).toBe("review")
        expect(selectedValues(host)).toEqual(["review"])
      } finally {
        dispose()
        host.remove()
      }
    })
  })
}
