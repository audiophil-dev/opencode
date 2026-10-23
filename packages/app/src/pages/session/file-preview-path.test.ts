import { describe, expect, mock, test } from "bun:test"
import { createPathHelpers } from "../../context/file/path"
import { openSessionTab } from "../../context/layout-tabs"
import { resolveFilePreviewTarget, type FilePreviewBlockedReason, type FilePreviewTarget } from "./file-preview-path"

const localCases: Array<{ name: string; document: string; href: string; path: string; encoded: string }> = [
  {
    name: "resolves a sibling file",
    document: "docs/guide/intro.md",
    href: "images/a.png",
    path: "docs/guide/images/a.png",
    encoded: "docs/guide/images/a.png",
  },
  {
    name: "ascends to a parent directory inside the workspace",
    document: "docs/guide/intro.md",
    href: "../assets/a.png",
    path: "docs/assets/a.png",
    encoded: "docs/assets/a.png",
  },
  {
    name: "collapses dot segments and empty segments",
    document: "docs/a.md",
    href: "./x//y.png",
    path: "docs/x/y.png",
    encoded: "docs/x/y.png",
  },
  {
    name: "resolves a leading slash from the workspace root",
    document: "docs/a.md",
    href: "/images/logo.png",
    path: "images/logo.png",
    encoded: "images/logo.png",
  },
  {
    name: "lets a root-relative path ascend without leaving the root",
    document: "docs/a.md",
    href: "/docs/../img/x.png",
    path: "img/x.png",
    encoded: "img/x.png",
  },
  {
    name: "round-trips spaces and Unicode",
    document: "docs/a.md",
    href: "a%20b/%C3%BCber.png",
    path: "docs/a b/über.png",
    encoded: "docs/a%20b/%C3%BCber.png",
  },
  {
    name: "strips query and fragment before resolving",
    document: "docs/a.md",
    href: "img/a.png?raw=1#L3",
    path: "docs/img/a.png",
    encoded: "docs/img/a.png",
  },
  {
    name: "keeps encoded literal URI syntax in a filename",
    document: "docs/a.md",
    href: "a%3Fb%23c.png",
    path: "docs/a?b#c.png",
    encoded: "docs/a%3Fb%23c.png",
  },
  {
    name: "does not confuse a sibling prefix with a parent directory",
    document: "docs/notes.md",
    href: "../docs-other/x.png",
    path: "docs-other/x.png",
    encoded: "docs-other/x.png",
  },
  {
    name: "resolves two levels up inside a deeper tree",
    document: "a/b/c/d.md",
    href: "../../x.png",
    path: "a/x.png",
    encoded: "a/x.png",
  },
]

const blockedCases: Array<{ name: string; document: string; href: string; reason: FilePreviewBlockedReason }> = [
  { name: "empty href", document: "docs/a.md", href: "", reason: "empty" },
  { name: "query-only href", document: "docs/a.md", href: "?raw=1", reason: "empty" },
  { name: "workspace root", document: "docs/a.md", href: "/", reason: "empty" },
  { name: "NUL byte", document: "docs/a.md", href: "a\0b.png", reason: "nul" },
  { name: "backslash path", document: "docs/a.md", href: "..\\secret.png", reason: "windows-path" },
  { name: "UNC path", document: "docs/a.md", href: "\\\\server\\share\\x.png", reason: "windows-path" },
  { name: "drive-letter path", document: "docs/a.md", href: "C:/Windows/x.png", reason: "drive-letter" },
  {
    name: "encoded forward slash",
    document: "docs/a.md",
    href: "docs%2Fsecret.png",
    reason: "encoded-separator",
  },
  {
    name: "encoded backslash",
    document: "docs/a.md",
    href: "docs%5Csecret.png",
    reason: "encoded-separator",
  },
  { name: "encoded dots", document: "docs/a.md", href: "%2e%2e/secret.png", reason: "encoded-dot" },
  { name: "uppercase encoded dots", document: "docs/a.md", href: "%2E%2E/secret.png", reason: "encoded-dot" },
  {
    name: "double-encoded traversal",
    document: "docs/a.md",
    href: "%252e%252e/secret.png",
    reason: "double-encoding",
  },
  { name: "double-encoded slash", document: "docs/a.md", href: "a%252fb.png", reason: "double-encoding" },
  { name: "malformed percent (short)", document: "docs/a.md", href: "bad%2.png", reason: "malformed-encoding" },
  { name: "malformed percent (non-hex)", document: "docs/a.md", href: "bad%zz.png", reason: "malformed-encoding" },
  { name: "malformed trailing percent", document: "docs/a.md", href: "bad%", reason: "malformed-encoding" },
  {
    name: "invalid UTF-8 lone surrogate escape",
    document: "docs/a.md",
    href: "bad%ED%A0%80.png",
    reason: "malformed-encoding",
  },
  {
    name: "invalid UTF-8 truncated multibyte escape",
    document: "docs/a.md",
    href: "bad%C3%28.png",
    reason: "malformed-encoding",
  },
  {
    name: "invalid UTF-8 out-of-range byte escape",
    document: "docs/a.md",
    href: "bad%FF.png",
    reason: "malformed-encoding",
  },
  {
    name: "invalid UTF-8 lone continuation byte escape",
    document: "docs/a.md",
    href: "bad%80.png",
    reason: "malformed-encoding",
  },
  {
    name: "escape above the workspace",
    document: "docs/guide/a.md",
    href: "../../../outside.png",
    reason: "escape",
  },
  { name: "root-relative escape", document: "docs/a.md", href: "/../outside.png", reason: "escape" },
  { name: "javascript scheme", document: "docs/a.md", href: "javascript:alert(1)", reason: "blocked-scheme" },
  {
    name: "mixed-case javascript scheme",
    document: "docs/a.md",
    href: "JaVaScRiPt:alert(1)",
    reason: "blocked-scheme",
  },
  { name: "vbscript scheme", document: "docs/a.md", href: "vbscript:msgbox(1)", reason: "blocked-scheme" },
  { name: "data scheme", document: "docs/a.md", href: "data:text/html,<p>x</p>", reason: "blocked-scheme" },
  { name: "file scheme", document: "docs/a.md", href: "file:///etc/passwd", reason: "blocked-scheme" },
  { name: "unknown scheme", document: "docs/a.md", href: "ftp://example.com/x.png", reason: "blocked-scheme" },
]

describe("resolveFilePreviewTarget", () => {
  for (const item of localCases) {
    test(`local: ${item.name}`, () => {
      expect(resolveFilePreviewTarget(item.document, item.href)).toEqual({
        kind: "local",
        path: item.path,
        encoded: item.encoded,
        tab: `file://${item.encoded}`,
      })
    })
  }

  test("treats a same-document heading fragment as an anchor", () => {
    expect(resolveFilePreviewTarget("docs/a.md", "#section-2")).toEqual({
      kind: "anchor",
      fragment: "section-2",
    })
    expect(resolveFilePreviewTarget("docs/a.md", "#")).toEqual({ kind: "anchor", fragment: "" })
    expect(resolveFilePreviewTarget("docs/a.md", "#a%20b")).toEqual({ kind: "anchor", fragment: "a%20b" })
  })

  test("keeps http, https and mailto links external", () => {
    expect(resolveFilePreviewTarget("docs/a.md", "https://example.com/a b.png?x=1")).toEqual({
      kind: "external",
      url: "https://example.com/a b.png?x=1",
    })
    expect(resolveFilePreviewTarget("docs/a.md", "http://example.com")).toEqual({
      kind: "external",
      url: "http://example.com",
    })
    expect(resolveFilePreviewTarget("docs/a.md", "HTTPS://example.com/x")).toEqual({
      kind: "external",
      url: "HTTPS://example.com/x",
    })
    expect(resolveFilePreviewTarget("docs/a.md", "mailto:someone@example.com")).toEqual({
      kind: "external",
      url: "mailto:someone@example.com",
    })
  })

  test("treats a scheme-relative URL as external", () => {
    expect(resolveFilePreviewTarget("docs/a.md", "//cdn.example.com/x.png")).toEqual({
      kind: "external",
      url: "//cdn.example.com/x.png",
    })
  })

  for (const item of blockedCases) {
    test(`blocked: ${item.name}`, () => {
      expect(resolveFilePreviewTarget(item.document, item.href)).toEqual({
        kind: "blocked",
        reason: item.reason,
      })
    })
  }

  test("returns unsupported when the tab normalizer cannot round-trip the path", () => {
    expect(resolveFilePreviewTarget("docs/a.md", "/%22quoted%22")).toEqual({
      kind: "unsupported",
      path: '"quoted"',
      reason: "tab-round-trip",
    })
  })

  test("round-trips through the real file helpers and tab opening", () => {
    const file = createPathHelpers(() => "/repo")
    const target = resolveFilePreviewTarget("docs/guide/intro.md", "../a%20b/%C3%BCber.png")
    if (target.kind !== "local") throw new Error(`expected local, got ${target.kind}`)

    // file.load normalizes the path before the API call.
    expect(file.normalize(target.path)).toBe("docs/a b/über.png")
    expect(file.pathFromTab(target.tab)).toBe(target.path)
    expect(file.tab(target.path)).toBe(target.tab)

    const tabs = openSessionTab({ tabs: { all: [] } }, target.tab)
    expect(tabs.tabs.active).toBe(target.tab)
    expect(file.pathFromTab(tabs.tabs.active!)).toBe(target.path)
  })
})

describe("denied targets never load or open", () => {
  const consume = (document: string, href: string) => {
    const load = mock((_path: string) => {})
    const open = mock((_tab: string) => {})
    const target: FilePreviewTarget = resolveFilePreviewTarget(document, href)
    if (target.kind === "local") {
      load(target.path)
      open(target.tab)
    }
    return { target, load, open }
  }

  const denied: Array<{ name: string; document: string; href: string; kind: FilePreviewTarget["kind"] }> = [
    ...blockedCases.map((item) => ({ ...item, kind: "blocked" as const })),
    {
      name: "unsupported tab round-trip",
      document: "docs/a.md",
      href: "/%22quoted%22",
      kind: "unsupported",
    },
    { name: "same-document anchor", document: "docs/a.md", href: "#heading", kind: "anchor" },
    { name: "external link", document: "docs/a.md", href: "https://example.com", kind: "external" },
    { name: "scheme-relative link", document: "docs/a.md", href: "//example.com/x", kind: "external" },
  ]

  for (const item of denied) {
    test(`${item.kind}: ${item.name}`, () => {
      const result = consume(item.document, item.href)
      expect(result.target.kind).toBe(item.kind)
      expect(result.load).not.toHaveBeenCalled()
      expect(result.open).not.toHaveBeenCalled()
      expect(result.load.mock.calls).toHaveLength(0)
      expect(result.open.mock.calls).toHaveLength(0)
    })
  }
})
