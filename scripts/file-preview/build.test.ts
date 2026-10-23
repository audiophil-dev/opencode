import { expect, test } from "bun:test"
import path from "node:path"
import {
  BASE_COMMIT,
  EXPECTED_BUN,
  assertAbsolutePath,
  assertBaseHead,
  assertBunVersion,
  assertManifestComplete,
  assertNoCollision,
  assertNoTruthyRelease,
  assertNoUnrelatedChanges,
  computePatchId,
  isAllowedPath,
  isSupportedBun,
  patchedBuildId,
  patchedVersion,
  pendingUnstagedProductFiles,
  sanitizeChildEnv,
  type ManifestAsset,
} from "./build"

test("truthy release/credential env is rejected and stripped from the child env", () => {
  expect(() => assertNoTruthyRelease({ OPENCODE_RELEASE: "1" })).toThrow()
  expect(() => assertNoTruthyRelease({ OPENCODE_BUMP: "minor" })).toThrow()
  expect(() => assertNoTruthyRelease({ GH_REPO: "anomalyco/opencode" })).toThrow()
  expect(() => assertNoTruthyRelease({ GITHUB_TOKEN: "ghp_x" })).toThrow()
  expect(() => assertNoTruthyRelease({ OPENCODE_RELEASE: "0" })).not.toThrow()

  const cleaned = sanitizeChildEnv(
    {
      OPENCODE_RELEASE: "1",
      OPENCODE_BUMP: "minor",
      GH_REPO: "anomalyco/opencode",
      GITHUB_TOKEN: "ghp_x",
      GH_TOKEN: "ghp_y",
      ANTHROPIC_API_KEY: "sk-x",
      SENTRY_AUTH_TOKEN: "sntrys_x",
      PATH: "/usr/bin",
    },
    { OPENCODE_CHANNEL: "file-preview", OPENCODE_RELEASE: "0" },
  )
  expect(cleaned.OPENCODE_RELEASE).toBe("0")
  expect(cleaned.OPENCODE_BUMP).toBeUndefined()
  expect(cleaned.GH_REPO).toBeUndefined()
  expect(cleaned.GITHUB_TOKEN).toBeUndefined()
  expect(cleaned.GH_TOKEN).toBeUndefined()
  expect(cleaned.ANTHROPIC_API_KEY).toBeUndefined()
  expect(cleaned.SENTRY_AUTH_TOKEN).toBeUndefined()
  expect(cleaned.PATH).toBe("/usr/bin")
  expect(cleaned.OPENCODE_CHANNEL).toBe("file-preview")
})

test("missing or relative BIN-style path inputs are rejected", () => {
  expect(() => assertAbsolutePath(undefined, "BIN")).toThrow(/required/)
  expect(() => assertAbsolutePath("", "BIN")).toThrow(/required/)
  expect(() => assertAbsolutePath("builds/opencode", "BIN")).toThrow(/absolute/)
  expect(assertAbsolutePath(path.join(path.sep, "tmp", "opencode"), "BIN")).toBe(path.join(path.sep, "tmp", "opencode"))
})

test("untracked files outside the file-preview scope are refused", () => {
  expect(() =>
    assertNoUnrelatedChanges({
      staged: [],
      unstaged: [],
      untracked: ["packages/app/test-browser/zz-jsx-probe.test.tsx"],
    }),
  ).toThrow(/unrelated/)

  expect(() =>
    assertNoUnrelatedChanges({ staged: [], unstaged: ["packages/opencode/src/index.ts"], untracked: [] }),
  ).toThrow(/unrelated/)
})

test("in-scope staged/untracked files are accepted and pending ones are surfaced", () => {
  const changes = {
    staged: [".gitignore", "workspace/memory/core/project.md"],
    unstaged: [],
    untracked: [
      "packages/app/src/pages/session/file-preview-path.ts",
      "packages/app/e2e/file-preview/fixtures.ts",
      "scripts/file-preview/build.ts",
      "packages/app/playwright.file-preview.config.ts",
      "packages/app/test-browser/file-preview-markdown.test.tsx",
      "packages/session-ui/src/components/markdown.tsx",
    ],
  }
  assertNoUnrelatedChanges(changes)
  expect(isAllowedPath("packages/app/src/pages/session/file-preview.tsx")).toBe(true)
  const pending = pendingUnstagedProductFiles(changes)
  expect(pending).toContain("scripts/file-preview/build.ts")
  expect(pending).not.toContain("packages/app/public/file-preview-build.json")
})

test("reviewed task 7-9 product paths are allowed and the ephemeral QA config is excluded, not staged", () => {
  const allowed = [
    "packages/app/src/context/file/content-cache.ts",
    "packages/app/src/pages/session/file-tabs.tsx",
    "packages/app/src/pages/session/session-side-panel.tsx",
    "packages/session-ui/src/pierre/file-find.ts",
    "packages/session-ui/src/components/file.tsx",
    "packages/session-ui/src/components/file-search.tsx",
    "packages/app/test-browser/file-search-bar-portal.test.ts",
    "packages/app/src/i18n/en.ts",
    "packages/app/test-browser/file-preview.test.tsx",
    "packages/app/test-browser/file-tabs-preview-fixtures.tsx",
    "packages/app/test-browser/file-tabs-preview.test.tsx",
    "packages/app/test-browser/file-tabs-registration-fixture.tsx",
    "packages/app/test-browser/file-tabs-registration.test.tsx",
  ]
  for (const p of allowed) expect(isAllowedPath(p)).toBe(true)

  const ephemeral = "packages/app/e2e/performance/playwright.task8-bench.config.ts"
  assertNoUnrelatedChanges({ staged: [], unstaged: [], untracked: [ephemeral] })
  expect(pendingUnstagedProductFiles({ staged: [], unstaged: [], untracked: [ephemeral] })).toEqual([])
  expect(isAllowedPath(ephemeral)).toBe(false)
})

test("reviewed task 10 refresh paths are allowed exactly and adjacent unknown paths are refused", () => {
  const allowed = [
    "packages/app/src/context/file.tsx",
    "packages/app/src/context/file/types.ts",
    "packages/app/src/context/settings.tsx",
    "packages/app/src/context/file-content-eviction-accounting.test.ts",
    "packages/app/e2e/tsconfig.json",
    "packages/app/src/pages/session/session-layout.ts",
    "packages/app/src/pages/session/file-tab-reload-handoff.ts",
    "packages/app/src/pages/session/file-tab-reload-handoff.test.ts",
    "packages/app/test-browser/file-find-postrender.fixture.tsx",
    "packages/app/test-browser/file-find-postrender.test.ts",
    "packages/app/test-browser/file-preview-cache-admission.test.tsx",
  ]
  for (const p of allowed) expect(isAllowedPath(p)).toBe(true)

  for (const p of [
    "packages/app/src/context/file-system.ts",
    "packages/app/src/pages/session/file-tab-reload-handoff.v2.ts",
    "packages/app/test-browser/file-find-postrender.snapshot.tsx",
  ]) {
    expect(isAllowedPath(p)).toBe(false)
    expect(() => assertNoUnrelatedChanges({ staged: [], unstaged: [], untracked: [p] })).toThrow(/unrelated/)
  }
})

test("a HEAD that is not BASE is refused unless --allow-patched is set", () => {
  expect(() => assertBaseHead("deadbeef", BASE_COMMIT, false)).toThrow(/not BASE/)
  assertBaseHead("deadbeef", BASE_COMMIT, true)
  assertBaseHead(BASE_COMMIT, BASE_COMMIT, false)
})

test("build-id collisions cannot overwrite a different artifact", () => {
  assertNoCollision(null, { buildId: "b", executableSha256: "a" })
  assertNoCollision({ buildId: "b", executableSha256: "a" }, { buildId: "b", executableSha256: "a" })
  expect(() =>
    assertNoCollision({ buildId: "b", executableSha256: "a" }, { buildId: "b", executableSha256: "c" }),
  ).toThrow(/refusing to overwrite/)
  expect(() =>
    assertNoCollision({ buildId: "b", executableSha256: "a" }, { buildId: "c", executableSha256: "a" }),
  ).toThrow(/build id/)
})

test("manifest completeness fails on an incomplete asset set", () => {
  const complete: ManifestAsset[] = [
    { path: "index.html", sha256: "x", bytes: 1 },
    { path: "assets/app.js", sha256: "y", bytes: 2 },
  ]
  expect(() => assertManifestComplete(["index.html", "assets/app.js"], [complete[0]])).toThrow(/missing/)
  assertManifestComplete(["index.html", "assets/app.js"], complete)
})

test("bun version guard accepts 1.3.14 (and its canary) and rejects others", () => {
  assertBunVersion(EXPECTED_BUN)
  assertBunVersion("1.3.14-canary.1")
  expect(() => assertBunVersion("1.3.13")).toThrow(/bun@/)
  expect(() => assertBunVersion("1.4.0")).toThrow()
  expect(isSupportedBun("1.3.15")).toBe(false)
})

test("patch id is a stable short hash of the staged diff", () => {
  const diff = "diff --git a/x b/x\n+hello\n"
  const id = computePatchId(diff)
  expect(id).toHaveLength(12)
  expect(computePatchId(diff)).toBe(id)
  expect(computePatchId(`${diff} `)).not.toBe(id)
  expect(patchedBuildId(id)).toBe(`file-preview-1.19.3-g${id}`)
  expect(patchedVersion(id)).toBe(`1.19.3-file-preview.g${id}`)
})
