import { Markdown } from "@opencode-ai/session-ui/markdown"
import {
  createComponent,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { prepareFilePreview } from "./file-preview-frontmatter"
import { resolveFilePreviewTarget } from "./file-preview-path"
import { rewritePreviewResources } from "./file-preview-resources"

declare global {
  interface ImportMetaEnv {
    readonly VITE_FILE_PREVIEW_BUILD_ID?: string
  }
}

export const MAX_PREVIEW_SOURCE_BYTES = 5 * 1024 * 1024

const buildId = import.meta.env.VITE_FILE_PREVIEW_BUILD_ID ?? "dev"

export function previewSourceBytes(source: string) {
  return new TextEncoder().encode(source).length
}

export function isPreviewSourceTooLarge(source: string) {
  return previewSourceBytes(source) > MAX_PREVIEW_SOURCE_BYTES
}

// Navigation intent emitted to the owning integration. The parent owns per-open-tab
// state and performs the file load and tab open; this component stores no cross-tab
// state, so nothing leaks across tabs, scopes or unmounts.
export type FilePreviewNavigateRequest = {
  directory: string
  owner: string
  path: string
  tab: string
  fragment?: string
}

// Anchor request the parent delivers back to the preview that owns `path`. `revision`
// makes an identical repeated request observable, so re-navigating an already mounted
// destination re-runs instead of being deduplicated away.
export type FilePreviewAnchorRequest = {
  path: string
  fragment: string
  revision: number
}

export type FilePreviewProps = {
  path: string
  source: string
  directory?: string
  owner?: string
  anchor?: FilePreviewAnchorRequest | null
  initialScroll?: { x: number; y: number } | null
  onScrollChange?: (pos: { x: number; y: number }) => void
  onRequestNavigate?: (request: FilePreviewNavigateRequest) => void
  onRequestSource?: () => void
  class?: string
  classList?: Record<string, boolean>
}

// Renders prepared markdown with workspace-local images resolved to instance-owned
// data URLs. Document links emit a navigation request to the owning integration; only
// when no integration is wired do they fall back to the existing file/tab APIs.
export function FilePreview(props: FilePreviewProps) {
  const file = useFile()
  const language = useLanguage()
  const { tabs } = useSessionLayout()

  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [discovered, setDiscovered] = createSignal<string[]>([], { equals: samePaths })
  const [revision, setRevision] = createSignal(0)
  const [error, setError] = createSignal(false)
  const [consumedAnchor, setConsumedAnchor] = createSignal<number | undefined>(undefined)
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  // Tracking every referenced image keeps the rendered data URLs fresh when the
  // file watcher reloads a referenced file even though the Markdown text is constant.
  createComputed(() => {
    for (const path of discovered()) file.get(path)
    setRevision((value) => value + 1)
  })

  const isCurrent = (path: string, source: string, directory: string, owner: string) =>
    !disposed &&
    props.path === path &&
    props.source === source &&
    (props.directory ?? "") === directory &&
    (props.owner ?? "") === owner

  const scrollToAnchor = (fragment: string) => {
    const container = root()
    if (!container || !fragment) return false
    const decoded = decodeFragment(fragment)
    const match = Array.from(container.querySelectorAll("[id]")).find((element) => {
      const id = element.getAttribute("id")
      return id === decoded || id === `user-content-${decoded}`
    })
    if (!match) return false
    match.scrollIntoView()
    return true
  }

  const pendingAnchor = () => {
    const anchor = props.anchor
    if (!anchor) return
    if (anchor.path !== props.path) return
    if (anchor.revision === consumedAnchor()) return
    return anchor
  }

  // Consume only once the heading is actually in the committed DOM: a reactive anchor
  // request lets an already mounted destination re-run, and the Markdown commit
  // callback covers a destination whose first render is still pending. No timers.
  const consumeAnchor = () => {
    const anchor = pendingAnchor()
    if (!anchor) return
    if (!scrollToAnchor(anchor.fragment)) return
    setConsumedAnchor(anchor.revision)
  }

  createEffect(consumeAnchor)

  // Preview scroll restore runs once per mount, after the first Markdown commit gives
  // the container height; later re-renders (image watcher) must not clobber the live
  // position. The restore itself reports through onScrollChange like a user scroll.
  let scrollApplied = false
  const applyInitialScroll = () => {
    if (scrollApplied) return
    scrollApplied = true
    const el = root()
    const pos = props.initialScroll
    if (!el || !pos) return
    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    if (el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const handleScroll = () => {
    const el = root()
    if (!el) return
    props.onScrollChange?.({ x: el.scrollLeft, y: el.scrollTop })
  }

  const runTransform = async (html: string, path: string, source: string, directory: string, owner: string) => {
    const rewrite = await rewritePreviewResources(html, {
      documentPath: path,
      file: { load: file.load, get: file.get },
      unavailableLabel: language.t("filePreview.resource.unavailable"),
      headingRegistry: new Map(),
    })

    if (isCurrent(path, source, directory, owner)) {
      setDiscovered(rewrite.references)
      setError(false)
    }
    return rewrite.html
  }

  const captureTransform = () => {
    // Reading the revision keeps the transform keyed by referenced-file revisions, so a
    // watcher update of an image re-runs Markdown even when the source text is unchanged.
    revision()
    const path = props.path
    const source = props.source
    const directory = props.directory ?? ""
    const owner = props.owner ?? ""
    return (html: string) =>
      runTransform(html, path, source, directory, owner).catch((cause: unknown) => {
        if (isCurrent(path, source, directory, owner)) setError(true)
        throw cause
      })
  }

  const prepared = createMemo(() => prepareFilePreview(props.source))
  const tooLarge = createMemo(() => isPreviewSourceTooLarge(props.source))

  const anchorFrom = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return
    const anchor = target.closest("a[href]")
    return anchor instanceof HTMLAnchorElement ? anchor : undefined
  }

  const route = (event: Event, href: string) => {
    const target = resolveFilePreviewTarget(props.path, href)
    if (target.kind === "external") return
    event.preventDefault()
    if (target.kind === "blocked" || target.kind === "unsupported") return
    if (target.kind === "anchor") {
      scrollToAnchor(target.fragment)
      return
    }
    if (props.onRequestNavigate) {
      const fragment = fragmentOf(href)
      props.onRequestNavigate({
        directory: props.directory ?? "",
        owner: props.owner ?? "",
        path: target.path,
        tab: target.tab,
        ...(fragment ? { fragment } : {}),
      })
      return
    }
    void openLocal(target.encoded, target.tab)
  }

  const openLocal = async (path: string, tab: string) => {
    await file.load(path)
    tabs().open(tab)
  }

  const handleClick = (event: MouseEvent) => {
    const anchor = anchorFrom(event.target)
    if (!anchor) return
    route(event, anchor.getAttribute("href") ?? "")
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    const anchor = anchorFrom(event.target)
    if (!anchor) return
    route(event, anchor.getAttribute("href") ?? "")
  }

  const markdownProps = () => ({
    get text() {
      return prepared().text
    },
    get transformHtml() {
      return captureTransform()
    },
    onRendered: () => {
      applyInitialScroll()
      untrack(consumeAnchor)
    },
  })

  return (
    <div
      ref={setRoot}
      data-component="file-preview"
      data-file-preview-build={buildId}
      class={props.class}
      classList={props.classList}
      onClick={handleClick}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
    >
      <Show
        when={!tooLarge()}
        fallback={
          <div data-file-preview-too-large class="px-6 py-4 text-text-weak">
            {language.t("filePreview.tooLarge", { size: "5 MiB" })}
          </div>
        }
      >
        {createComponent(Markdown, markdownProps())}
        <Show when={error()}>
          <div data-file-preview-error class="px-6 py-4 text-text-weak">
            <div>{language.t("filePreview.error")}</div>
            <Show when={props.onRequestSource}>
              <button
                type="button"
                class="mt-2 text-12-medium underline"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onRequestSource?.()
                }}
              >
                {language.t("filePreview.error.viewSource")}
              </button>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function fragmentOf(href: string) {
  const index = href.indexOf("#")
  if (index === -1) return
  return href.slice(index + 1)
}

function samePaths(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function decodeFragment(fragment: string) {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}
