import type { FileContent } from "@opencode-ai/sdk/v2"

const MAX_FILE_CONTENT_ENTRIES = 40
export const MAX_FILE_CONTENT_BYTES = 20 * 1024 * 1024

const lru = new Map<string, number>()
let total = 0

export function approxBytes(content: FileContent) {
  const patchBytes =
    content.patch?.hunks.reduce((sum, hunk) => {
      return sum + hunk.lines.reduce((lineSum, line) => lineSum + line.length, 0)
    }, 0) ?? 0

  return (content.content.length + (content.diff?.length ?? 0) + patchBytes) * 2
}

function setBytes(path: string, nextBytes: number) {
  const prev = lru.get(path)
  if (prev !== undefined) total -= prev
  lru.delete(path)
  lru.set(path, nextBytes)
  total += nextBytes
}

function touch(path: string, bytes?: number) {
  const prev = lru.get(path)
  if (prev === undefined && bytes === undefined) return
  setBytes(path, bytes ?? prev ?? 0)
}

function remove(path: string) {
  const prev = lru.get(path)
  if (prev === undefined) return
  lru.delete(path)
  total -= prev
}

function reset() {
  lru.clear()
  total = 0
}

// Bounded resource loads admit only when the entry fits the remaining byte
// budget without evicting anything else, and a new path needs a free entry slot
// (a cached path may replace itself). Default loads skip this check and keep
// their existing unconstrained behavior.
export function canAdmitContentBytes(bytes: number) {
  return bytes <= MAX_FILE_CONTENT_BYTES - total
}

export function canAdmitFileContent(path: string, bytes: number) {
  if (!canAdmitContentBytes(bytes - (lru.get(path) ?? 0))) return false
  return lru.has(path) ? lru.size <= MAX_FILE_CONTENT_ENTRIES : lru.size < MAX_FILE_CONTENT_ENTRIES
}

export function evictContentLru(keep: Set<string> | undefined, evict: (path: string) => void) {
  const set = keep ?? new Set<string>()

  while (lru.size > MAX_FILE_CONTENT_ENTRIES || total > MAX_FILE_CONTENT_BYTES) {
    const path = lru.keys().next().value
    if (!path) return

    if (set.has(path)) {
      touch(path)
      if (lru.size <= set.size) return
      continue
    }

    remove(path)
    evict(path)
  }
}

export function resetFileContentLru() {
  reset()
}

export function setFileContentBytes(path: string, bytes: number) {
  setBytes(path, bytes)
}

export function removeFileContentBytes(path: string) {
  remove(path)
}

export function touchFileContent(path: string, bytes?: number) {
  touch(path, bytes)
}

export function getFileContentBytesTotal() {
  return total
}

export function getFileContentEntryCount() {
  return lru.size
}

export function hasFileContent(path: string) {
  return lru.has(path)
}
