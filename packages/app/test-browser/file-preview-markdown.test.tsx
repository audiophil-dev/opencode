import { expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

// The app `test:browser` runner compiles workspace `.tsx` to the classic React runtime, so the real
// Solid `Markdown` component cannot be imported as-is. Reuse the Solid compiler already installed for
// this package (through its `vite-plugin-solid` devDependency) to transform the workspace sources the
// same way the vite build does. Test-only, no new dependency.
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

mock.module("@opencode-ai/ui/v2/icon", () => ({
  Icon: () => document.createElement("span"),
}))

mock.module("@opencode-ai/ui/v2/icon-button-v2", () => ({
  IconButtonV2: () => document.createElement("button"),
}))

mock.module("@opencode-ai/ui/v2/tooltip-v2", () => ({
  TooltipV2: (props: { children?: unknown }) => props.children,
}))

mock.module("../../session-ui/src/components/markdown-worker", () => ({
  parseMarkdown: async (text: string) => {
    if (text.includes("PARSE_FAIL")) throw new Error("parse failed")
    return text.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt: string, src: string) => `<img src="${src}" alt="${alt}">`,
    )
  },
  projectMarkdown: async (_key: string, text: string) => ({
    text,
    blocks: text.trimStart().startsWith("```")
      ? [{ raw: text, src: "const x = 1", mode: "code" as const, language: "ts", complete: true }]
      : [{ raw: text, src: text, mode: "full" as const }],
  }),
  highlightStreamingCode: async () => ({
    language: "ts",
    generation: 1,
    stable: [["const x = 1", ""] as [string, string]],
    unstable: [],
  }),
  disposeMarkdownProjection: () => {},
  disposeStreamingCode: () => {},
  MarkdownWorkerDisposedError: class extends Error {},
  MarkdownWorkerSupersededError: class extends Error {},
  MarkdownWorkerUnavailableError: class extends Error {},
}))

const { Markdown } = await import("@opencode-ai/session-ui/markdown")
const { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown } = await import(
  "@opencode-ai/session-ui/markdown-cache"
)

const SOURCE = "![pic](./pic.png)"

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mount(props: Record<string, unknown>) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const dispose = render(() => createComponent(Markdown, props as never), host)
  return { host, dispose }
}

function imageSrc(host: HTMLElement) {
  return host.querySelector("img")?.getAttribute("src") ?? null
}

function blockHash(host: HTMLElement) {
  return host.querySelector("[data-markdown-block]")?.getAttribute("data-markdown-hash") ?? null
}

const transformed = (value: string) => (html: string) => html.replace('src="./pic.png"', `src="${value}"`)

test("cold cache transforms the sanitized parse before insertion and never inserts the raw relative src", async () => {
  const key = "cold-cache"
  const pending = deferred<string>()
  const seen: string[] = []
  const { host, dispose } = mount({
    text: SOURCE,
    cacheKey: key,
    transformHtml: (html: string) => {
      seen.push(html)
      return pending.promise
    },
  })

  // While awaiting the transform the preview shows the inert escaped result, not a live <img>.
  expect(host.querySelector("img")).toBeNull()
  expect(host.querySelector("[data-markdown-block]")?.innerHTML ?? "").not.toContain("<img")

  await flush()
  expect(seen[0]).toContain('src="./pic.png"')

  pending.resolve('<img src="data:image/png;base64,AAAA" alt="pic">')
  await flush()

  expect(imageSrc(host)).toBe("data:image/png;base64,AAAA")
  expect(host.innerHTML).not.toContain('src="./pic.png"')
  expect(getCachedMarkdown(`${key}:0:full`)?.html).toContain('src="./pic.png"')
  dispose()
  host.remove()
})

test("warm cache still transforms before insertion and leaves the shared cache untransformed", async () => {
  const key = "warm-cache"
  touchCachedMarkdown(`${key}:0:full`, {
    raw: SOURCE,
    hash: "rawhash",
    html: '<img src="./pic.png" alt="pic">',
  })

  const { host, dispose } = mount({ text: SOURCE, cacheKey: key, transformHtml: transformed("data:warm") })

  // The cached raw relative-image HTML must never reach the DOM first.
  expect(host.querySelector("img")).toBeNull()
  expect(host.innerHTML).not.toContain("<img")

  await flush()
  expect(imageSrc(host)).toBe("data:warm")
  expect(getCachedMarkdown(`${key}:0:full`)?.html).toBe('<img src="./pic.png" alt="pic">')
  dispose()
  host.remove()
})

test("two instances with identical source but different transforms do not cross-contaminate", async () => {
  const key = "same-source"
  const first = mount({ text: SOURCE, cacheKey: key, transformHtml: transformed("data:first") })
  const second = mount({ text: SOURCE, cacheKey: key, transformHtml: transformed("data:second") })
  await flush()

  expect(imageSrc(first.host)).toBe("data:first")
  expect(imageSrc(second.host)).toBe("data:second")
  first.dispose()
  second.dispose()
  first.host.remove()
  second.host.remove()
})

test("out-of-order transform resolution never overwrites newer scoped content", async () => {
  const [text, setText] = createSignal("road A ![pic](./pic.png)")
  const stale = deferred<string>()
  const { host, dispose } = mount({
    get text() {
      return text()
    },
    cacheKey: "race",
    transformHtml: (html: string) =>
      html.includes("road A") ? stale.promise : Promise.resolve(transformed("data:fresh")(html)),
  })

  await flush()
  setText("road B ![pic](./pic.png)")
  await flush()
  expect(imageSrc(host)).toBe("data:fresh")

  stale.resolve('<img src="data:stale" alt="STALE">')
  await flush()

  expect(imageSrc(host)).toBe("data:fresh")
  expect(host.innerHTML).not.toContain("STALE")
  dispose()
  host.remove()
})

test("a rejected transform surfaces an observable error and commits no html", async () => {
  const { host, dispose } = mount({
    text: SOURCE,
    cacheKey: "rejected",
    transformHtml: () => Promise.reject(new Error("transform failed")),
  })
  await flush()

  expect(host.querySelector('[data-component="markdown"]')?.getAttribute("data-markdown-error")).toBe("true")
  expect(host.querySelector("img")).toBeNull()
  expect(host.innerHTML).not.toContain('src="./pic.png"')
  dispose()
  host.remove()
})

test("malicious transform output is sanitized again before it is inserted", async () => {
  const hostile =
    '<p>ok</p><script>window.__x = 1</script><style>body{display:none}</style><img src="./pic.png" alt="pic">'
  const { host, dispose } = mount({ text: SOURCE, cacheKey: "malicious", transformHtml: () => hostile })
  await flush()

  const inserted = host.querySelector("[data-markdown-block]")?.innerHTML ?? ""
  expect(inserted).toBe(sanitizeMarkdown(hostile))
  expect(inserted).not.toBe(hostile)
  expect(inserted).not.toContain("window.__x")
  expect(host.querySelector("script")).toBeNull()
  expect(host.querySelector("img")?.getAttribute("src")).toBe("./pic.png")
  dispose()
  host.remove()
})

test("an unmounted instance commits nothing when its transform resolves late", async () => {
  const pending = deferred<string>()
  const { host, dispose } = mount({ text: SOURCE, cacheKey: "unmount", transformHtml: () => pending.promise })
  await flush()

  dispose()
  const afterDispose = host.innerHTML
  pending.resolve('<img src="data:late" alt="">')
  await flush()

  expect(host.innerHTML).toBe(afterDispose)
  expect(host.querySelector('img[src="data:late"]')).toBeNull()
  host.remove()
})

test("identical raw markdown with changed transform output still updates the rendered block", async () => {
  const [transform, setTransform] = createSignal(transformed("data:one"))
  const { host, dispose } = mount({
    get text() {
      return SOURCE
    },
    cacheKey: "hash",
    get transformHtml() {
      return transform()
    },
  })
  await flush()

  expect(imageSrc(host)).toBe("data:one")
  const firstHash = blockHash(host)

  setTransform(() => transformed("data:two"))
  await flush()

  expect(imageSrc(host)).toBe("data:two")
  expect(blockHash(host)).not.toBe(firstHash)
  dispose()
  host.remove()
})

test("a parse failure still transforms the inert escaped fallback without an error state", async () => {
  const seen: string[] = []
  const { host, dispose } = mount({
    text: "PARSE_FAIL ![pic](./pic.png)",
    cacheKey: "fallback",
    transformHtml: (html: string) => {
      seen.push(html)
      return html.replace("![pic](./pic.png)", "FALLBACK-TRANSFORMED")
    },
  })
  await flush()

  expect(seen[0]).not.toContain("<img")
  expect(host.innerHTML).toContain("FALLBACK-TRANSFORMED")
  expect(host.querySelector('[data-component="markdown"]')?.getAttribute("data-markdown-error")).toBeNull()
  dispose()
  host.remove()
})

test("callers without transformHtml keep today's rendering, including streaming copy buttons", async () => {
  const plain = mount({ text: SOURCE, cacheKey: "no-option" })
  await flush()
  expect(imageSrc(plain.host)).toBe("./pic.png")
  plain.dispose()
  plain.host.remove()

  const code = mount({ text: "```ts\nconst x = 1\n```", cacheKey: "no-option-code", streaming: true })
  await flush()
  await flush()
  expect(code.host.querySelector('[data-component="markdown-code"] [data-slot="markdown-copy-button"]')).not.toBeNull()
  code.dispose()
  code.host.remove()
})

test("the opt-in onRendered callback fires after insertion and is not forwarded to the DOM", async () => {
  const seen: number[] = []
  const { host, dispose } = mount({
    text: SOURCE,
    cacheKey: "on-rendered",
    onRendered: () => seen.push(document.querySelector('[data-component="markdown"] img') ? 1 : 0),
  })
  await flush()

  expect(seen.length).toBeGreaterThan(0)
  expect(seen.at(-1)).toBe(1)
  expect(imageSrc(host)).toBe("./pic.png")
  const root = host.querySelector('[data-component="markdown"]')
  expect(root?.hasAttribute("onrendered")).toBe(false)
  expect(root?.hasAttribute("onRendered")).toBe(false)
  dispose()
  host.remove()
})
