import { beforeEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { Marked } from "marked"
import { createComponent, createContext, createSignal, For, useContext } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { render } from "solid-js/web"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { dict as enDict } from "@/i18n/en"
import { decodeFilePath, stripQueryAndHash } from "../src/context/file/path"
import type {
  FilePreviewAnchorRequest,
  FilePreviewNavigateRequest,
  FilePreviewProps,
} from "../src/pages/session/file-preview"
import { rewritePreviewResources, type PreviewFileContent } from "../src/pages/session/file-preview-resources"

// The app `test:unit` runner compiles workspace `.tsx` to the React runtime, so the real Solid
// `Markdown`/`FilePreview` components cannot be imported as-is. Reuse the Solid compiler already
// installed for this package the same way test-browser/file-preview-markdown.test.tsx does.
// Test-only, no new dependency and no shared config change.
const appRequire = createRequire(import.meta.url)
const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
const babel = solidRequire("@babel/core")
const presetSolid = solidRequire("babel-preset-solid")
const presetTypeScript = solidRequire("@babel/preset-typescript")

plugin({
  name: "file-preview-solid-jsx",
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

// Stand in for the worker parser with the real `marked` renderer shape (mirrors the production
// link renderer). This keeps reference-style/raw-HTML fixtures honest without a Worker.
const marked = new Marked({
  renderer: {
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : ""
      return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: () => document.createElement("span") }))
mock.module("@opencode-ai/ui/v2/icon-button-v2", () => ({ IconButtonV2: () => document.createElement("button") }))
mock.module("@opencode-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: (props: { children?: unknown }) => props.children }))

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

type FakeFile = {
  load: (path: string) => Promise<void>
  get: (path: string) => PreviewFileContent | undefined
  set: (path: string, state: PreviewFileContent) => void
  loads: string[]
  dispose: () => void
}

type FakeTabs = { opened: string[]; open: (tab: string) => void }

const FileContext = createContext<FakeFile | undefined>(undefined)
let tabsApi: FakeTabs
let languageApi: { t: (key: string, params?: Record<string, string>) => string }
const scrolled: Element[] = []

mock.module("@/context/file", () => ({ useFile: () => useContext(FileContext) }))
mock.module("@/pages/session/session-layout", () => ({ useSessionLayout: () => ({ tabs: () => tabsApi }) }))
mock.module("@/context/language", () => ({ useLanguage: () => languageApi }))

function translate(key: string, params?: Record<string, string>) {
  const text = (enDict as Record<string, string>)[key] ?? key
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_match, name: string) => String(params[name] ?? ""))
}

// Mirrors the real provider normalizer: strip query/hash first, then decode. This is what
// makes the resolver's encoded form round-trip for names containing ? or #.
function normalizeKey(input: string) {
  return decodeFilePath(stripQueryAndHash(input))
}

beforeEach(() => {
  scrolled.length = 0
  tabsApi = { opened: [], open: (tab) => tabsApi.opened.push(tab) }
  languageApi = { t: translate }
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

const { FilePreview, MAX_PREVIEW_SOURCE_BYTES, isPreviewSourceTooLarge, previewSourceBytes } = await import(
  "../src/pages/session/file-preview"
)

function media(mimeType: string, body: string, encoding = "base64"): PreviewFileContent {
  return { loaded: true, content: { content: body, mimeType, encoding } as unknown as FileContent }
}

function createFakeFile(
  entries: Record<string, PreviewFileContent>,
  loadImpl: (path: string, loads: string[]) => Promise<void> = () => Promise.resolve(),
): FakeFile {
  const loads: string[] = []
  const data = new Map(Object.entries(entries))
  const [version, setVersion] = createSignal(0)
  return {
    loads,
    dispose: () => {},
    load: (path: string) => {
      loads.push(normalizeKey(path))
      return loadImpl(path, loads)
    },
    get: (path: string) => {
      version()
      return data.get(normalizeKey(path))
    },
    set: (path, state) => {
      data.set(path, state)
      setVersion((value) => value + 1)
    },
  }
}

function mountPreview(file: FakeFile, props: FilePreviewProps) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () =>
      createComponent(FileContext.Provider, {
        value: file,
        get children() {
          return createComponent(FilePreview, props)
        },
      }),
    host,
  )
  return { host, dispose }
}

type HostControls = {
  closeTab: (tab: string) => void
  openTabs: () => string[]
  anchorRevision: (tab: string) => number | undefined
}

function tabPath(tab: string) {
  return decodeFilePath(tab.slice("file://".length))
}

// Realistic parent integration shape (what task 8 wires): the parent owns the open-tab
// set and the per-tab anchor intent, turns FilePreview's navigation request into tab
// state, and renders every open tab. No module-global state is involved.
function PreviewHost(props: {
  documents: Record<string, string>
  directory: string
  owner: string
  initialTab: string
  controls: HostControls
}) {
  const [tabs, setTabs] = createStore<{ open: string[] }>({ open: [props.initialTab] })
  const [anchors, setAnchors] = createStore<{ byTab: Record<string, FilePreviewAnchorRequest> }>({ byTab: {} })

  props.controls.openTabs = () => tabs.open
  props.controls.anchorRevision = (tab) => anchors.byTab[tab]?.revision
  props.controls.closeTab = (tab) => {
    setTabs("open", (list) => list.filter((value) => value !== tab))
    setAnchors(
      "byTab",
      produce((table) => {
        delete table[tab]
      }),
    )
  }

  const onRequestNavigate = (request: FilePreviewNavigateRequest) => {
    if (!tabs.open.includes(request.tab)) setTabs("open", (list) => [...list, request.tab])
    if (!request.fragment) return
    setAnchors("byTab", request.tab, {
      path: request.path,
      fragment: request.fragment,
      revision: (anchors.byTab[request.tab]?.revision ?? -1) + 1,
    })
  }

  return createComponent(For, {
    get each() {
      return tabs.open
    },
    children: (tab: string) => {
      const path = tabPath(tab)
      return createComponent(FilePreview, {
        path,
        get source() {
          return props.documents[path] ?? ""
        },
        get directory() {
          return props.directory
        },
        get owner() {
          return props.owner
        },
        get anchor() {
          return anchors.byTab[tab] ?? null
        },
        onRequestNavigate,
      })
    },
  })
}

function mountHost(input: {
  file: FakeFile
  documents: Record<string, string>
  directory?: string
  owner?: string
  initialTab?: string
}) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const controls = {} as HostControls
  const dispose = render(
    () =>
      createComponent(FileContext.Provider, {
        value: input.file,
        get children() {
          return createComponent(PreviewHost, {
            documents: input.documents,
            directory: input.directory ?? "dir-a",
            owner: input.owner ?? "session-1",
            initialTab: input.initialTab ?? "file://docs/a.md",
            controls,
          })
        },
      }),
    host,
  )
  return { host, dispose, controls }
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// No timers: proves anchor consumption is driven by the Markdown commit callback and
// reactive prop changes, not by setTimeout.
async function flushMicrotasks() {
  for (let index = 0; index < 60; index += 1) await Promise.resolve()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function helperFile(entries: Record<string, PreviewFileContent>) {
  const loads: string[] = []
  return {
    loads,
    load: (path: string) => {
      loads.push(normalizeKey(path))
      return Promise.resolve()
    },
    get: (path: string) => entries[normalizeKey(path)],
  }
}

describe("rewritePreviewResources", () => {
  test("strips srcset attributes", async () => {
    const result = await rewritePreviewResources('<img src="a.png" srcset="a.png 1x, b.png 2x" alt="x">', {
      documentPath: "docs/a.md",
      file: helperFile({ "docs/a.png": media("image/png", "AAAA") }),
      unavailableLabel: "unavailable",
    })
    expect(result.html).not.toContain("srcset")
  })

  test("strips every inline style attribute", async () => {
    const result = await rewritePreviewResources('<p style="background:url(evil.png)">text</p>', {
      documentPath: "docs/a.md",
      file: helperFile({}),
      unavailableLabel: "unavailable",
    })
    expect(result.html).toBe("<p>text</p>")
  })

  test("strips audio, video, object, iframe, embed and source elements", async () => {
    const html =
      '<audio src="a.mp3"></audio><video src="a.mp4"></video><object data="a.swf"></object>' +
      '<iframe src="a.html"></iframe><embed src="a.svg"><source src="a.png">'
    const file = helperFile({ "docs/a.png": media("image/png", "AAAA") })
    const result = await rewritePreviewResources(html, { documentPath: "docs/a.md", file, unavailableLabel: "u" })
    for (const tag of ["audio", "video", "object", "iframe", "embed", "source"])
      expect(result.html).not.toContain(`<${tag}`)
    expect(file.loads).toHaveLength(0)
  })

  test("strips URL-bearing elements and hrefs inside embedded SVG", async () => {
    const result = await rewritePreviewResources(
      '<svg><image href="https://evil.test/x.png"></image><use href="#x"></use><a href="https://evil.test">x</a></svg>',
      { documentPath: "docs/a.md", file: helperFile({}), unavailableLabel: "u" },
    )
    expect(result.html).not.toContain("<image")
    expect(result.html).not.toContain("<use")
    expect(result.html).not.toContain("evil.test")
  })

  test("resolves only actual img resources, never source or srcset", async () => {
    const file = helperFile({ "docs/a.png": media("image/png", "AAAA") })
    const result = await rewritePreviewResources(
      '<picture><source srcset="b.png"><img src="a.png" alt="a"></picture>',
      { documentPath: "docs/a.md", file, unavailableLabel: "u" },
    )
    expect(file.loads).toEqual([])
    expect(result.html).toContain('src="data:image/png;base64,AAAA"')
  })

  test("renders a nested local image as a data URL and keeps alt text", async () => {
    const file = helperFile({ "docs/assets/über.png": media("image/png", "BBBB") })
    const result = await rewritePreviewResources('<img src="../assets/%C3%BCber.png" alt="logo">', {
      documentPath: "docs/guide/intro.md",
      file,
      unavailableLabel: "u",
    })
    expect(result.html).toContain('src="data:image/png;base64,BBBB"')
    expect(result.html).toContain('alt="logo"')
    expect(result.references).toEqual(["docs/assets/%C3%BCber.png"])
  })

  test("passes the encoded path so ? and # filenames survive the provider normalizer", async () => {
    const file = helperFile({
      "docs/what?.png": media("image/png", "QUJD"),
      "docs/slide#1.png": media("image/png", "U0VD"),
    })
    const result = await rewritePreviewResources('<img src="what%3F.png"><img src="slide%231.png">', {
      documentPath: "docs/a.md",
      file,
      unavailableLabel: "unavailable",
    })
    expect(result.html).toContain("data:image/png;base64,QUJD")
    expect(result.html).toContain("data:image/png;base64,U0VD")
    expect(result.references).toEqual(["docs/slide%231.png", "docs/what%3F.png"])
  })

  test("deduplicates identical reads within one rewrite", async () => {
    const withContent = helperFile({ "docs/a.png": media("image/png", "AAAA") })
    const resolved = await rewritePreviewResources('<img src="a.png"><img src="a.png">', {
      documentPath: "docs/b.md",
      file: withContent,
      unavailableLabel: "u",
    })
    expect(resolved.references).toEqual(["docs/a.png"])
    expect(resolved.html.match(/data:image\/png;base64,AAAA/g)).toHaveLength(2)

    const missing = helperFile({})
    await rewritePreviewResources('<img src="a.png"><img src="a.png">', {
      documentPath: "docs/b.md",
      file: missing,
      unavailableLabel: "u",
    })
    expect(missing.loads).toEqual(["docs/a.png"])
  })

  test("uses an explicit placeholder preserving alt text for missing, denied and corrupt images", async () => {
    const cases: Array<{ name: string; state?: PreviewFileContent }> = [
      { name: "missing state" },
      { name: "error state", state: { error: "nope" } },
      { name: "wrong mime", state: media("text/plain", "AAAA") },
      { name: "non-base64 encoding", state: media("image/png", "AAAA", "utf8") },
      { name: "malformed base64", state: media("image/png", "!!!not-base64!!!") },
      { name: "unpadded-illegal base64", state: media("image/png", "AAAAA") },
    ]
    for (const item of cases) {
      const file = helperFile(item.state ? { "docs/a.png": item.state } : {})
      const result = await rewritePreviewResources('<img src="a.png" alt="kept">', {
        documentPath: "docs/b.md",
        file,
        unavailableLabel: "unavailable",
      })
      expect(result.html, item.name).toContain('data-file-preview-resource="unavailable"')
      expect(result.html, item.name).toContain("kept")
      expect(result.html, item.name).not.toContain("<img")
    }
  })

  test("rejects an oversized record before conversion", async () => {
    const file = helperFile({ "docs/a.png": media("image/png", "AAAAAAAA") })
    const result = await rewritePreviewResources('<img src="a.png" alt="big">', {
      documentPath: "docs/b.md",
      file,
      unavailableLabel: "unavailable",
      budget: 4,
    })
    expect(result.html).not.toContain("data:image/png")
    expect(result.html).toContain('data-file-preview-resource="unavailable"')
  })

  test("caps the aggregate data URL budget across images", async () => {
    const file = helperFile({
      "docs/a.png": media("image/png", "AAAAAAAA"),
      "docs/b.png": media("image/png", "BBBBBBBB"),
    })
    const result = await rewritePreviewResources('<img src="a.png"><img src="b.png">', {
      documentPath: "docs/c.md",
      file,
      unavailableLabel: "unavailable",
      budget: 90,
    })
    expect(result.html).toContain('src="data:image/png;base64,AAAAAAAA"')
    expect(result.html).toContain('data-file-preview-resource="unavailable"')
  })

  test("never loads a blocked image scheme", async () => {
    const file = helperFile({})
    const result = await rewritePreviewResources(
      '<img src="javascript:alert(1)" alt="x"><img src="file:///etc/passwd" alt="y">',
      {
        documentPath: "docs/a.md",
        file,
        unavailableLabel: "unavailable",
      },
    )
    expect(file.loads).toEqual([])
    expect(result.html).not.toContain("javascript:")
    expect(result.html).not.toContain("file:///etc/passwd")
  })

  test("leaves external images untouched", async () => {
    const result = await rewritePreviewResources('<img src="https://example.com/a.png" alt="ext">', {
      documentPath: "docs/a.md",
      file: helperFile({}),
      unavailableLabel: "u",
    })
    expect(result.html).toContain('src="https://example.com/a.png"')
  })

  test("keeps SVG files in image data URL context", async () => {
    const file = helperFile({ "docs/a.svg": media("image/svg+xml", "PHN2Zy8+") })
    const result = await rewritePreviewResources('<img src="a.svg" alt="svg">', {
      documentPath: "docs/b.md",
      file,
      unavailableLabel: "u",
    })
    expect(result.html).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"')
  })

  test("assigns deterministic heading ids with duplicate suffixes", async () => {
    const result = await rewritePreviewResources("<h1>Hello World</h1><h2>Hello World</h2><h2>Über</h2>", {
      documentPath: "docs/a.md",
      file: helperFile({}),
      unavailableLabel: "u",
    })
    expect(result.html).toContain('id="hello-world"')
    expect(result.html).toContain('id="hello-world-1"')
    expect(result.html).toContain('id="über"')
  })
})

describe("FilePreview", () => {
  test("renders the build marker on the root", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "# Hi" })
    await flush()
    expect(host.querySelector("[data-component='file-preview']")?.getAttribute("data-file-preview-build")).toBe("dev")
    dispose()
    host.remove()
  })

  test("renders nested unicode-space local images as data URLs", async () => {
    const file = createFakeFile({ "docs/assets/a b/über.png": media("image/png", "AAAA") })
    const { host, dispose } = mountPreview(file, {
      path: "docs/guide/intro.md",
      source: "![pic](../assets/a%20b/%C3%BCber.png)",
    })
    await flush()
    const src = host.querySelector("img")?.getAttribute("src") ?? ""
    expect(src.startsWith("data:image/png;base64,")).toBe(true)
    expect(host.innerHTML).not.toContain("../assets")
    expect(file.loads).toEqual([])
    dispose()
    host.remove()
  })

  test("resolves reference-style and raw-HTML images", async () => {
    const file = createFakeFile({
      "docs/ref.png": media("image/png", "UkVG"),
      "docs/raw.png": media("image/png", "UkFX"),
    })
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: '![r][logo]\n\n<img src="raw.png" alt="raw">\n\n[logo]: ref.png',
    })
    await flush()
    const sources = Array.from(host.querySelectorAll("img")).map((img) => img.getAttribute("src"))
    expect(sources).toContain("data:image/png;base64,UkVG")
    expect(sources).toContain("data:image/png;base64,UkFX")
    dispose()
    host.remove()
  })

  test("renders frontmatter as a fenced code block and the body normally", async () => {
    const file = createFakeFile({ "docs/pic.png": media("image/png", "UElD") })
    const source = ["---", "name: demo", "---", "", "# Body", "", "![pic](pic.png)", ""].join("\n")
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    const code = host.querySelector('[data-component="markdown-code"] code')?.textContent ?? ""
    expect(code).toContain("name: demo")
    expect(Array.from(host.querySelectorAll("h1")).map((h) => h.textContent)).toContain("Body")
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,UElD")
    dispose()
    host.remove()
  })

  test("isolates identical sources across two workspace providers", async () => {
    const first = createFakeFile({ "docs/pic.png": media("image/png", "T05F") })
    const second = createFakeFile({ "docs/pic.png": media("image/png", "VFdP") })
    const a = mountPreview(first, { path: "docs/a.md", source: "![p](pic.png)" })
    const b = mountPreview(second, { path: "docs/a.md", source: "![p](pic.png)" })
    await flush()
    expect(a.host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,T05F")
    expect(b.host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,VFdP")
    a.dispose()
    b.dispose()
    a.host.remove()
    b.host.remove()
  })

  test("a heading anchor click scrolls the matching rendered heading", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "# Heading One\n\n[go](#heading-one)" })
    await flush()
    const anchor = host.querySelector("a[href='#heading-one']")
    expect(anchor).not.toBeNull()
    anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flush()
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0]?.textContent).toBe("Heading One")
    dispose()
    host.remove()
  })

  test("a local link loads the file and opens the resolver tab through the tab API", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "[other](nested/other.md)" })
    await flush()
    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flush()
    expect(file.loads).toEqual(["docs/nested/other.md"])
    expect(tabsApi.opened).toEqual(["file://docs/nested/other.md"])
    dispose()
    host.remove()
  })

  test("external and mailto links keep default anchor behavior", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: "[site](https://example.com/)\n\n[mail](mailto:a@b.c)",
    })
    await flush()
    for (const anchor of Array.from(host.querySelectorAll("a"))) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(file.loads).toEqual([])
    expect(tabsApi.opened).toEqual([])
    dispose()
    host.remove()
  })

  test("keyboard activation routes a local link like a click", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "[other](nested/other.md)" })
    await flush()
    const anchor = host.querySelector("a")!
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    await flush()
    expect(tabsApi.opened).toEqual(["file://docs/nested/other.md"])
    dispose()
    host.remove()
  })

  test("keyboard Enter never suppresses external or mailto navigation", async () => {
    const file = createFakeFile({})
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: "[site](https://example.com/)\n\n[mail](mailto:a@b.c)",
    })
    await flush()
    const anchors = Array.from(host.querySelectorAll("a"))
    expect(anchors).toHaveLength(2)
    for (const anchor of anchors) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(file.loads).toEqual([])
    expect(tabsApi.opened).toEqual([])
    dispose()
    host.remove()
  })

  test("heading ids stay stable across a text-only edit that keeps the image set", async () => {
    const file = createFakeFile({})
    const [source, setSource] = createSignal("# Hello World\n\n[go](#hello-world)")
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      get source() {
        return source()
      },
    })
    await flush()
    expect(host.querySelector("#user-content-hello-world")).not.toBeNull()

    setSource("Intro\n\n# Hello World\n\n[go](#hello-world)")
    await flush()
    expect(host.querySelector("#user-content-hello-world")).not.toBeNull()
    expect(host.querySelector("#user-content-hello-world-1")).toBeNull()

    host
      .querySelector("a[href='#hello-world']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flush()
    expect(scrolled.at(-1)?.textContent).toBe("Hello World")
    dispose()
    host.remove()
  })

  test("a local link emits a navigation request with workspace, tab, path and fragment", async () => {
    const file = createFakeFile({})
    const requests: FilePreviewNavigateRequest[] = []
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: "[go](nested/other.md#target-heading)",
      directory: "/work/repo",
      owner: "session-7",
      onRequestNavigate: (request) => requests.push(request),
    })
    await flush()
    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flush()
    expect(requests).toEqual([
      {
        directory: "/work/repo",
        owner: "session-7",
        path: "docs/nested/other.md",
        tab: "file://docs/nested/other.md",
        fragment: "target-heading",
      },
    ])
    expect(tabsApi.opened).toEqual([])
    dispose()
    host.remove()
  })

  test("parent harness: a cross-document anchor scrolls the newly opened tab after its first commit", async () => {
    const file = createFakeFile({})
    const { host, dispose, controls } = mountHost({
      file,
      documents: {
        "docs/a.md": "[go](nested/other.md#target-heading)",
        "docs/nested/other.md": "# Target Heading\n\nbody",
      },
    })
    await flushMicrotasks()
    expect(scrolled).toHaveLength(0)

    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()

    expect(controls.openTabs()).toEqual(["file://docs/a.md", "file://docs/nested/other.md"])
    expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
    dispose()
    host.remove()
  })

  test("parent harness: re-navigating an already mounted destination scrolls again without a remount", async () => {
    const file = createFakeFile({})
    const { host, dispose, controls } = mountHost({
      file,
      documents: {
        "docs/a.md": "[go](nested/other.md#target-heading)",
        "docs/nested/other.md": "# Target Heading\n\nbody",
      },
    })
    await flushMicrotasks()

    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()
    const first = scrolled.length
    expect(first).toBeGreaterThan(0)

    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()

    expect(scrolled.length).toBe(first + 1)
    expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
    expect(controls.openTabs()).toEqual(["file://docs/a.md", "file://docs/nested/other.md"])
    dispose()
    host.remove()
  })

  test("parent harness: closing a tab drops its anchor intent and reopening starts fresh", async () => {
    const file = createFakeFile({})
    const target = "file://docs/nested/other.md"
    const { host, dispose, controls } = mountHost({
      file,
      documents: {
        "docs/a.md": "[go](nested/other.md#target-heading)",
        "docs/nested/other.md": "# Target Heading\n\nbody",
      },
    })
    await flushMicrotasks()

    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()
    expect(controls.anchorRevision(target)).toBe(0)

    controls.closeTab(target)
    await flushMicrotasks()
    expect(controls.openTabs()).toEqual(["file://docs/a.md"])
    expect(controls.anchorRevision(target)).toBeUndefined()

    host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()
    expect(controls.openTabs()).toEqual(["file://docs/a.md", target])
    expect(controls.anchorRevision(target)).toBe(0)
    expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
    dispose()
    host.remove()
  })

  test("parent harness: a new workspace mount carries no anchor state from a prior mount", async () => {
    const file = createFakeFile({})
    const documents = {
      "docs/a.md": "[go](nested/other.md#target-heading)",
      "docs/nested/other.md": "# Target Heading\n\nbody",
    }
    const target = "file://docs/nested/other.md"

    const first = mountHost({ file, documents, directory: "dir-a", owner: "session-1" })
    await flushMicrotasks()
    first.host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()
    expect(first.controls.anchorRevision(target)).toBe(0)
    first.dispose()
    first.host.remove()
    scrolled.length = 0

    const second = mountHost({ file, documents, directory: "dir-b", owner: "session-2" })
    await flushMicrotasks()
    second.host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await flushMicrotasks()
    expect(second.controls.anchorRevision(target)).toBe(0)
    expect(scrolled.at(-1)?.textContent).toBe("Target Heading")
    second.dispose()
    second.host.remove()
  })

  test("headings are stable for identical text across workspace changes and rerenders", async () => {
    const file = createFakeFile({})
    const [directory, setDirectory] = createSignal("dir-a")
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: "# Hello World\n\n## Hello World",
      owner: "session-1",
      get directory() {
        return directory()
      },
    })
    await flush()
    const ids = () => Array.from(host.querySelectorAll("h1, h2")).map((heading) => heading.getAttribute("id"))
    expect(ids()).toEqual(["user-content-hello-world", "user-content-hello-world-1"])

    setDirectory("dir-b")
    await flush()
    expect(ids()).toEqual(["user-content-hello-world", "user-content-hello-world-1"])
    dispose()
    host.remove()
  })

  test("a delayed prior-scope transform never commits over the current scope", async () => {
    const pending = deferred()
    const file = createFakeFile(
      { "docs/slow.png": media("image/png", "U0xPVw=="), "docs/fast.png": media("image/png", "RkFTVA==") },
      (path) => (path === "docs/slow.png" ? pending.promise : Promise.resolve()),
    )
    const [directory, setDirectory] = createSignal("dir-a")
    const [source, setSource] = createSignal("![p](slow.png)")
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      owner: "session-1",
      get source() {
        return source()
      },
      get directory() {
        return directory()
      },
    })
    await flush()

    setDirectory("dir-b")
    setSource("![p](fast.png)")
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("RkFTVA")

    pending.resolve()
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("RkFTVA")
    dispose()
    host.remove()
  })

  test("blocked targets are inert: zero loads and zero tab opens", async () => {
    const file = createFakeFile({})
    const source = [
      "[escape](../../../../outside.png)",
      "[encoded](%2e%2e/secret.png)",
      '<a href="javascript:alert(1)">js</a>',
      '<a href="data:text/html,x">data</a>',
      '<a href="file:///etc/passwd">file</a>',
    ].join("\n\n")
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    expect(host.querySelector("a[href^='javascript']")).toBeNull()
    expect(host.querySelector("a[href^='file:']")).toBeNull()
    const anchors = Array.from(host.querySelectorAll("a"))
    for (const anchor of anchors) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
    }
    await flush()
    expect(file.loads).toEqual([])
    expect(tabsApi.opened).toEqual([])
    dispose()
    host.remove()
  })

  test("the watcher refresh changes the data URL while the markdown text is constant", async () => {
    const file = createFakeFile({ "docs/pic.png": media("image/png", "RklSU1Q=") })
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "![p](pic.png)" })
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,RklSU1Q=")

    file.set("docs/pic.png", media("image/png", "U0VDT05E"))
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,U0VDT05E")
    dispose()
    host.remove()
  })

  test("an unmount mid-transform commits nothing", async () => {
    const pending = deferred()
    const file = createFakeFile({}, () => pending.promise)
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source: "![p](pic.png)" })
    await flush()
    dispose()
    const afterDispose = host.innerHTML
    pending.resolve()
    await flush()
    expect(host.innerHTML).toBe(afterDispose)
    host.remove()
  })

  test("a stale source switch discards the old transform output", async () => {
    const pending = deferred()
    const file = createFakeFile({ "docs/fast.png": media("image/png", "RlJFU0g=") }, (path, loads) =>
      path === "docs/slow.png" ? pending.promise : Promise.resolve(loads && undefined),
    )
    const [source, setSource] = createSignal("![p](slow.png)")
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      get source() {
        return source()
      },
    })
    await flush()
    setSource("![p](fast.png)")
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,RlJFU0g=")
    pending.resolve()
    await flush()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,RlJFU0g=")
    dispose()
    host.remove()
  })

  test("inline SVG script payloads stay inert", async () => {
    const file = createFakeFile({ "docs/pic.png": media("image/png", "UElD") })
    const source =
      '![p](pic.png)\n\nInline <svg><script>window.__x=1</script><image href="https://evil.test/x.png"></image></svg> tail'
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("[href='https://evil.test/x.png']")).toBeNull()
    expect(host.querySelector("img")?.getAttribute("src")).toContain("data:image/png;base64,UElD")
    dispose()
    host.remove()
  })

  test("a transform failure surfaces a visible error and the source affordance", async () => {
    const file: FakeFile = {
      loads: [],
      dispose: () => {},
      load: () => Promise.resolve(),
      get: () => {
        throw new Error("read failed")
      },
      set: () => {},
    }
    const requested: number[] = []
    const { host, dispose } = mountPreview(file, {
      path: "docs/a.md",
      source: "![p](pic.png)",
      onRequestSource: () => requested.push(1),
    })
    await flush()
    const error = host.querySelector("[data-file-preview-error]")
    expect(error).not.toBeNull()
    const button = error!.querySelector("button")
    expect(button).not.toBeNull()
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    expect(requested).toHaveLength(1)
    dispose()
    host.remove()
  })

  test("a source over 5 MiB shows the localized explanation and no markdown", async () => {
    const file = createFakeFile({})
    const source = "x".repeat(5 * 1024 * 1024 + 1)
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    const banner = host.querySelector("[data-file-preview-too-large]")
    expect(banner?.textContent).toBe(translate("filePreview.tooLarge", { size: "5 MiB" }))
    expect(host.querySelector("[data-component='markdown']")).toBeNull()
    dispose()
    host.remove()
  })

  test("the source byte boundary is exactly 5 MiB", () => {
    const boundary = "x".repeat(MAX_PREVIEW_SOURCE_BYTES)
    expect(previewSourceBytes(boundary)).toBe(MAX_PREVIEW_SOURCE_BYTES)
    expect(isPreviewSourceTooLarge(boundary)).toBe(false)
    expect(isPreviewSourceTooLarge(boundary + "x")).toBe(true)
  })

  test("a source of exactly 5 MiB stays eligible for preview", async () => {
    const file = createFakeFile({})
    const source = "x".repeat(MAX_PREVIEW_SOURCE_BYTES)
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    expect(host.querySelector("[data-file-preview-too-large]")).toBeNull()
    expect(host.querySelector("[data-component='markdown']")).not.toBeNull()
    dispose()
    host.remove()
  })

  test("renders a representative preview snapshot artifact", async () => {
    const file = createFakeFile({ "docs/pic.png": media("image/png", "EHNlcCBwaWM=") })
    const source = [
      "---",
      "name: preview-fixture",
      "---",
      "",
      "# Heading One",
      "",
      "![pic](pic.png)",
      "",
      "[other](nested/other.md)",
      "",
    ].join("\n")
    const { host, dispose } = mountPreview(file, { path: "docs/a.md", source })
    await flush()
    const snapshot = process.env.FILE_PREVIEW_SNAPSHOT
    if (snapshot) await Bun.write(snapshot, host.innerHTML)
    expect(host.querySelector("img")).not.toBeNull()
    dispose()
    host.remove()
  })
})
