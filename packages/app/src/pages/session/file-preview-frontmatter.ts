export type FilePreviewFrontmatter = {
  text: string
  hasFrontmatter: boolean
}

const BOM = "\uFEFF"

// Preview-only preparation: turn a leading, closed frontmatter header into an
// escaped fenced YAML block so the shared markdown parser renders it legibly.
// The original source is never touched; callers keep the raw string separately.
export function prepareFilePreview(source: string): FilePreviewFrontmatter {
  if (!source) return { text: source, hasFrontmatter: false }
  const start = source.startsWith(BOM) ? BOM.length : 0
  const openBreak = source.indexOf("\n", start)
  if (openBreak === -1) return { text: source, hasFrontmatter: false }
  const openLine = source.slice(start, openBreak)
  if (!/^---[ \t]*\r?$/.test(openLine)) return { text: source, hasFrontmatter: false }

  const eol = openLine.endsWith("\r") ? "\r\n" : "\n"
  const close = findClosingDelimiter(source, openBreak + 1)
  if (close === null) return { text: source, hasFrontmatter: false }

  const metadata = source.slice(openBreak + 1, close.start)
  const fence = "`".repeat(Math.max(3, longestFenceRun(metadata) + 1))
  // The fenced content is inert at this layer because the markdown parser
  // escapes code blocks; final inertness is enforced downstream by the shared
  // sanitizer and parser when preview HTML is produced.
  return {
    text: fence + "yaml" + eol + metadata + fence + eol + source.slice(close.end + 1),
    hasFrontmatter: true,
  }
}

function findClosingDelimiter(source: string, from: number): { start: number; end: number } | null {
  let pos = from
  while (pos < source.length) {
    const lineBreak = source.indexOf("\n", pos)
    if (lineBreak === -1) return null
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(source.slice(pos, lineBreak))) return { start: pos, end: lineBreak }
    pos = lineBreak + 1
  }
  return null
}

function longestFenceRun(text: string) {
  let longest = 0
  let current = 0
  let last = ""
  for (const char of text) {
    if (char !== "`" && char !== "~") {
      current = 0
      last = ""
      continue
    }
    current = char === last ? current + 1 : 1
    last = char
    if (current > longest) longest = current
  }
  return longest
}
