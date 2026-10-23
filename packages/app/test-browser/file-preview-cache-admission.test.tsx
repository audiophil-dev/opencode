import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { FileContent } from "@opencode-ai/sdk/v2"
import {
  MAX_FILE_CONTENT_BYTES,
  approxBytes,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  resetFileContentLru,
} from "../src/context/file/content-cache"
import { rewritePreviewResources } from "../src/pages/session/file-preview-resources"

// Solid JSX transform for the provider's context helper. Test-only, mirrors the
// existing file-preview.test.tsx setup and changes no shared configuration.
const appRequire = createRequire(import.meta.url)
const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
const babel = solidRequire("@babel/core")
const presetSolid = solidRequire("babel-preset-solid")
const presetTypeScript = solidRequire("@babel/preset-typescript")

plugin({
  name: "file-preview-cache-admission-solid-jsx",
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

type Read = { directory: string; path: string }
type WatcherListener = (event: { name: string; details: unknown }) => void

type SdkState = {
  records: Map<string, FileContent>
  reads: Read[]
  listener?: WatcherListener
  gate?: { path: string; ready: Promise<void> }
}

let sdkState: SdkState
const [directory, setDirectory] = createSignal("dir-a")

const sdk = () => ({
  directory: directory(),
  client: {
    file: {
      read: async ({ path }: { path: string }) => {
        sdkState.reads.push({ directory: directory(), path })
        const data = sdkState.records.get(path)
        const gate = sdkState.gate
        if (gate?.path === path) {
          sdkState.gate = undefined
          await gate.ready
        }
        return { data }
      },
      list: async () => ({ data: [] }),
    },
  },
  event: {
    listen: (listener: WatcherListener) => {
      sdkState.listener = listener
      return () => {}
    },
  },
})

mock.module("@/context/sdk", () => ({ useSDK: () => sdk }))
mock.module("@/context/sync", () => ({ useSync: () => undefined }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/layout", () => ({ useLayout: () => ({ tabs: () => ({ all: () => [] }) }) }))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ scope: "test", api: { file: { find: async () => ({ data: [] }) } } }),
}))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))
mock.module("@solidjs/router", () => ({ useParams: () => ({}) }))

// The query keeps this import off the module key that sibling test files mock.
const { FileProvider, useFile } = await import("../src/context/file.tsx?cache-admission")

type FileApi = {
  load: (path: string, options?: { force?: boolean; budget?: number }) => Promise<void>
  get: (
    path: string,
  ) =>
    | { loaded?: boolean; content?: FileContent; admission?: { budget: number; bytes: number; rejected: boolean } }
    | undefined
}

let api: FileApi

function Probe() {
  api = useFile() as unknown as FileApi
  return null
}

function mount() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(
    () =>
      createComponent(FileProvider, {
        get children() {
          return createComponent(Probe, {})
        },
      }),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}

const DOC = "docs/huge.md"
const IMAGE = "docs/images/huge.png"
const DOC_SOURCE = "# Oversized\n\n![huge](images/huge.png)\n\nBody stays."
const HTML = '<h1>Oversized</h1><p><img src="images/huge.png" alt="huge"></p><p>Body stays.</p>'

// The evidence fixture's 16 MiB payload, base64-encoded: well-formed, over the
// preview's data-URL budget, and over the provider's UTF-16 cache footprint.
const OVERSIZED_BASE64 = "A".repeat(22_369_624)

function text(content: string): FileContent {
  return { type: "text", content }
}

function image(content: string): FileContent {
  return { type: "binary", content, encoding: "base64", mimeType: "image/png" }
}

function reads(path: string, scope = "dir-a") {
  return sdkState.reads.filter((read) => read.directory === scope && read.path === path).length
}

function preview(file: FileApi, budget?: number) {
  return rewritePreviewResources(HTML, {
    documentPath: DOC,
    file: { load: file.load, get: file.get },
    unavailableLabel: "Image unavailable",
    ...(budget === undefined ? {} : { budget }),
  })
}

function watcherChange(path: string) {
  sdkState.listener?.({
    name: directory(),
    details: { type: "file.watcher.updated", properties: { file: path, event: "change" } },
  })
}

async function flush() {
  for (let round = 0; round < 8; round += 1) {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  setDirectory("dir-a")
  sdkState = { records: new Map(), reads: [] }
  resetFileContentLru()
})

afterEach(() => {
  resetFileContentLru()
  document.body.innerHTML = ""
})

afterAll(() => {
  mock.restore()
})

describe("preview resource cache admission", () => {
  test("an oversized image becomes one explicit placeholder without evicting or re-reading the document", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    const dispose = mount()

    // The document tab stays open: its consumer reloads only when the provider dropped it.
    await api.load(DOC)
    let result: Awaited<ReturnType<typeof preview>> | undefined
    for (let round = 0; round < 4; round += 1) {
      await api.load(DOC)
      result = await preview(api)
    }

    expect(reads(DOC)).toBe(1)
    expect(reads(IMAGE)).toBe(1)
    expect(result?.html).toContain('data-file-preview-resource="unavailable"')
    expect(result?.html).toContain('aria-label="huge"')
    expect(result?.html).toContain("<p>Body stays.</p>")
    expect(result?.html).not.toContain("<img")
    expect(api.get(DOC)?.content?.content).toBe(DOC_SOURCE)
    expect(getFileContentBytesTotal()).toBeLessThanOrEqual(MAX_FILE_CONTENT_BYTES)

    dispose()
  })

  test("the injected aggregate budget still caps local images without unbounded reads", async () => {
    const a = "docs/images/a.png"
    const b = "docs/images/b.png"
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(a, image("AAAAAAAA"))
    sdkState.records.set(b, image("BBBBBBBB"))
    const dispose = mount()
    await api.load(DOC)

    const result = await rewritePreviewResources('<img src="images/a.png"><img src="images/b.png">', {
      documentPath: DOC,
      file: { load: api.load, get: api.get },
      unavailableLabel: "Image unavailable",
      budget: 90,
    })

    expect(result.html).toContain('src="data:image/png;base64,AAAAAAAA"')
    expect(result.html).toContain('data-file-preview-resource="unavailable"')
    expect(reads(a)).toBe(1)
    expect(reads(b)).toBe(1)

    dispose()
  })

  test("a cached image is reused without another read", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)
    await api.load(IMAGE)

    const result = await preview(api)
    expect(result.html).toContain("data:image/png;base64,QUJD")
    expect(reads(IMAGE)).toBe(1)

    await api.load(IMAGE, { force: true })
    expect(reads(IMAGE)).toBe(2)

    dispose()
  })

  test("the default unbounded load still publishes a large image", async () => {
    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    const dispose = mount()

    await api.load(IMAGE)

    expect(reads(IMAGE)).toBe(1)
    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe(OVERSIZED_BASE64)
    expect(api.get(IMAGE)?.admission).toBeUndefined()

    dispose()
  })

  test("a bounded load first does not poison a later default load", async () => {
    sdkState.records.set(IMAGE, image("QUJD"))
    const dispose = mount()

    const bounded = api.load(IMAGE, { budget: 0 })
    const unbounded = api.load(IMAGE)
    await Promise.all([bounded, unbounded])

    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe("QUJD")
    expect(reads(IMAGE)).toBe(2)

    dispose()
  })

  test("two bounded loads of the same path share one read", async () => {
    sdkState.records.set(IMAGE, image("QUJD"))
    let release!: () => void
    sdkState.gate = { path: IMAGE, ready: new Promise<void>((resolve) => (release = resolve)) }
    const dispose = mount()

    const first = api.load(IMAGE, { budget: 1000 })
    const second = api.load(IMAGE, { budget: 1000 })
    release()
    await Promise.all([first, second])

    expect(api.get(IMAGE)?.content?.content).toBe("QUJD")
    expect(reads(IMAGE)).toBe(1)

    dispose()
  })

  test("a bounded rejection does not wipe fresh content from a concurrent default load", async () => {
    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    let release!: () => void
    sdkState.gate = { path: IMAGE, ready: new Promise<void>((resolve) => (release = resolve)) }
    const dispose = mount()

    const bounded = api.load(IMAGE, { budget: 1 })
    const unbounded = api.load(IMAGE)
    await unbounded
    release()
    await bounded

    expect(reads(IMAGE)).toBe(2)
    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe(OVERSIZED_BASE64)
    expect(api.get(IMAGE)?.admission).toBeUndefined()

    dispose()
  })

  test("a default load first is not starved by a bounded load joining it", async () => {
    sdkState.records.set(IMAGE, image("QUJD"))
    let release!: () => void
    sdkState.gate = { path: IMAGE, ready: new Promise<void>((resolve) => (release = resolve)) }
    const dispose = mount()

    const first = api.load(IMAGE)
    const second = api.load(IMAGE, { budget: 1 })
    release()
    await Promise.all([first, second])

    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe("QUJD")
    expect(reads(IMAGE)).toBe(1)

    dispose()
  })

  test("watcher invalidation retries a rejected image and admits new smaller content", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    const dispose = mount()
    await api.load(DOC)
    const rejected = await preview(api)
    expect(rejected.html).toContain('data-file-preview-resource="unavailable"')
    expect(reads(IMAGE)).toBe(1)

    sdkState.records.set(IMAGE, image("QUJD"))
    watcherChange(IMAGE)
    await flush()

    expect(reads(IMAGE)).toBe(2)
    expect(api.get(IMAGE)?.content?.content).toBe("QUJD")
    expect(api.get(IMAGE)?.admission?.rejected).toBe(false)
    expect(api.get(DOC)?.content?.content).toBe(DOC_SOURCE)

    const retried = await preview(api)
    expect(retried.html).toContain("data:image/png;base64,QUJD")

    dispose()
  })

  test("a rejected image is retried when a later preview budget fits its footprint", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)

    const rejected = await preview(api, 1)
    expect(rejected.html).toContain('data-file-preview-resource="unavailable"')
    expect(reads(IMAGE)).toBe(1)

    const recovered = await preview(api, 1000)
    expect(reads(IMAGE)).toBe(2)
    expect(recovered.html).toContain("data:image/png;base64,QUJD")
    expect(api.get(IMAGE)?.content?.content).toBe("QUJD")

    dispose()
  })

  test("a capacity-rejected image is retried after a default load frees cache space", async () => {
    const ballast = "docs/ballast.txt"
    const evict = "docs/evict.txt"
    sdkState.records.set(ballast, text("B".repeat(10_485_750)))
    sdkState.records.set(DOC, text("# doc\n"))
    sdkState.records.set(IMAGE, image("AAAAAAA"))
    const dispose = mount()

    await api.load(ballast)
    await api.load(DOC)
    expect(api.get(DOC)?.content?.content).toBe("# doc\n")

    const rejected = await preview(api)
    expect(rejected.html).toContain('data-file-preview-resource="unavailable"')
    expect(reads(IMAGE)).toBe(1)

    sdkState.records.set(evict, text("C".repeat(100)))
    await api.load(evict)
    expect(api.get(DOC)?.content?.content).toBe("# doc\n")

    const recovered = await preview(api)
    expect(reads(IMAGE)).toBe(2)
    expect(recovered.html).toContain("data:image/png;base64,AAAAAAA")

    dispose()
  })

  test("a successful bounded image that grows past the cap on watcher becomes a placeholder", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)

    const first = await preview(api)
    expect(first.html).toContain("data:image/png;base64,QUJD")
    expect(reads(IMAGE)).toBe(1)

    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    watcherChange(IMAGE)
    await flush()

    expect(reads(IMAGE)).toBe(2)
    expect(api.get(IMAGE)?.content).toBeUndefined()
    expect(api.get(IMAGE)?.loaded).toBe(false)
    expect(api.get(DOC)?.content?.content).toBe(DOC_SOURCE)
    expect(api.get(DOC)?.loaded).toBe(true)
    expect(getFileContentBytesTotal()).toBe(approxBytes(text(DOC_SOURCE)))

    let result: Awaited<ReturnType<typeof preview>> | undefined
    for (let round = 0; round < 4; round += 1) {
      await api.load(DOC)
      result = await preview(api)
    }

    expect(reads(IMAGE)).toBe(2)
    expect(reads(DOC)).toBe(1)
    expect(result?.html).toContain('data-file-preview-resource="unavailable"')
    expect(result?.html).toContain("<p>Body stays.</p>")
    expect(getFileContentBytesTotal()).toBe(approxBytes(text(DOC_SOURCE)))

    dispose()
  })

  test("a default load of a cached bounded image clears the bounded watcher policy without a read", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)

    const first = await preview(api)
    expect(first.html).toContain("data:image/png;base64,QUJD")
    expect(reads(IMAGE)).toBe(1)
    expect(api.get(IMAGE)?.admission?.rejected).toBe(false)

    await api.load(IMAGE)
    expect(reads(IMAGE)).toBe(1)
    expect(api.get(IMAGE)?.admission).toBeUndefined()

    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    watcherChange(IMAGE)
    await flush()

    expect(reads(IMAGE)).toBe(2)
    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe(OVERSIZED_BASE64)
    expect(api.get(IMAGE)?.admission).toBeUndefined()

    dispose()
  })

  test("an older bounded read finishing after a newer default publish does not overwrite it", async () => {
    sdkState.records.set(IMAGE, image("QUJD"))
    let release!: () => void
    sdkState.gate = { path: IMAGE, ready: new Promise<void>((resolve) => (release = resolve)) }
    const dispose = mount()

    const bounded = api.load(IMAGE, { budget: 1000 })
    sdkState.records.set(IMAGE, image("NEW1"))
    const unbounded = api.load(IMAGE)
    await unbounded
    release()
    await bounded

    expect(reads(IMAGE)).toBe(2)
    expect(api.get(IMAGE)?.loaded).toBe(true)
    expect(api.get(IMAGE)?.content?.content).toBe("NEW1")
    expect(api.get(IMAGE)?.admission).toBeUndefined()

    dispose()
  })

  test("the entry cap admits 39 of 40 tiny images and never evicts the document", async () => {
    const html = Array.from({ length: 40 }, (_, index) => `<img src="images/p${index}.png" alt="p${index}">`).join("")
    sdkState.records.set(DOC, text(DOC_SOURCE))
    for (let index = 0; index < 40; index += 1) sdkState.records.set(`docs/images/p${index}.png`, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)

    let result: Awaited<ReturnType<typeof rewritePreviewResources>> | undefined
    for (let round = 0; round < 4; round += 1) {
      await api.load(DOC)
      result = await rewritePreviewResources(html, {
        documentPath: DOC,
        file: { load: api.load, get: api.get },
        unavailableLabel: "Image unavailable",
      })
    }

    expect(reads(DOC)).toBe(1)
    for (let index = 0; index < 40; index += 1) expect(reads(`docs/images/p${index}.png`)).toBeLessThanOrEqual(1)
    expect(api.get(DOC)?.content?.content).toBe(DOC_SOURCE)
    expect(getFileContentEntryCount()).toBeLessThanOrEqual(40)
    expect(result?.html.match(/data:image\/png;base64,QUJD/g)).toHaveLength(39)
    expect(result?.html).toContain('data-file-preview-resource="unavailable"')
    expect(result?.html).toContain('aria-label="p39"')

    dispose()
  })

  test("a bounded force reload of a cached path replaces it at a full entry count", async () => {
    const html = Array.from({ length: 39 }, (_, index) => `<img src="images/p${index}.png">`).join("")
    sdkState.records.set(DOC, text(DOC_SOURCE))
    for (let index = 0; index < 39; index += 1) sdkState.records.set(`docs/images/p${index}.png`, image("QUJD"))
    const dispose = mount()
    await api.load(DOC)
    await rewritePreviewResources(html, {
      documentPath: DOC,
      file: { load: api.load, get: api.get },
      unavailableLabel: "Image unavailable",
    })
    expect(getFileContentEntryCount()).toBe(40)

    await api.load("docs/images/p0.png", { force: true, budget: MAX_FILE_CONTENT_BYTES })

    expect(reads("docs/images/p0.png")).toBe(2)
    expect(api.get("docs/images/p0.png")?.content?.content).toBe("QUJD")
    expect(api.get("docs/images/p0.png")?.admission?.rejected).toBe(false)
    expect(getFileContentEntryCount()).toBe(40)

    dispose()
  })

  test("an entry-cap rejected image recovers after native eviction frees slots", async () => {
    const html = Array.from({ length: 5 }, (_, index) => `<img src="images/p${index}.png">`).join("")
    sdkState.records.set(DOC, text(DOC_SOURCE))
    for (let index = 0; index < 5; index += 1) sdkState.records.set(`docs/images/p${index}.png`, image("QUJD"))
    const dispose = mount()

    // Native default loads fill the remaining entry slots with unrelated files.
    for (let index = 0; index < 36; index += 1) {
      sdkState.records.set(`docs/f${index}.txt`, text("F".repeat(8)))
      await api.load(`docs/f${index}.txt`)
    }
    await api.load(DOC)

    const first = await rewritePreviewResources(html, {
      documentPath: DOC,
      file: { load: api.load, get: api.get },
      unavailableLabel: "Image unavailable",
    })
    expect(first.html.match(/data:image\/png;base64,QUJD/g)).toHaveLength(3)
    expect(first.html).toContain('data-file-preview-resource="unavailable"')
    expect(getFileContentEntryCount()).toBe(40)
    expect(reads("docs/images/p3.png")).toBe(1)
    expect(reads("docs/images/p4.png")).toBe(1)

    // One oversized default load over the byte cap makes the native LRU evict
    // many entries at once, freeing entry slots for the rejected images.
    sdkState.records.set("docs/huge.bin", text("H".repeat(11_000_000)))
    await api.load("docs/huge.bin")
    expect(getFileContentEntryCount()).toBeLessThan(40)

    await api.load(DOC)
    const recovered = await rewritePreviewResources(html, {
      documentPath: DOC,
      file: { load: api.load, get: api.get },
      unavailableLabel: "Image unavailable",
    })

    expect(recovered.html.match(/data:image\/png;base64,QUJD/g)).toHaveLength(5)
    expect(reads("docs/images/p3.png")).toBe(2)
    expect(api.get("docs/images/p3.png")?.admission?.rejected).toBe(false)
    expect(api.get(DOC)?.content?.content).toBe(DOC_SOURCE)

    dispose()
  })

  test("a scope change clears the rejected admission and retries in the new scope", async () => {
    sdkState.records.set(DOC, text(DOC_SOURCE))
    sdkState.records.set(IMAGE, image(OVERSIZED_BASE64))
    const dispose = mount()
    await api.load(DOC)
    await preview(api)
    expect(reads(IMAGE)).toBe(1)

    setDirectory("dir-b")
    await flush()

    expect(api.get(DOC)).toBeUndefined()
    expect(getFileContentBytesTotal()).toBe(0)
    expect(reads(DOC, "dir-b")).toBe(0)
    expect(reads(IMAGE, "dir-b")).toBe(0)

    await api.load(DOC)
    await preview(api)
    expect(reads(DOC, "dir-b")).toBe(1)
    expect(reads(IMAGE, "dir-b")).toBe(1)

    dispose()
  })
})
