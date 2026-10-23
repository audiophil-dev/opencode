import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  useContext,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { FileSearchHandle } from "@opencode-ai/session-ui/file"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { Button } from "@opencode-ai/ui/button"
import { cloneSelectedLineRange, previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { createLineCommentController } from "@opencode-ai/session-ui/line-comment-annotations"
import { createLineCommentControllerV2 } from "@opencode-ai/session-ui/v2/line-comment-annotations-v2"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { LineCommentV2OverflowIcon } from "@opencode-ai/ui/v2/line-comment-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { showToast } from "@/utils/toast"
import { useSDK } from "@/context/sdk"
import { selectionFromLines, useFile, type FileSelection, type FileState, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { getSessionHandoff } from "@/pages/session/handoff"
import {
  registerFileTabReloadHandoffCapture,
  takeFileTabReloadHandoff,
  type FileTabReloadHandoffTab,
} from "@/pages/session/file-tab-reload-handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import {
  FilePreview,
  isPreviewSourceTooLarge,
  type FilePreviewAnchorRequest,
  type FilePreviewNavigateRequest,
} from "@/pages/session/file-preview"

type SessionFileViewProps = {
  tab: string
}

// ---------------------------------------------------------------------------
// Shared Preview/Source state and helpers (above the V1/V2 layout split)
// ---------------------------------------------------------------------------

export type FileTabViewMode = "preview" | "source"

const previewExtensions = new Set(["md", "markdown", "mdx"])

function previewEligiblePath(path: string | undefined) {
  if (!path) return false
  const index = path.lastIndexOf(".")
  if (index === -1) return false
  return previewExtensions.has(path.slice(index + 1).toLowerCase())
}

// Eligibility is size-bound: an over-5 MiB Markdown source keeps the source viewer as
// the mode (with its own localized explanation) instead of mounting a preview that
// would refuse to parse it. The limit counts UTF-8 bytes, not JS characters.
export function previewEligible(path: string | undefined, content: FileState["content"]) {
  if (!previewEligiblePath(path)) return false
  if (content?.type !== "text" || typeof content.content !== "string") return false
  return !isPreviewSourceTooLarge(content.content)
}

type FileTabPreviewTabState = {
  mode?: FileTabViewMode
  anchor?: FilePreviewAnchorRequest
  scroll?: ScrollPos
}

const FileTabPreviewContext = createContext<
  | {
      mode: (tab: string) => FileTabViewMode | undefined
      setMode: (tab: string, mode: FileTabViewMode) => void
      anchor: (tab: string) => FilePreviewAnchorRequest | undefined
      requestAnchor: (tab: string, intent: { path: string; fragment: string }) => void
      scroll: (tab: string) => ScrollPos | undefined
      setScroll: (tab: string, pos: ScrollPos) => void
    }
  | undefined
>(undefined)

// Per-open-tab preview state shared across sibling file tabs, above the V1/V2 split so a
// layout switch never resets it. Entries drop reactively once their tab is no longer open,
// so closing and reopening a file restarts from the default mode. The only thing that
// ever leaves this store is the one-time reload handoff (file-tab-reload-handoff.ts),
// written when the layout setting is about to reload the whole document: it carries only
// the open tabs' chosen mode and preview scroll across that single reload, is consumed
// once by the next document, and never survives closing the browser tab.
export function FileTabPreviewStateProvider(props: { children: JSX.Element }) {
  const { sessionKey, tabs, ready } = useSessionLayout()
  const [state, setState] = createStore<Record<string, Record<string, FileTabPreviewTabState>>>({})

  createEffect(() => {
    const session = sessionKey()
    const all = tabs().all()
    const current = state[session]
    if (!current) return
    const stale = Object.keys(current).filter((tab) => !all.includes(tab))
    if (stale.length === 0) return
    setState(
      session,
      produce((draft) => {
        if (!draft) return
        for (const tab of stale) delete draft[tab]
      }),
    )
  })

  const api = {
    mode: (tab: string) => state[sessionKey()]?.[tab]?.mode,
    setMode: (tab: string, mode: FileTabViewMode) => {
      const session = sessionKey()
      if (!state[session]) setState(session, {})
      if (!state[session][tab]) {
        setState(session, tab, { mode })
        return
      }
      setState(session, tab, "mode", mode)
    },
    anchor: (tab: string) => state[sessionKey()]?.[tab]?.anchor,
    requestAnchor: (tab: string, intent: { path: string; fragment: string }) => {
      const session = sessionKey()
      if (!state[session]) setState(session, {})
      const revision = (state[session][tab]?.anchor?.revision ?? -1) + 1
      if (!state[session][tab]) {
        setState(session, tab, { anchor: { path: intent.path, fragment: intent.fragment, revision } })
        return
      }
      setState(session, tab, "anchor", { path: intent.path, fragment: intent.fragment, revision })
    },
    scroll: (tab: string) => state[sessionKey()]?.[tab]?.scroll,
    setScroll: (tab: string, pos: ScrollPos) => {
      const session = sessionKey()
      if (!state[session]) setState(session, {})
      if (!state[session][tab]) {
        setState(session, tab, { scroll: pos })
        return
      }
      setState(session, tab, "scroll", pos)
    },
  }

  // Reload handoff, write side: the layout-setting flip (context/settings) calls the
  // registered capture once, immediately before reloading the document. Only this active
  // session's still-open tabs - per the same tab store that drives the stale pruning above -
  // and only mode/preview-scroll values cross the reload.
  onCleanup(
    registerFileTabReloadHandoffCapture(() => {
      const owner = sessionKey()
      const chosen: Record<string, FileTabReloadHandoffTab> = {}
      for (const tab of tabs().all()) {
        const entry = state[owner]?.[tab]
        if (!entry?.mode && !entry?.scroll) continue
        chosen[tab] = {
          ...(entry.mode ? { mode: entry.mode } : {}),
          ...(entry.scroll ? { scroll: { x: entry.scroll.x, y: entry.scroll.y } } : {}),
        }
      }
      return { owner, tabs: chosen }
    }),
  )

  // Reload handoff, read side: consume exactly once per provider mount after the tab
  // store is hydrated, and reattach modes only to tabs that are still open in this
  // session. The helper skips same-document reads, so a remount before the scheduled
  // reload never consumes it; the fresh document from the reload does.
  let restoredReloadHandoff = false
  createEffect(() => {
    if (restoredReloadHandoff) return
    if (!ready()) return
    restoredReloadHandoff = true
    const taken = takeFileTabReloadHandoff(sessionKey())
    if (!taken) return
    const all = tabs().all()
    for (const [tab, entry] of Object.entries(taken)) {
      if (!all.includes(tab)) continue
      if (entry.mode) api.setMode(tab, entry.mode)
      if (entry.scroll) api.setScroll(tab, entry.scroll)
    }
  })

  return <FileTabPreviewContext.Provider value={api}>{props.children}</FileTabPreviewContext.Provider>
}

function useFileTabPreviewState() {
  const ctx = useContext(FileTabPreviewContext)
  if (!ctx) throw new Error("FileTabPreviewStateProvider must wrap the session file tabs")
  return ctx
}

function PreviewSourceControls(props: {
  mode: FileTabViewMode
  groupLabel: string
  previewLabel: string
  sourceLabel: string
  onSelect: (mode: FileTabViewMode) => void
}) {
  return (
    <div role="group" aria-label={props.groupLabel} class="flex items-center gap-1 px-4 pt-2">
      <Button
        variant="ghost"
        size="small"
        aria-pressed={props.mode === "preview"}
        onClick={() => props.onSelect("preview")}
      >
        {props.previewLabel}
      </Button>
      <Button
        variant="ghost"
        size="small"
        aria-pressed={props.mode === "source"}
        onClick={() => props.onSelect("source")}
      >
        {props.sourceLabel}
      </Button>
    </div>
  )
}

const selectionSide = (range: SelectedLineRange) => range.endSide ?? range.side ?? "additions"

function FileCommentMenu(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <DropdownMenu gutter={4} placement="bottom-end">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          size="small"
          class="size-6 rounded-md"
          aria-label={props.moreLabel}
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={props.onEdit}>
              <DropdownMenu.ItemLabel>{props.editLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDelete}>
              <DropdownMenu.ItemLabel>{props.deleteLabel}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </div>
  )
}

function FileCommentMenuV2(props: {
  moreLabel: string
  editLabel: string
  deleteLabel: string
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <MenuV2 gutter={4}>
        <MenuV2.Trigger as="button" type="button" data-slot="line-comment-v2-overflow" aria-label={props.moreLabel}>
          <LineCommentV2OverflowIcon />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item onSelect={props.onEdit}>{props.editLabel}</MenuV2.Item>
            <MenuV2.Item onSelect={props.onDelete}>{props.deleteLabel}</MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}

type ScrollPos = { x: number; y: number }

function createScrollSync(input: { tab: () => string; view: ReturnType<typeof useSessionLayout>["view"] }) {
  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined
  let pending: ScrollPos | undefined
  const [code, setCode] = createSignal<HTMLElement[]>([])

  const getCode = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const save = (next: ScrollPos) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      input.view().setScroll(input.tab(), out)
    })
  }

  const onCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    save({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const sync = () => {
    const next = getCode()
    const current = code()
    if (next.length === current.length && next.every((el, i) => el === current[i])) return
    setCode(next)
  }

  const restore = () => {
    const el = scroll
    if (!el) return

    const pos = input.view().scroll(input.tab())
    if (!pos) return

    sync()

    if (code().length > 0) {
      for (const item of code()) {
        if (item.scrollLeft !== pos.x) item.scrollLeft = pos.x
      }
    }

    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    if (code().length > 0) return
    if (el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restore()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (code().length === 0) sync()

    save({
      x: code()[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  createEffect(() => {
    for (const item of code()) makeEventListener(item, "scroll", onCodeScroll)
  })

  const setViewport = (el: HTMLDivElement) => {
    scroll = el
    restore()
  }

  onCleanup(() => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  })

  return {
    handleScroll,
    queueRestore,
    setViewport,
  }
}

export function FileTabContent(props: { tab: string }) {
  return (
    <Tabs.Content value={props.tab}>
      <SessionFileView tab={props.tab} />
    </Tabs.Content>
  )
}

export function SessionFileView(props: SessionFileViewProps) {
  const settings = useSettings()

  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<SessionFileViewV1 tab={props.tab} />}>
      <SessionFileViewV2 tab={props.tab} />
    </Show>
  )
}

function SessionFileViewV1(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const fileComponent = useFileComponent()
  const previewState = useFileTabPreviewState()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
    // The portaled find bar must not float over Preview or a non-file panel. The tab ids
    // compared here are canonical: file tabs are opened as file.tab(path), so the literal
    // active() identity is used - activeFileTab would fall back to the first opened tab
    // when Review is selected (no review callback is passed) and keep the bar visible.
    visible: () => tabs().active() === props.tab && mode() === "source",
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })
  const scrollSync = createScrollSync({
    tab: () => props.tab,
    view,
  })

  const previewReady = createMemo(() => previewEligible(path(), state()?.content))
  // Ineligible tabs (non-Markdown, non-text, oversized) always resolve to Source, even if
  // a stale explicit "preview" mode exists - that combination would otherwise hide both
  // panes. The stored mode stays intact for when the file becomes eligible again.
  const mode = createMemo<FileTabViewMode>(() => {
    if (!previewReady()) return "source"
    return previewState.mode(props.tab) ?? "preview"
  })
  const selectMode = (next: FileTabViewMode) => previewState.setMode(props.tab, next)
  const [sourceMounted, setSourceMounted] = createSignal(mode() === "source")

  // Once Source has been visited its renderer stays mounted; returning to Preview only
  // hides it, and a fresh visit requeues the pending source scroll restoration.
  createEffect(
    on(
      mode,
      (value) => {
        if (value !== "source") return
        setSourceMounted(true)
        scrollSync.queueRestore()
      },
      { defer: true },
    ),
  )

  const previewAnchor = createMemo(() => previewState.anchor(props.tab))

  // A fresh external selection request (deep link, session handoff apply, line-linked
  // navigation) targets source lines, so select Source on the request transition itself,
  // before any restoration. The readiness boundary itself is not a request: there the
  // memo only swaps its source (handoff/null -> preserved store range), so it must not
  // pull a Preview tab back to Source. An explicit handoff still consumes once through
  // its own readiness effect below. Prior readiness is tracked manually because Solid's
  // on(..., { defer: true }) leaves prevInput undefined on the first firing.
  let prevReady = file.ready()
  createEffect(
    on(
      [selectedLines, file.ready],
      ([range, ready]) => {
        const boundary = !prevReady && ready
        prevReady = ready
        if (!range || boundary) return
        if (mode() !== "source") selectMode("source")
      },
      { defer: true },
    ),
  )

  // A handoff deep link carries its selection before the file store is ready. The false
  // -> true readiness transition is the initial consumption point for that request: it
  // selects Source exactly once, whether or not the store was seeded in the meantime.
  createEffect(
    on(file.ready, (ready, prev) => {
      if (!ready || prev !== false) return
      const p = path()
      if (!p) return
      const range = getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined
      if (!range) return
      if (mode() !== "source") selectMode("source")
    }),
  )

  const openPreviewTarget = (request: FilePreviewNavigateRequest) => {
    // Use the native file-opening helpers ordering without an outer batch.
    void file.load(request.tab)
    tabs().open(request.tab)
    tabs().setActive(request.tab)
    // An anchored navigation is a preview request: bring the destination back to
    // Preview before the anchor arrives so the heading can scroll there. Its source
    // state stays mounted, so selection, draft and scroll survive the mode switch.
    if (previewEligiblePath(request.path)) previewState.setMode(request.tab, "preview")
    if (request.fragment) {
      previewState.requestAnchor(request.tab, { path: request.path, fragment: request.fragment })
    }
  }

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const buildPreview = (filePath: string, selection: FileSelection) => {
    const source = filePath === path() ? contents() : file.get(filePath)?.content?.content
    if (!source) return undefined
    return selectionPreview(source, selection)
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? buildPreview(input.file, selection)

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview = input.file === path() ? buildPreview(input.file, selectionFromLines(input.selection)) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentController({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    mention: {
      items: file.searchFilesAndDirectories,
    },
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    getHoverSelectedRange: activeSelection,
    cancelDraftOnCommentToggle: true,
    clearSelectionOnSelectionEndNull: true,
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenu
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      // Same selected-tab predicate as the find visibility gate: activeFileTab falls back
      // to the first opened tab while Review is selected and would swallow native find.
      if (tabs().active() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return
      // In Preview the hidden source find must not take Cmd/Ctrl+F; the browser's native
      // find applies there. Only Source routes the request into the registered handler.
      if (mode() !== "source") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    if (mode() !== "source") selectMode("source")
    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    scrollSync.queueRestore()
  })

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        enableGutterUtility
        selectedLines={activeSelection()}
        commentedLines={commentedLines()}
        onRendered={() => {
          scrollSync.queueRestore()
        }}
        annotations={commentsUi.annotations()}
        renderAnnotation={commentsUi.renderAnnotation}
        renderGutterUtility={commentsUi.renderGutterUtility}
        onLineSelected={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelected(range)
        }}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          // A hidden source cannot legitimately end a selection; dropping the null here
          // keeps mode switches from clearing selections or drafts.
          if (!range && mode() !== "source") return
          commentsUi.onLineSelectionEnd(range)
        }}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: scrollSync.queueRestore,
          onError: (args: { kind: "image" | "audio" | "svg" }) => {
            if (args.kind !== "svg") return
            showToast({
              variant: "error",
              title: language.t("toast.file.loadFailed.title"),
            })
          },
        }}
      />
    </div>
  )

  const sourceVisible = () => mode() === "source" || !state()?.loaded
  const oversized = () =>
    previewEligiblePath(path()) && state()?.content?.type === "text" && isPreviewSourceTooLarge(contents())

  const content = () => (
    <div class="mt-3 relative h-full min-h-0 flex flex-col">
      <Show when={previewReady()}>
        <PreviewSourceControls
          mode={mode()}
          groupLabel={language.t("filePreview.mode.group")}
          previewLabel={language.t("filePreview.mode.preview")}
          sourceLabel={language.t("filePreview.mode.source")}
          onSelect={selectMode}
        />
      </Show>
      <Show when={oversized()}>
        <div data-file-preview-too-large class="px-4 pt-2 text-text-weak">
          {language.t("filePreview.tooLarge", { size: "5 MiB" })}
        </div>
      </Show>
      <div class="relative flex-1 min-h-0">
        <Show when={sourceMounted() || !state()?.loaded}>
          <div data-slot="file-source-pane" class="h-full" style={{ display: sourceVisible() ? "" : "none" }}>
            <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll as any}>
              <Switch>
                <Match when={state()?.loaded}>{renderFile(contents())}</Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
                </Match>
                <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
              </Switch>
            </ScrollView>
          </div>
        </Show>
        <Show when={previewReady() && mode() === "preview" && state()?.loaded}>
          <FilePreview
            class="h-full overflow-y-auto"
            path={path() ?? ""}
            source={contents()}
            directory={sdk().directory}
            owner={sessionKey()}
            anchor={previewAnchor() ?? null}
            initialScroll={previewState.scroll(props.tab) ?? null}
            onScrollChange={(pos) => previewState.setScroll(props.tab, pos)}
            onRequestNavigate={openPreviewTarget}
            onRequestSource={() => selectMode("source")}
          />
        </Show>
      </div>
    </div>
  )

  return content()
}

function SessionFileViewV2(props: { tab: string }) {
  const file = useFile()
  const comments = useComments()
  const language = useLanguage()
  const prompt = usePrompt()
  const sdk = useSDK()
  const fileComponent = useFileComponent()
  const previewState = useFileTabPreviewState()
  const { sessionKey, tabs, view } = useSessionLayout()
  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  }).activeFileTab

  let find: FileSearchHandle | null = null

  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
    // The portaled find bar must not float over Preview or a non-file panel. The tab ids
    // compared here are canonical: file tabs are opened as file.tab(path), so the literal
    // active() identity is used - activeFileTab would fall back to the first opened tab
    // when Review is selected (no review callback is passed) and keep the bar visible.
    visible: () => tabs().active() === props.tab && mode() === "source",
  }

  const path = createMemo(() => file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const selectedLines = createMemo<SelectedLineRange | null>(() => {
    const p = path()
    if (!p) return null
    if (file.ready()) return (file.selectedLines(p) as SelectedLineRange | undefined) ?? null
    return (getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined) ?? null
  })
  const scrollSync = createScrollSync({
    tab: () => props.tab,
    view,
  })

  const previewReady = createMemo(() => previewEligible(path(), state()?.content))
  // Same rule as V1: a stale explicit "preview" mode must not hide both panes.
  const mode = createMemo<FileTabViewMode>(() => {
    if (!previewReady()) return "source"
    return previewState.mode(props.tab) ?? "preview"
  })
  const selectMode = (next: FileTabViewMode) => previewState.setMode(props.tab, next)
  const [sourceMounted, setSourceMounted] = createSignal(mode() === "source")

  // Once Source has been visited its renderer stays mounted; returning to Preview only
  // hides it, and a fresh visit requeues the pending source scroll restoration.
  createEffect(
    on(
      mode,
      (value) => {
        if (value !== "source") return
        setSourceMounted(true)
        scrollSync.queueRestore()
      },
      { defer: true },
    ),
  )

  const previewAnchor = createMemo(() => previewState.anchor(props.tab))

  // Same readiness rule as V1: the readiness boundary itself is hydration, not a
  // request, so only a genuine selection transition selects Source. V1 lines 445-464
  // are authoritative for this behavior.
  let prevReady = file.ready()
  createEffect(
    on(
      [selectedLines, file.ready],
      ([range, ready]) => {
        const boundary = !prevReady && ready
        prevReady = ready
        if (!range || boundary) return
        if (mode() !== "source") selectMode("source")
      },
      { defer: true },
    ),
  )

  // A handoff deep link carries its selection before the file store is ready. The false
  // -> true readiness transition is the initial consumption point for that request: it
  // selects Source exactly once, whether or not the store was seeded in the meantime.
  createEffect(
    on(file.ready, (ready, prev) => {
      if (!ready || prev !== false) return
      const p = path()
      if (!p) return
      const range = getSessionHandoff(sessionKey())?.files[p] as SelectedLineRange | undefined
      if (!range) return
      if (mode() !== "source") selectMode("source")
    }),
  )

  const openPreviewTarget = (request: FilePreviewNavigateRequest) => {
    // Use the native file-opening helpers ordering without an outer batch.
    void file.load(request.tab)
    tabs().open(request.tab)
    tabs().setActive(request.tab)
    // An anchored navigation is a preview request: bring the destination back to
    // Preview before the anchor arrives so the heading can scroll there. Its source
    // state stays mounted, so selection, draft and scroll survive the mode switch.
    if (previewEligiblePath(request.path)) previewState.setMode(request.tab, "preview")
    if (request.fragment) {
      previewState.requestAnchor(request.tab, { path: request.path, fragment: request.fragment })
    }
  }

  const selectionPreview = (source: string, selection: FileSelection) => {
    return previewSelectedLines(source, {
      start: selection.startLine,
      end: selection.endLine,
    })
  }

  const buildPreview = (filePath: string, lines: SelectedLineRange) => {
    const source = filePath === path() ? contents() : file.get(filePath)?.content?.content
    if (!source) return undefined
    return selectionPreview(source, selectionFromLines(lines))
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? buildPreview(input.file, input.selection)

    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    const preview = input.file === path() ? buildPreview(input.file, input.selection) : undefined
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(preview ? { preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return comments.list(p)
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    selected: null as SelectedLineRange | null,
  })

  const syncSelected = (range: SelectedLineRange | null) => {
    const p = path()
    if (!p) return
    file.setSelectedLines(p, range ? cloneSelectedLineRange(range) : null)
  }

  const activeSelection = () => note.selected ?? selectedLines()

  const commentsUi = createLineCommentControllerV2({
    comments: fileComments,
    label: language.t("ui.lineComment.submit"),
    draftKey: () => path() ?? props.tab,
    mention: {
      items: file.searchFilesAndDirectories,
    },
    getSide: selectionSide,
    state: {
      opened: () => note.openedComment,
      setOpened: (id) => setNote("openedComment", id),
      selected: () => note.selected,
      setSelected: (range) => setNote("selected", range),
      commenting: () => note.commenting,
      setCommenting: (range) => setNote("commenting", range),
      syncSelected,
      hoverSelected: syncSelected,
    },
    onSubmit: ({ comment, selection }) => {
      const p = path()
      if (!p) return
      addCommentToContext({ file: p, selection, comment, origin: "file" })
    },
    onUpdate: ({ id, comment, selection }) => {
      const p = path()
      if (!p) return
      updateCommentInContext({ id, file: p, selection, comment })
    },
    onDelete: (comment) => {
      const p = path()
      if (!p) return
      removeCommentFromContext({ id: comment.id, file: p })
    },
    editSubmitLabel: language.t("common.save"),
    renderCommentActions: (_, controls) => (
      <FileCommentMenuV2
        moreLabel={language.t("common.moreOptions")}
        editLabel={language.t("common.edit")}
        deleteLabel={language.t("common.delete")}
        onEdit={controls.edit}
        onDelete={controls.remove}
      />
    ),
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      // Same selected-tab predicate as the find visibility gate: activeFileTab falls back
      // to the first opened tab while Review is selected and would swallow native find.
      if (tabs().active() !== props.tab) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return
      // In Preview the hidden source find must not take Cmd/Ctrl+F; the browser's native
      // find applies there. Only Source routes the request into the registered handler.
      if (mode() !== "source") return

      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  createEffect(
    on(
      path,
      () => {
        commentsUi.note.reset()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    const focus = comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (activeFileTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    // A comment focus request targets source lines: Source before restoring the range.
    if (mode() !== "source") selectMode("source")
    commentsUi.note.openComment(target.id, target.selection, { cancelDraft: true })
    requestAnimationFrame(() => comments.clearFocus())
  })

  let prev = {
    loaded: false,
    ready: false,
    active: false,
  }

  createEffect(() => {
    const loaded = !!state()?.loaded
    const ready = file.ready()
    const active = activeFileTab() === props.tab
    const restore = (loaded && !prev.loaded) || (ready && !prev.ready) || (active && loaded && !prev.active)
    prev = { loaded, ready, active }
    if (!restore) return
    scrollSync.queueRestore()
  })

  const renderFile = (source: string) => (
    <div class="relative overflow-hidden pb-40">
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        enableGutterUtility
        selectedLines={activeSelection()}
        commentedLines={commentedLines()}
        onRendered={() => {
          scrollSync.queueRestore()
        }}
        annotations={commentsUi.annotations()}
        renderAnnotation={commentsUi.renderAnnotation}
        renderGutterUtility={commentsUi.renderGutterUtility}
        onLineSelected={(range: SelectedLineRange | null) => {
          commentsUi.onLineSelected(range)
        }}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          if (!range) {
            // A hidden source cannot legitimately end a selection; dropping the null here
            // keeps mode switches from clearing selections or drafts. Visible nulls keep
            // the V2 controller's clear-selection-and-draft semantics.
            if (mode() !== "source") return
            commentsUi.note.select(null)
            commentsUi.note.cancelDraft()
            return
          }
          commentsUi.onLineSelectionEnd(range)
        }}
        onLineNumberSelectionEnd={(range: SelectedLineRange | null) => {
          commentsUi.onLineNumberSelectionEnd(range)
        }}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: scrollSync.queueRestore,
          onError: (args: { kind: "image" | "audio" | "svg" }) => {
            if (args.kind !== "svg") return
            showToast({
              variant: "error",
              title: language.t("toast.file.loadFailed.title"),
            })
          },
        }}
      />
    </div>
  )

  const sourceVisible = () => mode() === "source" || !state()?.loaded
  const oversized = () =>
    previewEligiblePath(path()) && state()?.content?.type === "text" && isPreviewSourceTooLarge(contents())

  const content = () => (
    <div class="mt-3 relative h-full min-h-0 flex flex-col">
      <Show when={previewReady()}>
        <PreviewSourceControls
          mode={mode()}
          groupLabel={language.t("filePreview.mode.group")}
          previewLabel={language.t("filePreview.mode.preview")}
          sourceLabel={language.t("filePreview.mode.source")}
          onSelect={selectMode}
        />
      </Show>
      <Show when={oversized()}>
        <div data-file-preview-too-large class="px-4 pt-2 text-text-weak">
          {language.t("filePreview.tooLarge", { size: "5 MiB" })}
        </div>
      </Show>
      <div class="relative flex-1 min-h-0">
        <Show when={sourceMounted() || !state()?.loaded}>
          <div data-slot="file-source-pane" class="h-full" style={{ display: sourceVisible() ? "" : "none" }}>
            <ScrollView class="h-full" viewportRef={scrollSync.setViewport} onScroll={scrollSync.handleScroll as any}>
              <Switch>
                <Match when={state()?.loaded}>{renderFile(contents())}</Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
                </Match>
                <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
              </Switch>
            </ScrollView>
          </div>
        </Show>
        <Show when={previewReady() && mode() === "preview" && state()?.loaded}>
          <FilePreview
            class="h-full overflow-y-auto"
            path={path() ?? ""}
            source={contents()}
            directory={sdk().directory}
            owner={sessionKey()}
            anchor={previewAnchor() ?? null}
            initialScroll={previewState.scroll(props.tab) ?? null}
            onScrollChange={(pos) => previewState.setScroll(props.tab, pos)}
            onRequestNavigate={openPreviewTarget}
            onRequestSource={() => selectMode("source")}
          />
        </Show>
      </div>
    </div>
  )

  return content()
}
