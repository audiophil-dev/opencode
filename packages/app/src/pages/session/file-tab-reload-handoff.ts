// One-time, active-owner handoff that carries the open file tabs' Preview/Source modes across
// the full document reload performed by the layout switch (`setNewLayoutDesigns` schedules
// `window.location.reload()`). It is NOT a durable preference: the entry lives in
// sessionStorage, so it dies with the browser tab, is written only at the reload point, and is
// consumed exactly once by the next matching reload document. It holds only mode and
// preview-scroll values - never file content, drafts, selections or secrets.

export type FileTabReloadHandoffTab = {
  mode?: "preview" | "source"
  scroll?: { x: number; y: number }
}

type HandoffPayload = {
  nonce: string
  owner: string
  tabs: Record<string, FileTabReloadHandoffTab>
}

type HandoffCapture = {
  owner: string
  tabs: Record<string, FileTabReloadHandoffTab>
}

const STORAGE_KEY = "opencode.file-tab-reload-handoff.v1"

// One nonce per document load. Same-document provider remounts share it, so only a
// genuinely new document (the targeted reload) can consume.
let documentNonce: string | undefined

function currentNonce() {
  documentNonce ??= globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return documentNonce
}

// Both methods must tolerate a denied storage getter: the layout setting flip calls the write
// path, and a SecurityError there must not break the setting change. The visual mode is the
// only thing lost, and it falls back to the default Preview.
function storage() {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

// Require a known reload entry. Missing navigation timing (test DOMs, older engines) must not
// restore: an unknown navigation cannot prove the carrier belongs to the layout reload.
function enteredViaReload() {
  try {
    const nav = globalThis.performance?.getEntriesByType?.("navigation")?.[0] as { type?: string } | undefined
    return nav?.type === "reload"
  } catch {
    return false
  }
}

// Untrusted browser state: keep only file tabs with a valid mode enum and finite scroll.
function sanitizeTabs(value: unknown) {
  if (typeof value !== "object" || value === null) return
  const out: Record<string, FileTabReloadHandoffTab> = {}
  for (const [tab, entry] of Object.entries(value)) {
    if (!tab.startsWith("file://")) continue
    if (typeof entry !== "object" || entry === null) continue
    const raw = entry as Record<string, unknown>
    const clean: FileTabReloadHandoffTab = {}
    if (raw.mode === "preview" || raw.mode === "source") clean.mode = raw.mode
    if (typeof raw.scroll === "object" && raw.scroll !== null) {
      const scroll = raw.scroll as Record<string, unknown>
      const x = scroll.x
      const y = scroll.y
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        clean.scroll = { x, y }
      }
    }
    if (clean.mode || clean.scroll) out[tab] = clean
  }
  return out
}

let capture: (() => HandoffCapture | undefined) | undefined

// Returns an unregister that clears only its own callback, so a replaced provider cannot be
// clobbered by the previous provider's cleanup.
export function registerFileTabReloadHandoffCapture(fn: (() => HandoffCapture | undefined) | undefined) {
  capture = fn
  return () => {
    if (capture === fn) capture = undefined
  }
}

// Called only from the layout-setting flip that is about to reload the document. With no
// active capture or no chosen modes it clears any earlier carrier so an old Source choice
// cannot be restored by a later reload.
export function writeFileTabReloadHandoffFromCapture() {
  const store = storage()
  if (!store) return
  const drop = () => {
    try {
      store.removeItem(STORAGE_KEY)
    } catch {}
  }
  const current = capture?.()
  const tabs = current ? sanitizeTabs(current.tabs) : undefined
  if (!current || !tabs || Object.keys(tabs).length === 0) {
    drop()
    return
  }
  try {
    const payload: HandoffPayload = { nonce: currentNonce(), owner: current.owner, tabs }
    store.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {}
}

// A fresh document consumes the carrier once, and only when it entered through a known reload
// for the active owner. Any other entry (non-reload navigation, missing navigation timing,
// wrong owner) discards it so a later manual reload cannot resurrect a stale mode.
export function takeFileTabReloadHandoff(owner: string) {
  const store = storage()
  if (!store) return
  let raw: string | null
  try {
    raw = store.getItem(STORAGE_KEY)
  } catch {
    return
  }
  if (raw === null) return

  const drop = () => {
    try {
      store.removeItem(STORAGE_KEY)
    } catch {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    drop()
    return
  }
  if (typeof parsed !== "object" || parsed === null) {
    drop()
    return
  }
  const payload = parsed as Record<string, unknown>
  if (typeof payload.nonce !== "string" || typeof payload.owner !== "string") {
    drop()
    return
  }
  if (typeof payload.tabs !== "object" || payload.tabs === null) {
    drop()
    return
  }

  // Same document: a provider remount before the scheduled reload keeps it armed.
  if (payload.nonce === currentNonce()) return
  if (!enteredViaReload() || payload.owner !== owner) {
    drop()
    return
  }

  const tabs = sanitizeTabs(payload.tabs)
  drop()
  return tabs
}
