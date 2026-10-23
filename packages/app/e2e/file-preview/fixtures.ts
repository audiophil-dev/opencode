// Deterministic synthetic corpus for the packaged file-preview browser suite.
// Every byte here is a small literal or a known image constant; nothing is copied
// from a real workspace, session or user file. The corpus is regenerated on demand
// and its hashes are compared across two independent generations to prove determinism.
import { createHash } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

export const FIXTURE_WORKSPACE_DIRNAME = "workspace"
export const DENIED_DIRNAME = "denied"
export const DENIED_MARKER = "FILE_PREVIEW_DENIED_MARKER_DO_NOT_EXPOSE"
export const DENIED_TARGET_REL = `${DENIED_DIRNAME}/secret-marker.txt`
export const DENIED_LINK_REL = `${FIXTURE_WORKSPACE_DIRNAME}/denied-link.txt`

const FIVE_MIB = 5 * 1024 * 1024

// 1x1 red images in three formats plus an inline SVG. Valid, decodable bytes.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=",
  "base64",
)
// Second valid 1x1 PNG with different bytes; the watcher test rewrites an image
// on disk with it and asserts the preview data URL changes while Markdown is constant.
export const PNG_1PX_ALT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)
const JPEG_1PX = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==",
  "base64",
)
const WEBP_1PX = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA", "base64")
const SVG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#00ff00"/></svg>`

const SHARED_DOC = [
  "# Shared document",
  "",
  "Identical bytes under two directories; each directory owns a different image.",
  "",
  "![pic](./pic.png)",
  "",
].join("\n")

const blocks = [
  "# Blocks",
  "",
  "```ts",
  "const answer = 42",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "- [ ] todo",
  "- [x] done",
  "",
].join("\n")

const exactLimit = () => {
  const header = "# Five MiB exact\n\n"
  return header + "x".repeat(FIVE_MIB - Buffer.byteLength(header))
}
const overLimit = () => {
  const header = "# Five MiB plus one\n\n"
  return header + "x".repeat(FIVE_MIB + 1 - Buffer.byteLength(header))
}
const oversizedBase64 = () => `# Oversized data URL\n\n![big](data:image/png;base64,${"A".repeat(8 * 1024 * 1024)})\n`

// Resource-admission fixtures: small documents whose images are the subject. The
// budget document references one known PNG; the gallery references forty distinct
// paths with the same known bytes so the content cache entry slots fill exactly.
export const BUDGET_DOC_PATH = "budget/image-budget.md"
export const BUDGET_IMAGE_PATH = "budget/image-budget.png"
export const GALLERY_DOC_PATH = "gallery/gallery.md"
export const GALLERY_IMAGE_COUNT = 40

export function galleryImagePaths(): string[] {
  return Array.from({ length: GALLERY_IMAGE_COUNT }, (_, index) => `gallery/img-${String(index).padStart(2, "0")}.png`)
}

// 16 MiB of well-formed base64: the known PNG prefix (unpadded) followed by 'A'
// characters. Alphabet, length % 4 and padding satisfy the product's own validator,
// so a rejection can only be the size/admission gate. The delivered response really
// carries this allocation; this is not a transport-level cap.
export const OVERSIZED_IMAGE_BASE64_CHARS = 16 * 1024 * 1024
let oversizedImageBase64Cache: string | undefined
export function oversizedImageBase64(): string {
  oversizedImageBase64Cache ??= (() => {
    const prefix = PNG_1PX.toString("base64").replace(/=+$/, "")
    return prefix + "A".repeat(OVERSIZED_IMAGE_BASE64_CHARS - prefix.length)
  })()
  return oversizedImageBase64Cache
}

const budgetDoc = [
  "# Image budget",
  "",
  "The referenced image exceeds the resource cache budget.",
  "",
  "![budget image](./image-budget.png)",
  "",
  "Rest of the document stays visible.",
  "",
].join("\n")

const galleryDoc = [
  "# Gallery",
  "",
  "Forty distinct image references fill the content cache entry slots.",
  "",
  ...galleryImagePaths().map((entry) => `![${path.basename(entry, ".png")}](./${path.basename(entry)})`),
  "",
  "Gallery body stays visible after the last placeholder.",
  "",
].join("\n")

export type FixtureEntry = { path: string; content: string | Uint8Array }

// Relative to the fixture workspace root. Insertion order is stable.
export function fixtureEntries(): FixtureEntry[] {
  return [
    {
      path: "readme.md",
      content: [
        "# File preview fixture",
        "",
        "A local image and a nested link.",
        "",
        "![dot](./images/dot.png)",
        "",
        "[nested guide](./guide/intro.md)",
        "",
        blocks,
      ].join("\n"),
    },
    { path: "plain.txt", content: "plain text, not markdown\n" },
    { path: "guide/intro.md", content: "# Intro\n\nBack to [readme](../readme.md).\n" },
    { path: "guide/nested/deep.md", content: "# Deep\n\n![nested](../../images/nested.png)\n" },
    { path: "iso/one/doc.md", content: SHARED_DOC },
    { path: "iso/two/doc.md", content: SHARED_DOC },
    { path: "iso/one/pic.png", content: PNG_1PX },
    { path: "iso/two/pic.png", content: new TextEncoder().encode(SVG_IMAGE) },
    { path: "images/dot.png", content: PNG_1PX },
    { path: "images/photo.jpg", content: JPEG_1PX },
    { path: "images/picture.webp", content: WEBP_1PX },
    { path: "images/diagram.svg", content: SVG_IMAGE },
    { path: "images/nested.png", content: PNG_1PX },
    { path: "a b/über.png", content: PNG_1PX },
    {
      path: "render/reference.md",
      content: [
        "# Reference style",
        "",
        "![ref image][img]",
        "",
        "[ref link][doc]",
        "",
        "[img]: ./nested.png",
        "[doc]: ../guide/intro.md",
        "",
      ].join("\n"),
    },
    { path: "render/nested.png", content: PNG_1PX },
    {
      path: "render/raw-html.md",
      content: '# Raw HTML\n\n<img src="./nested.png" alt="raw image">\n',
    },
    {
      path: "render/unicode.md",
      content: [
        "# Unicode und Leerzeichen",
        "",
        "![über bild](../a%20b/%C3%BCber.png)",
        "",
        "[zum Leitfaden](../guide/intro.md)",
        "",
      ].join("\n"),
    },
    {
      path: "render/anchors.md",
      content: [
        "# Anchors",
        "",
        "[jump to sections](#sections)",
        "",
        "Intro paragraph before the target heading.",
        "",
        // Filler paragraphs force the preview to overflow so scrolling to the
        // anchor target is observable; the panel fits a short document at 0.
        ...Array.from({ length: 60 }, (_, index) => `Filler paragraph ${index + 1} keeps the target below the fold.`),
        "",
        "## Sections",
        "",
        "Target content under the anchor heading.",
        "",
        "[deep guide](../guide/nested/deep.md)",
        "",
      ].join("\n"),
    },
    { path: "frontmatter/bom.md", content: `\uFEFF---\ntitle: BOM doc\n---\n\n# Body\n` },
    { path: "frontmatter/crlf.md", content: "---\r\ntitle: CRLF doc\r\n---\r\n\r\n# Body\r\n" },
    { path: "content/blocks.md", content: blocks },
    {
      path: "content/scroll.md",
      content: [
        "# Scroll fixture",
        "",
        // 200 numbered paragraphs keep the document far taller than the file
        // panel at the Desktop Chrome viewport, so preview and source scrolling
        // have real overflow to move through.
        ...Array.from(
          { length: 200 },
          (_, index) => `Scroll paragraph ${index + 1} keeps the document taller than the panel.`,
        ),
        "",
      ].join("\n"),
    },
    { path: "broken/missing-image.md", content: "# Missing\n\n![missing](./does-not-exist.png)\n" },
    {
      path: "broken/corrupt.png",
      content: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    },
    { path: "broken/oversized-base64.md", content: oversizedBase64() },
    {
      path: "unsafe/urls.md",
      content: [
        "# Unsafe URLs",
        "",
        "[js](javascript:alert(1))",
        "[data](data:image/png;base64,AAAA)",
        "[file](file:///etc/passwd)",
        "[external](https://example.com/)",
        "",
      ].join("\n"),
    },
    { path: "unsafe/srcset.md", content: '# Srcset\n\n<img src="./dot.png" srcset="./nested.png 2x" alt="srcset">\n' },
    {
      path: "unsafe/style.md",
      content:
        '# Style\n\n<img src="./dot.png" style="width:1px" alt="styled">\n\n<div style="background:url(./dot.png)">x</div>\n',
    },
    {
      path: "unsafe/svg-script.md",
      content:
        '# Inline SVG\n\n<svg xmlns="http://www.w3.org/2000/svg"><script>window.__filePreviewScriptRan = true</script></svg>\n',
    },
    { path: "limits/exact-5mib.md", content: exactLimit() },
    { path: "limits/over-5mib.md", content: overLimit() },
    { path: BUDGET_DOC_PATH, content: budgetDoc },
    { path: BUDGET_IMAGE_PATH, content: PNG_1PX },
    { path: GALLERY_DOC_PATH, content: galleryDoc },
    ...galleryImagePaths().map((entry) => ({ path: entry, content: PNG_1PX })),
  ]
}

export function hashContent(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  return createHash("sha256").update(bytes).digest("hex")
}

// Sorted path -> sha256 of the exact bytes written.
export function fixtureHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of [...fixtureEntries()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    out[entry.path] = hashContent(entry.content)
  }
  return out
}

// Single digest over the sorted (path, sha256) pairs; equal digest means an
// independent regeneration produced byte-identical content.
export function fixtureDigest(): string {
  const hashes = fixtureHashes()
  return hashContent(
    Object.entries(hashes)
      .map(([p, h]) => `${p}:${h}`)
      .join("\n"),
  )
}

export async function writeFixtureWorkspace(root: string): Promise<string[]> {
  const workspace = path.join(root, FIXTURE_WORKSPACE_DIRNAME)
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const written: string[] = []
  for (const entry of fixtureEntries()) {
    const target = path.join(workspace, entry.path)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, entry.content)
    written.push(entry.path)
  }
  return written
}

// Denied target lives outside the workspace tree; a runtime-created symlink inside
// the workspace points at it. Created only under the owned test root, never in the repo.
export async function writeDeniedFixture(root: string): Promise<string> {
  const target = path.join(root, DENIED_TARGET_REL)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, DENIED_MARKER)
  return target
}

export async function createDeniedSymlink(root: string): Promise<string> {
  const link = path.join(root, DENIED_LINK_REL)
  await symlink(path.join(root, DENIED_TARGET_REL), link)
  return link
}
