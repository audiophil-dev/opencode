import { createPathHelpers, encodeFilePath, stripQueryAndHash } from "../../context/file/path"

export type FilePreviewBlockedReason =
  | "empty"
  | "nul"
  | "windows-path"
  | "drive-letter"
  | "blocked-scheme"
  | "malformed-encoding"
  | "encoded-separator"
  | "encoded-dot"
  | "double-encoding"
  | "escape"

export type FilePreviewTarget =
  | { kind: "anchor"; fragment: string }
  | { kind: "local"; path: string; encoded: string; tab: string }
  | { kind: "external"; url: string }
  | { kind: "blocked"; reason: FilePreviewBlockedReason }
  | { kind: "unsupported"; path: string; reason: "tab-round-trip" }

const externalSchemes = ["http", "https", "mailto"]
const blockedSchemes = ["javascript", "vbscript", "data", "file"]

// Pure round-trip probe: an empty scope never strips a workspace prefix, so
// pathFromTab only exercises the tab normalizer's own decoding/unquoting.
const roundTrip = createPathHelpers(() => "")

export function resolveFilePreviewTarget(documentPath: string, href: string): FilePreviewTarget {
  if (!href) return blocked("empty")
  if (href.includes("\0")) return blocked("nul")

  // Windows separators, drive letters and UNC prefixes never denote workspace files.
  if (href.includes("\\")) return blocked("windows-path")
  if (/^[A-Za-z]:/.test(href)) return blocked("drive-letter")

  if (href.startsWith("#")) return { kind: "anchor", fragment: href.slice(1) }

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href)
  if (scheme) {
    const value = scheme[1]!.toLowerCase()
    if (blockedSchemes.includes(value)) return blocked("blocked-scheme")
    // Mirrors the platform openExternal allowlist: only these leave the app.
    if (!externalSchemes.includes(value)) return blocked("blocked-scheme")
    return { kind: "external", url: href }
  }

  if (href.startsWith("//")) return { kind: "external", url: href }

  // Query/fragment is Markdown syntax, not filename content: strip before decoding.
  const raw = stripQueryAndHash(href)
  if (!raw) return blocked("empty")
  if (hasMalformedPercent(raw)) return blocked("malformed-encoding")
  if (/%2f|%5c/i.test(raw)) return blocked("encoded-separator")
  // An encoded dot would let the segment stack reinterpret a traversal after decoding.
  if (/%2e/i.test(raw)) return blocked("encoded-dot")

  const decoded = decodeValue(raw)
  if (decoded === null) return blocked("malformed-encoding")
  if (decoded.includes("\0")) return blocked("nul")
  if (decoded.includes("\\")) return blocked("windows-path")
  // Anything that still looks encoded would be decoded a second time downstream.
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) return blocked("double-encoding")

  const segments = documentDirectory(documentPath)
  if (!segments) return blocked("escape")

  // A leading slash is workspace-root-relative, never an OS absolute path.
  const resolved = decoded.startsWith("/") ? [] : segments

  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (resolved.length === 0) return blocked("escape")
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }

  if (resolved.length === 0) return blocked("empty")

  const path = resolved.join("/")
  const encoded = encodeFilePath(path)
  const tab = `file://${encoded}`

  // Do not route through file.normalize for containment: it strips prefixes and
  // decodes. Symlink/realpath enforcement belongs to the server sandbox.
  if (roundTrip.pathFromTab(tab) !== path) return { kind: "unsupported", path, reason: "tab-round-trip" }

  return { kind: "local", path, encoded, tab }
}

const blocked = (reason: FilePreviewBlockedReason): FilePreviewTarget => ({ kind: "blocked", reason })

function documentDirectory(documentPath: string) {
  const segments: string[] = []

  for (const segment of documentPath.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  segments.pop()
  return segments
}

// decodeURIComponent throws on syntactically valid escapes that encode invalid
// UTF-8 (lone surrogates, truncated multibyte, out-of-range bytes). That is a
// blocked target, not a crash, so the decode step is made total here.
function decodeValue(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function hasMalformedPercent(input: string) {
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== "%") continue
    if (!/^[0-9A-Fa-f]{2}$/.test(input.slice(index + 1, index + 3))) return true
    index += 2
  }
  return false
}
