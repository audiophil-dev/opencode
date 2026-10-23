import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { prepareFilePreview } from "./file-preview-frontmatter"

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const lf = (...lines: string[]) => lines.join("\n")
const crlf = (...lines: string[]) => lines.join("\r\n")

type Case = { name: string; source: string; text: string; hasFrontmatter: boolean }

const cases: Case[] = [
  {
    name: "LF header and body",
    source: lf("---", "name: demo", "tags: [a, b]", "---", "# Body", "", "Text", ""),
    text: lf("```yaml", "name: demo", "tags: [a, b]", "```", "# Body", "", "Text", ""),
    hasFrontmatter: true,
  },
  {
    name: "CRLF header and body keep CRLF",
    source: crlf("---", "name: demo", "---", "# Body", ""),
    text: crlf("```yaml", "name: demo", "```", "# Body", ""),
    hasFrontmatter: true,
  },
  {
    name: "leading BOM is recognized and not part of the body",
    source: "\uFEFF" + lf("---", "name: demo", "---", "body", ""),
    text: lf("```yaml", "name: demo", "```", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "empty metadata renders an empty fenced block",
    source: lf("---", "---", "body", ""),
    text: lf("```yaml", "```", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "dot-dot-dot closure is accepted",
    source: lf("---", "name: demo", "...", "body", ""),
    text: lf("```yaml", "name: demo", "```", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "backticks inside metadata widen the fence",
    source: lf("---", "desc: a ``` b", "---", "body", ""),
    text: lf("````yaml", "desc: a ``` b", "````", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "tildes inside metadata widen the fence",
    source: lf("---", "desc: a ~~~ b", "---", "body", ""),
    text: lf("````yaml", "desc: a ~~~ b", "````", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "script payload stays verbatim inside the fence",
    source: lf("---", "desc: <script>alert(1)</script>", "---", "body", ""),
    text: lf("```yaml", "desc: <script>alert(1)</script>", "```", "body", ""),
    hasFrontmatter: true,
  },
  {
    name: "unclosed header passes through",
    source: lf("---", "name: demo", "# Body", ""),
    text: lf("---", "name: demo", "# Body", ""),
    hasFrontmatter: false,
  },
  {
    name: "later horizontal rule in the body passes through",
    source: lf("# Title", "", "---", "", "text", ""),
    text: lf("# Title", "", "---", "", "text", ""),
    hasFrontmatter: false,
  },
  {
    name: "UTF-8 multibyte body is preserved",
    source: lf("---", "title: café", "---", "Héllo — 日本語 body 🎉", ""),
    text: lf("```yaml", "title: café", "```", "Héllo — 日本語 body 🎉", ""),
    hasFrontmatter: true,
  },
  {
    name: "realistic skill-style header renders and keeps the body",
    source: lf(
      "---",
      "name: writing-baseline",
      "description: Mandatory writing rules",
      "---",
      "",
      "# Heading",
      "",
      "Body paragraph.",
      "",
    ),
    text: lf(
      "```yaml",
      "name: writing-baseline",
      "description: Mandatory writing rules",
      "```",
      "",
      "# Heading",
      "",
      "Body paragraph.",
      "",
    ),
    hasFrontmatter: true,
  },
]

describe("prepareFilePreview", () => {
  for (const item of cases) {
    test(item.name, () => {
      const before = sha(item.source)
      const result = prepareFilePreview(item.source)
      expect(sha(item.source)).toBe(before)
      expect(result.hasFrontmatter).toBe(item.hasFrontmatter)
      expect(result.text).toBe(item.text)
    })
  }
})

describe("prefix fence selection", () => {
  test("fence is strictly longer than a backtick run in the header", () => {
    const runs = "`".repeat(5)
    const source = lf("---", `value: ${runs}`, "---", "body", "")
    const before = sha(source)
    const result = prepareFilePreview(source)
    expect(sha(source)).toBe(before)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.text.match(/^`+/)?.[0].length ?? 0).toBeGreaterThan(runs.length)
  })

  test("fence is strictly longer than a tilde run in the header", () => {
    const runs = "~".repeat(5)
    const source = lf("---", `value: ${runs}`, "---", "body", "")
    const before = sha(source)
    const result = prepareFilePreview(source)
    expect(sha(source)).toBe(before)
    expect(result.hasFrontmatter).toBe(true)
    expect(result.text.match(/^`+/)?.[0].length ?? 0).toBeGreaterThan(runs.length)
  })
})
