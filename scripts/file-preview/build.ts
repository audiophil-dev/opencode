#!/usr/bin/env bun
/**
 * Guarded packaging wrapper for the identified file-preview build.
 *
 * The wrapper does not reimplement web embedding; it drives the upstream
 * `packages/opencode/script/build.ts` (which builds the app, embeds `app/dist`
 * and compiles the executable) under a verified, explicitly identified,
 * non-publishing environment and stages the result under an immutable build id.
 *
 * Modes:
 *   (default)  patched build from the current source tree; identity derives from
 *              the staged patch (build id `file-preview-1.19.3-g<patch-id>`).
 *   --base     unpatched BASE comparison build from a clean `git archive BASE`
 *              tree; neutral identity, build id `base-e3c4eb2`.
 *
 * The pure guard functions below are unit-tested by build.test.ts and are the
 * only thing the tests touch (main body runs only when executed directly).
 */
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export const BASE_COMMIT = "e3c4eb242585dcd77be1a867391b7c25fd47ce52"
export const EXPECTED_BUN = "1.3.14"
export const CUSTOM_CHANNEL = "file-preview"
export const CUSTOM_VERSION_BASE = "1.19.3-file-preview"
export const BASE_BUILD_ID = "base-e3c4eb2"

const DEFAULT_PROJECT_ROOT = "/home/audiophil/Projects/running/opencode-file-preview"

/** Keys that must never reach the build child: publishing / credential inputs. */
const FORBIDDEN_EXACT = ["OPENCODE_RELEASE", "OPENCODE_BUMP", "GH_REPO", "GITHUB_TOKEN"]
const FORBIDDEN_SUFFIX = /(_API_KEY|_TOKEN|_SECRET)$/i
const FORBIDDEN_PREFIX = [/^SENTRY_/]

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

export function isTruthy(value: string | undefined | null): boolean {
  return value !== undefined && value !== null && value !== "" && value !== "0"
}

export function isSupportedBun(version: string): boolean {
  return version === EXPECTED_BUN || version.startsWith(`${EXPECTED_BUN}-`)
}

export function assertBunVersion(version: string): void {
  if (!isSupportedBun(version)) throw new Error(`this build requires bun@${EXPECTED_BUN}, got bun@${version}`)
}

/**
 * Build the child environment: inherit the ambient env minus everything that
 * could re-enable release/publishing or leak credentials, then apply the
 * explicit overrides. Never sets a truthy placeholder for a forbidden key.
 */
export function sanitizeChildEnv(
  env: Record<string, string | undefined>,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (FORBIDDEN_EXACT.includes(key)) continue
    if (FORBIDDEN_SUFFIX.test(key)) continue
    if (FORBIDDEN_PREFIX.some((re) => re.test(key))) continue
    out[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) out[key] = value
  return out
}

/** Fail closed if the effective child environment still carries a release flag. */
export function assertNoTruthyRelease(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!isTruthy(value)) continue
    if (FORBIDDEN_EXACT.includes(key)) throw new Error(`forbidden release env ${key} is truthy in build child`)
    if (FORBIDDEN_SUFFIX.test(key)) throw new Error(`forbidden credential env ${key} is present in build child`)
    if (FORBIDDEN_PREFIX.some((re) => re.test(key))) throw new Error(`forbidden env ${key} is present in build child`)
  }
}

export function assertAbsolutePath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`)
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path, got ${JSON.stringify(value)}`)
  return value
}

export function assertBaseHead(head: string, base: string, allowPatched: boolean): void {
  if (allowPatched) return
  if (head !== base) {
    throw new Error(`HEAD ${head} is not BASE ${base}; pass --allow-patched for a post-patch build`)
  }
}

export interface TreeChanges {
  staged: string[]
  unstaged: string[]
  untracked: string[]
}

// Paths this feature is allowed to touch while other workers are in flight: the reviewed task 3-9 product/patch surface.
const ALLOWED_EXACT_PATHS = new Set([
  ".gitignore",
  "handover.md",
  "packages/app/playwright.file-preview.config.ts",
  "packages/app/test-browser/file-preview-markdown.test.tsx",
  "packages/app/test-browser/file-preview.test.tsx",
  "packages/app/test-browser/file-tabs-preview-fixtures.tsx",
  "packages/app/test-browser/file-tabs-preview.test.tsx",
  "packages/app/test-browser/file-tabs-registration-fixture.tsx",
  "packages/app/test-browser/file-tabs-registration.test.tsx",
  "packages/app/src/context/file/content-cache.ts",
  "packages/app/src/pages/session/file-tabs.tsx",
  "packages/app/src/pages/session/session-side-panel.tsx",
  "packages/session-ui/src/components/file-search.tsx",
  "packages/session-ui/src/components/file.tsx",
  "packages/session-ui/src/components/markdown.tsx",
  "packages/session-ui/src/pierre/file-find.ts",
  "packages/app/test-browser/file-search-bar-portal.test.ts",
  // reviewed task 10 refresh: exact new source/test/setup paths from tasks 7-9 and 11
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
  // wrapper-generated, git-ignored by intent
  "packages/app/public/file-preview-build.json",
])
const ALLOWED_PREFIX_PATHS = [
  "workspace/memory/",
  "packages/app/e2e/file-preview/",
  "packages/app/src/i18n/",
  "packages/app/src/pages/session/file-preview",
  "scripts/file-preview/",
]
const GENERATED_PATHS = new Set(["packages/app/public/file-preview-build.json"])

/**
 * Ephemeral, non-product QA paths that are deliberately excluded from build
 * identity rather than staged or deleted (task 8's disposable benchmark config).
 * They are known paths, not a hole: any other unknown path is still rejected.
 */
const EXCLUDED_PATHS = new Set(["packages/app/e2e/performance/playwright.task8-bench.config.ts"])

export function isAllowedPath(p: string): boolean {
  if (ALLOWED_EXACT_PATHS.has(p)) return true
  return ALLOWED_PREFIX_PATHS.some((prefix) => p.startsWith(prefix))
}

/** Refuse any working-tree change outside the declared file-preview scope. */
export function assertNoUnrelatedChanges(changes: TreeChanges): void {
  const offenders: string[] = []
  for (const kind of ["staged", "unstaged", "untracked"] as const) {
    for (const p of changes[kind]) {
      if (EXCLUDED_PATHS.has(p)) continue
      if (!isAllowedPath(p)) offenders.push(`${kind}: ${p}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(`unrelated working-tree changes are outside the file-preview scope:\n  ${offenders.join("\n  ")}`)
  }
}

/**
 * Allowed product files that are not staged. They would be silently absent from
 * the staged patch id, so a patched build must refuse until they are staged
 * (untracked files must never be silently omitted from build identity).
 */
export function pendingUnstagedProductFiles(changes: TreeChanges): string[] {
  return [...changes.untracked, ...changes.unstaged]
    .filter((p) => !EXCLUDED_PATHS.has(p) && isAllowedPath(p) && !GENERATED_PATHS.has(p))
    .sort()
}

export function computePatchId(stagedDiff: string): string {
  return createHash("sha256").update(stagedDiff).digest("hex").slice(0, 12)
}

export function patchedBuildId(patchIdShort: string): string {
  return `file-preview-1.19.3-g${patchIdShort}`
}

export function patchedVersion(patchIdShort: string): string {
  return `${CUSTOM_VERSION_BASE}.g${patchIdShort}`
}

export interface StagedArtifactIdentity {
  buildId: string
  executableSha256: string
}

/** Refuse to overwrite a different artifact that already owns an immutable id. */
export function assertNoCollision(existing: StagedArtifactIdentity | null, incoming: StagedArtifactIdentity): void {
  if (!existing) return
  if (existing.buildId !== incoming.buildId) {
    throw new Error(`existing manifest build id ${existing.buildId} != ${incoming.buildId}`)
  }
  if (existing.executableSha256 !== incoming.executableSha256) {
    throw new Error(
      `refusing to overwrite ${incoming.buildId}: existing executable sha256 ${existing.executableSha256} != ${incoming.executableSha256}`,
    )
  }
}

export interface ManifestAsset {
  path: string
  sha256: string
  bytes: number
}

/** Fail if the manifest does not cover every expected embedded asset. */
export function assertManifestComplete(expectedPaths: string[], assets: ManifestAsset[]): void {
  const have = new Set(assets.map((a) => a.path))
  const missing = expectedPaths.filter((p) => !have.has(p))
  if (missing.length > 0) {
    throw new Error(`manifest is missing ${missing.length} embedded asset(s): ${missing.slice(0, 10).join(", ")}`)
  }
}

// ---------------------------------------------------------------------------
// Impure orchestration (runs only when this file is executed directly)
// ---------------------------------------------------------------------------

interface Options {
  mode: "base" | "patched"
  allowPatched: boolean
  allowInflight: boolean
  keepTemp: boolean
  sourceRoot: string
  projectRoot: string
  outRoot: string
  tmpRoot: string
  modelsJson: string
}

const DEFAULT_MODELS_JSON = "/home/audiophil/.cache/opencode/models.json"

function timestamp(): string {
  return new Date().toISOString()
}

function log(...args: unknown[]): void {
  console.log(`[${timestamp()}]`, ...args)
}

export function parseArgs(argv: string[]): Options {
  const mode = argv.includes("--base") ? "base" : "patched"
  const projectRoot = process.env.FILE_PREVIEW_PROJECT_ROOT ?? DEFAULT_PROJECT_ROOT
  return {
    mode,
    allowPatched: argv.includes("--allow-patched"),
    allowInflight: argv.includes("--allow-inflight"),
    keepTemp: argv.includes("--keep-temp"),
    sourceRoot: process.env.FILE_PREVIEW_SOURCE_ROOT ?? process.cwd(),
    projectRoot,
    outRoot: process.env.FILE_PREVIEW_BUILD_ROOT ?? path.join(projectRoot, "builds"),
    tmpRoot: process.env.FILE_PREVIEW_TMP_ROOT ?? path.join(path.dirname(projectRoot), ".file-preview-build-tmp"),
    modelsJson: process.env.FILE_PREVIEW_MODELS_JSON ?? process.env.MODELS_DEV_API_JSON ?? DEFAULT_MODELS_JSON,
  }
}

async function runCommand(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; label: string },
): Promise<number> {
  log(`$ ${cmd.join(" ")}   [cwd=${opts.cwd}] (${opts.label})`)
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  log(`exit ${code} <- ${opts.label}`)
  return code
}

async function runCaptured(cmd: string[], opts: { cwd: string; env: Record<string, string> }): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "inherit" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

async function git(sourceRoot: string, args: string[], label: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", sourceRoot, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")} (${label}) failed: ${err.trim()}`)
  return out
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex")
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
  return { sha256: sha256(buf), bytes: buf.byteLength }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(path.relative(root, full).replaceAll("\\", "/"))
    }
  }
  await walk(root)
  return out.sort()
}

async function assertNoDotenv(buildRoot: string): Promise<void> {
  const dirs = [buildRoot, path.join(buildRoot, "packages/app"), path.join(buildRoot, "packages/opencode")]
  const names = [".env", ".env.local", ".env.production", ".env.development", ".env.defaults"]
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (await Bun.file(file).exists()) {
        throw new Error(`refusing build: dotenv file ${file} could reintroduce release flags via autoload`)
      }
    }
  }
}

const ENV_PROBE = `process.stdout.write(JSON.stringify({
  release: process.env.OPENCODE_RELEASE ?? null,
  bump: process.env.OPENCODE_BUMP ?? null,
  ghRepo: process.env.GH_REPO ?? null,
  ghToken: !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
  sensitive: Object.keys(process.env).filter((k) => /(_API_KEY|_TOKEN|_SECRET)$/i.test(k) || /^SENTRY_/.test(k)),
}))`

async function probeAndAssertEnv(env: Record<string, string>, cwd: string, when: string): Promise<void> {
  const out = await runCaptured(["bun", "-e", ENV_PROBE], { cwd, env })
  const parsed = JSON.parse(out) as {
    release: string | null
    bump: string | null
    ghRepo: string | null
    ghToken: boolean
    sensitive: string[]
  }
  assertNoTruthyRelease({
    OPENCODE_RELEASE: parsed.release ?? undefined,
    OPENCODE_BUMP: parsed.bump ?? undefined,
    GH_REPO: parsed.ghRepo ?? undefined,
  })
  if (parsed.ghToken) throw new Error(`GITHUB/GH token present in effective child env (${when})`)
  if (parsed.sensitive.length > 0) {
    throw new Error(`sensitive env in effective child env (${when}): ${parsed.sensitive.join(", ")}`)
  }
  log(`env probe (${when}) clean: release=${parsed.release} bump=${parsed.bump} ghRepo=${parsed.ghRepo}`)
}

interface BuiltPackage {
  name: string
  dir: string
  bin: string
  meta: { os?: string[]; cpu?: string[]; libc?: string[]; version?: string }
}

async function locateBuiltPackage(buildRoot: string): Promise<BuiltPackage> {
  const distDir = path.join(buildRoot, "packages/opencode/dist")
  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(distDir, entry.name)
    const metaFile = path.join(dir, "package.json")
    if (!(await Bun.file(metaFile).exists())) continue
    const meta = (await Bun.file(metaFile).json()) as BuiltPackage["meta"]
    if (!meta.os?.includes(process.platform) || !meta.cpu?.includes(process.arch)) continue
    if (meta.libc && !meta.libc.includes("glibc")) continue
    const bin = path.join(dir, "bin/opencode")
    if (!(await Bun.file(bin).exists())) continue
    return { name: entry.name, dir, bin, meta }
  }
  throw new Error(`no built package matching ${process.platform}/${process.arch} found under ${distDir}`)
}

interface Manifest {
  schema: string
  buildId: string
  mode: "base" | "patched"
  channel: string
  version: string | null
  baselineCommit: string
  patchId: string | null
  patchIdShort: string | null
  bun: string
  platform: { os: string; arch: string }
  createdAt: string
  executable: { path: string; sha256: string; bytes: number }
  served: { identityJson: ManifestAsset; indexHtml: ManifestAsset }
  dist: { root: string; assetCount: number; assets: ManifestAsset[] }
  versionOutput: string
  versionIsCustomIdentity: boolean
}

async function writeIdentityJson(appPublicDir: string, payload: Record<string, unknown>): Promise<string> {
  await fs.mkdir(appPublicDir, { recursive: true })
  const file = path.join(appPublicDir, "file-preview-build.json")
  await Bun.write(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  log(`file-preview build wrapper: mode=${opts.mode} sourceRoot=${opts.sourceRoot} outRoot=${opts.outRoot}`)

  assertAbsolutePath(opts.sourceRoot, "SOURCE_ROOT")
  assertAbsolutePath(opts.projectRoot, "PROJECT_ROOT")
  assertAbsolutePath(opts.outRoot, "BUILD_ROOT")
  assertBunVersion(process.versions.bun)
  assertAbsolutePath(opts.modelsJson, "MODELS_DEV_API_JSON")
  if (
    !(await fs
      .stat(opts.modelsJson)
      .then(() => true)
      .catch(() => false))
  ) {
    throw new Error(
      `local models.dev snapshot not found at ${opts.modelsJson}; refusing to build (the build would fetch it over the network)`,
    )
  }
  await fs.mkdir(opts.tmpRoot, { recursive: true, mode: 0o700 })

  // Guard (a): base ancestry / explicit patched opt-in.
  const head = (await git(opts.sourceRoot, ["rev-parse", "HEAD"], "head")).trim()
  const base = (await git(opts.sourceRoot, ["rev-parse", `${BASE_COMMIT}^{commit}`], "base")).trim()
  if (base !== BASE_COMMIT) throw new Error(`BASE does not resolve to ${BASE_COMMIT} (got ${base})`)
  assertBaseHead(head, base, opts.allowPatched)
  log(`base ancestry ok: HEAD=${head} BASE=${base} allowPatched=${opts.allowPatched}`)

  let buildId: string
  let channel: string
  let version: string | null
  let patchIdShort: string | null
  let buildRoot: string
  let tempTree: string | null = null

  if (opts.mode === "patched") {
    // Guard (c): scope and staging.
    const changes: TreeChanges = {
      staged: (await git(opts.sourceRoot, ["diff", "--cached", "--name-only"], "staged")).split("\n").filter(Boolean),
      unstaged: (await git(opts.sourceRoot, ["diff", "--name-only"], "unstaged")).split("\n").filter(Boolean),
      untracked: (await git(opts.sourceRoot, ["ls-files", "--others", "--exclude-standard"], "untracked"))
        .split("\n")
        .filter(Boolean),
    }
    assertNoUnrelatedChanges(changes)
    const pending = pendingUnstagedProductFiles(changes)
    if (pending.length > 0 && !opts.allowInflight) {
      throw new Error(
        `refusing patched build: ${pending.length} in-scope product file(s) are not staged and would be omitted from the patch id:\n  ${pending.join("\n  ")}\nstage them (or pass --allow-inflight to record them as pending)`,
      )
    }
    if (pending.length > 0)
      log(`WARNING: proceeding with ${pending.length} unstaged in-scope product file(s): ${pending.join(", ")}`)

    // Guard (d): stable patch id over the staged diff.
    const stagedDiff = await git(opts.sourceRoot, ["diff", "--cached"], "staged-diff")
    patchIdShort = computePatchId(stagedDiff)
    buildId = patchedBuildId(patchIdShort)
    channel = CUSTOM_CHANNEL
    version = patchedVersion(patchIdShort)
    buildRoot = opts.sourceRoot
    log(`patch id ${patchIdShort} -> build id ${buildId}`)
  } else {
    buildId = BASE_BUILD_ID
    channel = "dev"
    version = null
    patchIdShort = null
    tempTree = await fs.mkdtemp(
      path.join(opts.tmpRoot.endsWith(path.sep) ? opts.tmpRoot : `${opts.tmpRoot}${path.sep}`, "base-"),
    )
    await fs.chmod(tempTree, 0o700)
    buildRoot = tempTree
    log(`extracting BASE archive ${BASE_COMMIT} -> ${buildRoot}`)
    const gzip = Bun.spawn(["git", "-C", opts.sourceRoot, "archive", "--format=tar", BASE_COMMIT], {
      stdout: "pipe",
      stderr: "inherit",
    })
    const tar = Bun.spawn(["tar", "-x", "-C", buildRoot], { stdin: gzip.stdout, stdout: "inherit", stderr: "inherit" })
    const [gitCode, tarCode] = [await gzip.exited, await tar.exited]
    log(`exit ${gitCode} <- git archive; exit ${tarCode} <- tar extract`)
    if (gitCode !== 0 || tarCode !== 0)
      throw new Error(`BASE archive extraction failed (git=${gitCode} tar=${tarCode})`)
  }

  const envRoot = await fs.mkdtemp(path.join(opts.tmpRoot, "env-"))
  await fs.chmod(envRoot, 0o700)
  const home = path.join(envRoot, "home")
  const xdg = {
    XDG_CONFIG_HOME: path.join(envRoot, "config"),
    XDG_DATA_HOME: path.join(envRoot, "data"),
    XDG_STATE_HOME: path.join(envRoot, "state"),
    XDG_CACHE_HOME: path.join(envRoot, "cache"),
    TMPDIR: path.join(envRoot, "tmp"),
  }
  for (const dir of [home, ...Object.values(xdg)]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  }
  // Reuse the shared package cache (a cache, not state) to avoid re-downloading identical deps.
  const bunCache = process.env.FILE_PREVIEW_BUN_CACHE ?? path.join(process.env.HOME ?? "", ".bun/install/cache")
  const cacheEnv = (await fs
    .stat(bunCache)
    .then(() => true)
    .catch(() => false))
    ? { BUN_INSTALL_CACHE_DIR: bunCache }
    : {}
  const isolatedEnv: Record<string, string> = { HOME: home, ...xdg, ...cacheEnv }

  const identityOverrides: Record<string, string> = {
    ...isolatedEnv,
    OPENCODE_CHANNEL: channel,
    VITE_FILE_PREVIEW_BUILD_ID: buildId,
    MODELS_DEV_API_JSON: opts.modelsJson,
  }
  if (version) identityOverrides.OPENCODE_VERSION = version

  await assertNoDotenv(buildRoot)

  // Guard: identity JSON must exist before the Vite build embeds it.
  const appPublicDir = path.join(buildRoot, "packages/app/public")
  const identityJson = await writeIdentityJson(appPublicDir, {
    baselineCommit: BASE_COMMIT,
    patchId: patchIdShort,
    buildId,
    channel,
    ...(version ? { version } : {}),
  })
  log(`wrote identity JSON ${identityJson}`)

  const childEnv = sanitizeChildEnv(process.env, identityOverrides)
  await probeAndAssertEnv(childEnv, buildRoot, "pre-build")

  if (opts.mode === "base") {
    const installEnv = sanitizeChildEnv(process.env, { ...isolatedEnv, HUSKY: "0" })
    const code = await runCommand(["bun", "install", "--frozen-lockfile"], {
      cwd: buildRoot,
      env: installEnv,
      label: "base frozen install",
    })
    if (code !== 0) throw new Error(`base bun install --frozen-lockfile exited ${code}`)
  }

  const buildCode = await runCommand(["bun", "./packages/opencode/script/build.ts", "--single", "--skip-install"], {
    cwd: buildRoot,
    env: childEnv,
    label: "opencode embed build",
  })
  if (buildCode !== 0) throw new Error(`opencode build exited ${buildCode}`)

  await probeAndAssertEnv(childEnv, buildRoot, "post-build")

  const pkg = await locateBuiltPackage(buildRoot)
  log(`located package ${pkg.name} -> ${pkg.bin}`)

  // Collect hashes.
  const appDist = path.join(buildRoot, "packages/app/dist")
  const distFiles = (await listFiles(appDist)).filter((f) => !f.endsWith(".map"))
  const assets: ManifestAsset[] = []
  for (const rel of distFiles) {
    const h = await hashFile(path.join(appDist, rel))
    assets.push({ path: rel, sha256: h.sha256, bytes: h.bytes })
  }
  assertManifestComplete(distFiles, assets)
  const identityAsset = assets.find((a) => a.path === "file-preview-build.json")
  const indexAsset = assets.find((a) => a.path === "index.html")
  if (!identityAsset) throw new Error("embedded identity JSON missing from app/dist - web embedding failed")
  if (!indexAsset) throw new Error("index.html missing from app/dist - web embedding failed")

  const exeHash = await hashFile(pkg.bin)

  // Stage under the immutable build id, refusing to clobber a different artifact.
  const buildDir = path.join(opts.outRoot, buildId)
  const manifestPath = path.join(buildDir, "manifest.json")
  const existing = (await Bun.file(manifestPath).exists()) ? ((await Bun.file(manifestPath).json()) as Manifest) : null
  if (existing) {
    assertNoCollision(
      { buildId: existing.buildId, executableSha256: existing.executable.sha256 },
      { buildId, executableSha256: exeHash.sha256 },
    )
    log(`existing identical artifact for ${buildId} found; re-verifying`)
  }
  await fs.mkdir(buildDir, { recursive: true })
  const stagedBin = path.join(buildDir, "opencode")
  await Bun.write(stagedBin, Bun.file(pkg.bin))
  await fs.chmod(stagedBin, 0o755)

  // Isolated identity proof from the staged executable.
  const versionOutput = (await runCaptured([stagedBin, "--version"], { cwd: buildDir, env: childEnv })).trim()
  log(`isolated --version: ${JSON.stringify(versionOutput)}`)
  const versionIsCustomIdentity = versionOutput.includes(CUSTOM_CHANNEL)
  if (opts.mode === "patched" && !versionIsCustomIdentity) {
    throw new Error(`patched build produced a non-custom identity: ${versionOutput}`)
  }
  if (opts.mode === "base" && versionIsCustomIdentity) {
    throw new Error(`base comparison build accidentally carries the custom identity: ${versionOutput}`)
  }

  const manifest: Manifest = {
    schema: "file-preview-build-manifest/v1",
    buildId,
    mode: opts.mode,
    channel,
    version,
    baselineCommit: BASE_COMMIT,
    patchId: patchIdShort === null ? null : patchIdShort,
    patchIdShort,
    bun: process.versions.bun,
    platform: { os: process.platform, arch: process.arch },
    createdAt: timestamp(),
    executable: { path: "opencode", sha256: exeHash.sha256, bytes: exeHash.bytes },
    served: { identityJson: identityAsset, indexHtml: indexAsset },
    dist: { root: "packages/app/dist", assetCount: assets.length, assets },
    versionOutput,
    versionIsCustomIdentity,
  }

  // Verify staged bytes match the manifest before declaring success.
  const reExe = await hashFile(stagedBin)
  if (reExe.sha256 !== manifest.executable.sha256) throw new Error("staged executable hash drifted from manifest")
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`manifest written: ${manifestPath} (${assets.length} embedded assets)`)

  // Cleanup the BASE temp tree only after the manifest is hash-verified.
  let cleanupReceipt: string
  if (opts.keepTemp) {
    cleanupReceipt = `kept ${tempTree ?? opts.sourceRoot} + ${envRoot} (--keep-temp)`
  } else {
    if (tempTree) await fs.rm(tempTree, { recursive: true, force: true })
    await fs.rm(envRoot, { recursive: true, force: true })
    cleanupReceipt = `${tempTree ? `removed ${tempTree}; ` : ""}removed ${envRoot}`
    log(`cleanup: ${cleanupReceipt}`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: opts.mode,
        buildId,
        buildDir,
        manifestPath,
        executableSha256: manifest.executable.sha256,
        assetCount: assets.length,
        versionOutput,
        cleanupReceipt,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) {
  await main()
}
