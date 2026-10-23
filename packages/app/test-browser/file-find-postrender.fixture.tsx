// Real-component fixture for file-find-postrender.test.ts. Bundled at test time from
// source; never imported by the Bun test process. Mounts the actual session-ui File
// component (real pierre renderer + real createFileFind) and exposes only public
// behavior: the caller onPostRender hook (FileOptions) forwards the actual instance.
import { render } from "solid-js/web"
import { File } from "../../session-ui/src/components/file"

const MODE = new URLSearchParams(location.search).get("mode") === "diff" ? "diff" : "text"
const TEXT = "const answer = 42\nexport function main() {\n  return answer + 1\n}\n"
const BEFORE = "const answer = 1\nexport const extra = 2\n"
const AFTER = "const answer = 2\nexport const extra = 2\n"

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

const phases: string[] = []
const scroll = { calls: 0 }
const scrollIntoView = Element.prototype.scrollIntoView
Element.prototype.scrollIntoView = function (...args: unknown[]) {
  scroll.calls += 1
  return (scrollIntoView as (...a: unknown[]) => void).apply(this, args)
}

let instance: { rerender: () => void } | undefined
let handle: { focus: () => void } | undefined

function hits(name: string): Range[] {
  const api = (globalThis as { CSS?: { highlights?: { get: (k: string) => unknown } } }).CSS?.highlights
  const value = api?.get(name)
  if (!value || typeof (value as Iterable<Range>)[Symbol.iterator] !== "function") return []
  return Array.from(value as Iterable<Range>)
}

function barText() {
  const input = Array.from(document.querySelectorAll("input")).find((el) => el.parentElement)
  return input?.parentElement?.querySelector(".tabular-nums")?.textContent ?? null
}

function snapshot(): Snapshot {
  const current = hits("opencode-find-current")
  const all = hits("opencode-find")
  const root = document.querySelector("diffs-container")?.shadowRoot
  return {
    bar: barText(),
    query: (document.querySelector("input") as HTMLInputElement | null)?.value ?? null,
    currentText: current.map((range) => range.toString()),
    currentCollapsed: current.map((range) => range.collapsed),
    currentCount: current.length,
    allCount: all.length,
    phases: [...phases],
    scrollCalls: scroll.calls,
    lines: root?.querySelectorAll("[data-line]").length ?? -1,
  }
}

function captureAndRerender() {
  const root = document.querySelector("diffs-container")?.shadowRoot
  const walker = root ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : undefined
  const nodes: { text: string; node: Text }[] = []
  let node = walker?.nextNode()
  while (node) {
    if (node instanceof Text && node.data.includes("answer")) nodes.push({ text: node.data, node })
    node = walker?.nextNode()
  }
  scroll.calls = 0
  instance?.rerender()
  return {
    after: snapshot(),
    old: nodes.map((entry) => ({ text: entry.text, connected: entry.node.isConnected })),
  }
}

const host = document.createElement("div")
document.body.appendChild(host)
render(
  () =>
    MODE === "diff" ? (
      <File
        mode="diff"
        virtualize={false}
        before={{ name: "sample.ts", contents: BEFORE, lang: "ts" }}
        after={{ name: "sample.ts", contents: AFTER, lang: "ts" }}
        search={{ register: (next) => (handle = next ?? undefined) }}
        onPostRender={(_node, next, phase) => {
          instance = next
          phases.push(phase)
        }}
      />
    ) : (
      <File
        mode="text"
        file={{ name: "sample.ts", contents: TEXT, lang: "ts" }}
        search={{ register: (next) => (handle = next ?? undefined) }}
        onPostRender={(_node, next, phase) => {
          instance = next
          phases.push(phase)
        }}
      />
    ),
  host,
)
;(window as unknown as { __fileFindPostRender: unknown }).__fileFindPostRender = {
  mode: MODE,
  focus: () => handle?.focus(),
  snapshot,
  captureAndRerender,
}
