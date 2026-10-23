import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@/utils/toast"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  canAdmitFileContent,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServerSDK } from "./server-sdk"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileAdmission,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk().directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK().scope, SessionRouteKey.fromRoute(base64Encode(sdk().directory), params.id)),
    )

    const inflight = new Map<string, Promise<void>>()
    const inflightBounded = new Map<string, Promise<void>>()
    let nextRequestId = 1
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) =>
        sdk()
          .client.file.list({ path: dir })
          .then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      inflightBounded.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache(serverSDK().scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"], admission?: FileAdmission, requestId?: number) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
          draft.admission = admission
          draft.requestId = requestId
        }),
      )
    }

    const setAdmissionRejected = (file: string, admission: FileAdmission) => {
      removeFileContentBytes(file)
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.loaded = false
          draft.content = undefined
          draft.admission = admission
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean; budget?: number }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      const bounded = options?.budget !== undefined
      const boundedKey = bounded ? `${key}\n${options?.budget}` : key
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) {
        // A default consumer taking ownership of a cached bounded entry hands
        // the watcher policy back to unbounded without re-reading, and bumps
        // the generation so an in-flight bounded read cannot roll it back.
        if (options?.budget === undefined && current.admission !== undefined) {
          const handoffId = nextRequestId++
          setStore(
            "file",
            file,
            produce((draft) => {
              draft.admission = undefined
              draft.requestId = handoffId
            }),
          )
        }
        return Promise.resolve()
      }

      const requestId = nextRequestId++
      const previousRequestId = current?.requestId

      // A bounded caller may reuse an unbounded read (it publishes the same
      // content), but an unbounded caller must never join a bounded read that
      // could be rejected.
      const pending = bounded ? (inflight.get(key) ?? inflightBounded.get(boundedKey)) : inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk()
        .client.file.read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          // A bounded completion from before a newer commit must not clobber
          // it; an unbounded completion keeps the existing last-write behavior.
          if (bounded && store.file[file]?.requestId !== previousRequestId) return
          const content = x.data
          if (!content) {
            setLoaded(file, content, undefined, requestId)
            return
          }

          const bytes = approxBytes(content)
          const budget = options?.budget
          if (budget !== undefined && (bytes > budget || !canAdmitFileContent(file, bytes))) {
            setAdmissionRejected(file, { budget, bytes, rejected: true })
            return
          }

          setLoaded(file, content, budget === undefined ? undefined : { budget, bytes, rejected: false }, requestId)
          touchFileContent(file, bytes)
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          if (bounded) inflightBounded.delete(boundedKey)
          else inflight.delete(key)
        })

      if (bounded) inflightBounded.set(boundedKey, promise)
      else inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false", options?: { limit?: number; signal?: AbortSignal }) =>
      serverSDK()
        .api.file.find(
          {
            location: { directory: sdk().directory },
            query,
            type: dirs === "true" ? "directory" : "file",
            limit: options?.limit,
          },
          { signal: options?.signal },
        )
        .then(
          (x) => x.data.map((entry) => path.normalize(entry.path)),
          (error) => {
            if (options?.signal?.aborted) throw error
            return []
          },
        )

    const stop = sdk().event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          const admission = store.file[file]?.admission
          void load(file, { force: true, ...(admission ? { budget: admission.budget } : {}) })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
        search(query, "false", options),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
