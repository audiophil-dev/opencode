// Regression tests for the FileSearchBar portal placement and the presentation-only
// visibility gate. Run from packages/app:
// `bun test --conditions=browser --preload ./happydom.ts test-browser/file-search-bar-portal.test.ts`.
import { afterEach, expect, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

// The app `test:unit` runner compiles workspace `.tsx` to the React runtime, so the real
// Solid `FileSearchBar` cannot be imported as-is. Reuse the Solid compiler already
// installed for this package the same way test-browser/file-preview.test.tsx does.
// Test-only, no new dependency and no shared config change.
const appRequire = createRequire(import.meta.url)
const solidRequire = createRequire(appRequire.resolve("vite-plugin-solid"))
const babel = solidRequire("@babel/core")
const presetSolid = solidRequire("babel-preset-solid")
const presetTypeScript = solidRequire("@babel/preset-typescript")

plugin({
  name: "file-search-bar-solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      if (args.path.includes("node_modules/.bun")) return
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

// Imported after the plugin registers so the workspace .tsx compiles through Solid.
const { FileSearchBar } = await import("@opencode-ai/session-ui/file-search")

const mounts: Array<() => void> = []

afterEach(() => {
  for (const dispose of mounts.splice(0)) dispose()
})

function mountBar(overrides?: { visible?: () => boolean }) {
  const mount = document.createElement("div")
  document.body.appendChild(mount)
  let input: HTMLInputElement | undefined
  const props: Record<string, unknown> = {
    pos: () => ({ top: 10, right: 20 }),
    query: () => "answer",
    index: () => 0,
    count: () => 1,
    setInput: (el: HTMLInputElement) => {
      input = el
    },
    onInput: () => {},
    onKeyDown: () => {},
    onClose: () => {},
    onPrev: () => {},
    onNext: () => {},
  }
  if (overrides?.visible) props["visible"] = overrides.visible
  const dispose = render(() => createComponent(FileSearchBar, props as never), mount)
  mounts.push(() => {
    dispose()
    mount.remove()
  })
  return {
    mount,
    input: () => input!,
    bar: () => input!.parentElement!,
  }
}

test("the bar renders through the portal into document.body, not the mount point", () => {
  const view = mountBar()
  expect(document.body.contains(view.input())).toBe(true)
  expect(view.mount.contains(view.input())).toBe(false)
  expect(view.input().closest('[data-component="file"]')).toBeNull()
})

test("without a visible option the bar is shown (backward-compatible default)", () => {
  const view = mountBar()
  expect(view.bar().style.display).not.toBe("none")
})

test("the visible gate is reactive, hides only the bar, and preserves the mounted input", () => {
  const [visible, setVisible] = createSignal(true)
  const view = mountBar({ visible })
  expect(view.bar().style.display).not.toBe("none")
  expect(view.input().value).toBe("answer")

  setVisible(false)
  expect(view.bar().style.display).toBe("none")
  expect(document.body.contains(view.input())).toBe(true)

  setVisible(true)
  expect(view.bar().style.display).not.toBe("none")
  expect(view.input().value).toBe("answer")
})
