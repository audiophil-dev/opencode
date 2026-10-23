import type { FileContent } from "@opencode-ai/sdk/v2"
import {
  dataUrlFromMediaValue,
  mediaKindFromPath,
  normalizeMimeType,
  type MediaKind,
} from "@opencode-ai/session-ui/pierre/media"
import { MAX_FILE_CONTENT_BYTES, canAdmitFileContent } from "../../context/file/content-cache"
import type { FileAdmission } from "../../context/file/types"
import { resolveFilePreviewTarget } from "./file-preview-path"

// Resource surfaces that never become preview content. `<source>`/`srcset` and
// media/embed elements would issue requests the preview does not control.
const STRIPPED_ELEMENTS = "source, audio, video, object, iframe, embed, track"
const SVG_RESOURCE_ELEMENTS = "svg image, svg use, svg foreignObject"

export type PreviewFileContent = {
  content?: FileContent
  error?: string
  loaded?: boolean
  loading?: boolean
  admission?: FileAdmission
}

export type PreviewFileApi = {
  load: (path: string, options?: { budget?: number }) => Promise<unknown>
  get: (path: string) => PreviewFileContent | undefined
}

export type PreviewResourceOptions = {
  documentPath: string
  file: PreviewFileApi
  unavailableLabel: string
  budget?: number
  headingRegistry?: Map<string, number>
}

export type PreviewResourceRewrite = {
  html: string
  references: string[]
}

// Rewrites sanitized markdown HTML without ever letting a relative resource reach
// a live DOM: the input is parsed into an inert <template>, mutated, and only then
// serialized back to a string. Local images become data URLs (or an explicit
// placeholder); everything else either stays a plain anchor/image or is stripped.
export async function rewritePreviewResources(
  html: string,
  options: PreviewResourceOptions,
): Promise<PreviewResourceRewrite> {
  const template = document.createElement("template")
  template.innerHTML = html
  const root = template.content

  stripResourceSurfaces(root)
  assignHeadingIds(root, options.headingRegistry)

  // Generated data URLs are extra render memory on top of the content cache, so the
  // cap reuses the cache's own budget constant in the same UTF-16 byte unit,
  // counting each data URL in full including its `data:<mime>;base64,` prefix.
  const budget = options.budget ?? MAX_FILE_CONTENT_BYTES
  const resolved = new Map<string, string | undefined>()
  const references: string[] = []
  let used = 0

  for (const image of Array.from(root.querySelectorAll("img"))) {
    const src = image.getAttribute("src")
    if (!src) continue

    const target = resolveFilePreviewTarget(options.documentPath, src)
    if (target.kind === "external" || target.kind === "anchor") continue
    if (target.kind !== "local") {
      replaceWithPlaceholder(image, options.unavailableLabel)
      continue
    }

    // The provider normalizer decodes and strips query/hash, so the encoded form is
    // what round-trips for names containing ? or #; the decoded form would be truncated.
    references.push(target.encoded)

    if (resolved.has(target.encoded)) {
      const cached = resolved.get(target.encoded)
      if (cached) image.setAttribute("src", cached)
      else replaceWithPlaceholder(image, options.unavailableLabel)
      continue
    }

    const media = await resolveLocalMedia(target.encoded, options.file, budget - used)
    if (!media || !isWellFormedMedia(media) || used + estimateDataUrlBytes(media) > budget) {
      resolved.set(target.encoded, undefined)
      replaceWithPlaceholder(image, options.unavailableLabel)
      continue
    }

    const dataUrl = dataUrlFromMediaValue(media.content, media.kind)
    resolved.set(target.encoded, dataUrl)
    if (!dataUrl) {
      replaceWithPlaceholder(image, options.unavailableLabel)
      continue
    }
    used += dataUrl.length * 2
    image.setAttribute("src", dataUrl)
  }

  return { html: template.innerHTML, references: [...new Set(references)].sort() }
}

function stripResourceSurfaces(root: DocumentFragment) {
  for (const element of Array.from(root.querySelectorAll("[srcset]"))) element.removeAttribute("srcset")
  for (const element of Array.from(root.querySelectorAll("[style]"))) element.removeAttribute("style")
  for (const element of Array.from(root.querySelectorAll(STRIPPED_ELEMENTS))) element.remove()
  for (const element of Array.from(root.querySelectorAll(SVG_RESOURCE_ELEMENTS))) element.remove()
  for (const element of Array.from(root.querySelectorAll("svg [href], svg [xlink\\:href]"))) {
    element.removeAttribute("href")
    element.removeAttribute("xlink:href")
  }
}

// Deterministic ids so same-document heading links resolve. The shared sanitizer
// prefixes surviving ids, so consumers match both the raw and prefixed forms.
function assignHeadingIds(root: DocumentFragment, registry?: Map<string, number>) {
  const counts = registry ?? new Map<string, number>()
  for (const heading of Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const base = headingSlug(heading.textContent ?? "")
    if (!base) continue
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    heading.setAttribute("id", seen === 0 ? base : `${base}-${seen}`)
  }
}

function headingSlug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}

async function resolveLocalMedia(path: string, file: PreviewFileApi, budget: number) {
  const kind = mediaKindFromPath(path)
  if (!kind) return

  // A rejected image is retried only when the current preview budget and the
  // cache (bytes and entry slots) can now hold its known footprint; otherwise
  // the read stays bounded and the placeholder stands.
  let state = file.get(path)
  const admission = state?.admission
  if (admission?.rejected) {
    if (admission.bytes > budget) return
    if (!canAdmitFileContent(path, admission.bytes)) return
  }
  if (!state?.content) {
    await file.load(path, { budget })
    state = file.get(path)
  }
  if (state?.admission?.rejected) return
  if (!state || state.error || !state.content) return

  return { content: state.content, kind }
}

function estimateDataUrlBytes(media: { content: FileContent; kind: MediaKind }) {
  const mime = normalizeMimeType(media.content.mimeType) ?? ""
  if (media.kind === "svg" && media.content.encoding !== "base64")
    return (`data:${mime};charset=utf-8,`.length + encodeURIComponent(media.content.content).length) * 2
  return (`data:${mime};base64,`.length + media.content.content.length) * 2
}

function isWellFormedMedia(media: { content: FileContent }) {
  if (media.content.encoding !== "base64") return true
  return isWellFormedBase64(media.content.content)
}

// Accepts provider base64 both padded and unpadded; only rejects impossible lengths
// (length % 4 === 1), out-of-range padding and non-alphabet characters.
function isWellFormedBase64(value: string) {
  if (value.length === 0 || value.length % 4 === 1) return false
  let end = value.length
  while (end > 0 && value[end - 1] === "=") end--
  if (end === 0 || value.length - end > 2) return false
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return false
  }
  return true
}

function replaceWithPlaceholder(image: Element, label: string) {
  const placeholder = image.ownerDocument.createElement("span")
  placeholder.setAttribute("data-file-preview-resource", "unavailable")
  placeholder.setAttribute("role", "img")
  const alt = image.getAttribute("alt")
  const text = alt && alt.length > 0 ? alt : label
  placeholder.setAttribute("aria-label", text)
  placeholder.textContent = text
  image.replaceWith(placeholder)
}
