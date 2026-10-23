// Task 12: synthetic old (1.18.18) -> new (custom 1.19.3) -> old rollback rehearsal.
//
// Runs three strictly sequential binary phases against ONE pinned synthetic
// database path inside a fresh owned root. Fail-closed: every guard refuses
// before anything is spawned, and an unsafe verdict never deletes, restores or
// repairs the fixture state. No production state is read, copied or written.
//
// Usage (from SOURCE_ROOT):
//   FILE_PREVIEW_OLD_BIN=/usr/bin/opencode \
//   FILE_PREVIEW_NEW_BIN=<staged-binary> \
//   FILE_PREVIEW_TEST_ROOT=<owned-fresh-root> \
//   FILE_PREVIEW_TEST_PORT=4197 \
//   bun ./scripts/file-preview/verify-upgrade.ts
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, readlink, realpath, stat, writeFile, appendFile } from "node:fs/promises"
import path from "node:path"
import {
  REAL_HOME,
  assertPortAllowed,
  assertPortFree,
  assertTestRootSafe,
  sanitizeEnv,
  verifyIdentity,
  type ProcessIdentity,
} from "../../packages/app/e2e/file-preview/server"

const EXPECTED_OLD_VERSION = "1.18.18"
const EXPECTED_OLD_SHA256 = "3ae19bd00a9e15a3b8903d1516da52aca8195740d2814ca7f2871de0f8634a79"
const DEFAULT_EVIDENCE_DIR =
  "/home/audiophil/Projects/running/opencode-file-preview/.omo/evidence/opencode-file-preview/a3"
const DEFAULT_PORT = 4197
// Every health request is bounded on its own; the global deadline is checked
// between requests. The per-request bound is the fix that stops a probe from
// outliving the deadline, and the startup-cleanup guard proves it. The original
// pre-fix attempt ran 307.5s wall clock against a 120s deadline (08:27:30.610Z
// to 08:32:38.144Z). No per-request record survived that attempt, so what the
// request was doing is unproven; the duration is not evidence of an auth,
// proxy, or compatibility failure.
const HEALTH_DEADLINE_MS = 120_000
const HEALTH_REQUEST_TIMEOUT_MS = 5_000
const API_REQUEST_TIMEOUT_MS = 30_000

export type UpgradeConfig = {
  oldBin: string
  newBin: string
  manifestPath: string
  testRoot: string
  port: number
  evidenceDir: string
  home: string
  xdgConfig: string
  xdgData: string
  xdgState: string
  xdgCache: string
  tmpdir: string
  configDir: string
  configFile: string
  workspace: string
  dbPath: string
  username: string
  password: string
}

export type Manifest = {
  buildId: string
  version: string
  channel: string
  executable: { path: string; sha256: string; bytes: number }
}

type Json = Record<string, unknown>

export const DEPLOYMENT_READINESS_BLOCKER =
  "default channel database paths diverge: old binary derives opencode.db, custom file-preview build derives opencode-file-preview.db; deployment requires an OPENCODE_DB pin or OPENCODE_DISABLE_CHANNEL_DB=1 plus an owner-approved plan amendment"

export type VerdictDerivation = {
  compatible: boolean | null
  rollbackSafe: boolean | null
  outcome: "compatible" | "incompatible" | "inconclusive"
  readiness: "ready" | "blocked" | "pending"
  readinessScope: "synthetic-pinned-fixture"
  deploymentReadiness: "blocked"
  deploymentBlockers: Array<string>
  blockers: Array<string>
}

// A compatible rehearsal is fixture-scoped only. Any non-fatal blocker makes the
// outcome incompatible with blocked readiness; a readiness timeout is
// inconclusive, never incompatible.
export function deriveVerdict(
  blockers: Array<string>,
  options: { readinessTimeout?: boolean } = {},
): VerdictDerivation {
  const base = {
    readinessScope: "synthetic-pinned-fixture" as const,
    deploymentReadiness: "blocked" as const,
    deploymentBlockers: [DEPLOYMENT_READINESS_BLOCKER],
    blockers,
  }
  if (options.readinessTimeout) {
    return { ...base, compatible: null, rollbackSafe: null, outcome: "inconclusive", readiness: "blocked" }
  }
  if (blockers.length > 0) {
    return { ...base, compatible: false, rollbackSafe: false, outcome: "incompatible", readiness: "blocked" }
  }
  return { ...base, compatible: true, rollbackSafe: true, outcome: "compatible", readiness: "ready" }
}

function requireAbsolute(value: string | undefined, name: string): string {
  if (!value) throw new Error(`verify-upgrade: ${name} is required`)
  if (!path.isAbsolute(value)) throw new Error(`verify-upgrade: ${name} must be absolute, got ${value}`)
  return value
}

// Fresh-root check: the rehearsal owns its root from scratch; an existing
// nonempty root could be somebody else's state.
export async function assertRootFresh(testRoot: string): Promise<void> {
  const info = await stat(testRoot).catch(() => undefined)
  if (info === undefined) return
  if (!info.isDirectory()) throw new Error(`verify-upgrade: TEST_ROOT exists and is not a directory: ${testRoot}`)
  const entries = await readdir(testRoot)
  if (entries.length > 0) throw new Error(`verify-upgrade: TEST_ROOT already exists and is nonempty: ${testRoot}`)
}

export function parseArgs(env: NodeJS.ProcessEnv): UpgradeConfig {
  const oldBin = requireAbsolute(env.FILE_PREVIEW_OLD_BIN, "FILE_PREVIEW_OLD_BIN")
  const newBin = requireAbsolute(env.FILE_PREVIEW_NEW_BIN, "FILE_PREVIEW_NEW_BIN")
  const testRoot = requireAbsolute(env.FILE_PREVIEW_TEST_ROOT, "FILE_PREVIEW_TEST_ROOT")
  const port = env.FILE_PREVIEW_TEST_PORT ? Number(env.FILE_PREVIEW_TEST_PORT) : DEFAULT_PORT
  const evidenceDir = env.FILE_PREVIEW_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`verify-upgrade: invalid port ${port}`)
  assertPortAllowed(port)
  assertTestRootSafe(testRoot, REAL_HOME)
  const dbPath = path.join(testRoot, "opencode.db")
  assertTestRootSafe(dbPath, REAL_HOME)
  return {
    oldBin,
    newBin,
    manifestPath: path.join(path.dirname(newBin), "manifest.json"),
    testRoot,
    port,
    evidenceDir,
    home: path.join(testRoot, "home"),
    xdgConfig: path.join(testRoot, "xdg", "config"),
    xdgData: path.join(testRoot, "xdg", "data"),
    xdgState: path.join(testRoot, "xdg", "state"),
    xdgCache: path.join(testRoot, "xdg", "cache"),
    tmpdir: path.join(testRoot, "tmp"),
    configDir: path.join(testRoot, "config"),
    configFile: path.join(testRoot, "config", "opencode.json"),
    workspace: path.join(testRoot, "workspace"),
    dbPath,
    username: "fixture",
    password: "fixture-only",
  }
}

// Fixture child env: sanitized, then the explicit isolated set. OPENCODE_TEST_HOME
// is unset unless it deliberately equals the fixture HOME.
export function childEnv(cfg: UpgradeConfig, extra: Record<string, string> = {}): Record<string, string> {
  const env = sanitizeEnv(process.env)
  delete env.OPENCODE_TEST_HOME
  if (process.env.OPENCODE_TEST_HOME === cfg.home) env.OPENCODE_TEST_HOME = cfg.home
  return {
    ...env,
    HOME: cfg.home,
    XDG_CONFIG_HOME: cfg.xdgConfig,
    XDG_DATA_HOME: cfg.xdgData,
    XDG_STATE_HOME: cfg.xdgState,
    XDG_CACHE_HOME: cfg.xdgCache,
    TMPDIR: cfg.tmpdir,
    OPENCODE_CONFIG: cfg.configFile,
    OPENCODE_CONFIG_DIR: cfg.configDir,
    OPENCODE_SERVER_USERNAME: cfg.username,
    OPENCODE_SERVER_PASSWORD: cfg.password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: cfg.dbPath,
    ...extra,
  }
}

export function runtimeInfo(env: NodeJS.ProcessEnv = process.env) {
  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    proxyEnvPresent: proxyKeys.filter((key) => env[key] !== undefined),
    nodeOptionsPresent: env.NODE_OPTIONS !== undefined,
  }
}

export async function run(bin: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs = 120_000) {
  const proc = Bun.spawn([bin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { code, stdout, stderr }
}

export async function binVersion(bin: string, env: Record<string, string>): Promise<string> {
  const r = await run(bin, ["--version"], env, "/tmp")
  if (r.code !== 0) throw new Error(`verify-upgrade: ${bin} --version exited ${r.code}: ${r.stderr.slice(-500)}`)
  return r.stdout.trim()
}

export async function sha256File(p: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  const stream = Bun.file(p).stream()
  for await (const chunk of stream) hasher.update(chunk as Buffer)
  return hasher.digest("hex")
}

export async function assertOldIdentity(
  bin: string,
  env: Record<string, string>,
): Promise<{ version: string; sha256: string }> {
  const version = await binVersion(bin, env)
  if (version !== EXPECTED_OLD_VERSION) {
    throw new Error(`verify-upgrade: OLD_BIN must be exactly ${EXPECTED_OLD_VERSION}, got "${version}"`)
  }
  const sha256 = await sha256File(bin)
  if (sha256 !== EXPECTED_OLD_SHA256) {
    throw new Error(`verify-upgrade: system binary hash changed: expected ${EXPECTED_OLD_SHA256}, got ${sha256}`)
  }
  return { version, sha256 }
}

export async function assertNewIdentity(
  bin: string,
  manifestPath: string,
  env: Record<string, string>,
): Promise<{ version: string; sha256: string; manifest: Manifest }> {
  const manifest = (await Bun.file(manifestPath).json()) as Manifest
  const version = await binVersion(bin, env)
  if (version !== manifest.version) {
    throw new Error(
      `verify-upgrade: NEW_BIN version "${version}" does not match manifest version "${manifest.version}"`,
    )
  }
  const sha256 = await sha256File(bin)
  if (sha256 !== manifest.executable.sha256) {
    throw new Error(`verify-upgrade: NEW_BIN sha256 ${sha256} does not match manifest ${manifest.executable.sha256}`)
  }
  return { version, sha256, manifest }
}

// The database path each binary derives on its own (no OPENCODE_DB). The custom
// build's channel produces a channel-suffixed filename; this divergence is
// recorded as deployment evidence, never silently accepted as the rehearsal path.
export async function defaultDbPath(bin: string, env: Record<string, string>): Promise<string> {
  const r = await run(bin, ["db", "path"], env, "/tmp")
  if (r.code !== 0) throw new Error(`verify-upgrade: ${bin} db path exited ${r.code}: ${r.stderr.slice(-500)}`)
  return r.stdout.trim()
}

export function assertSamePinnedPath(paths: Array<{ bin: string; resolved: string }>, expected: string): void {
  for (const item of paths) {
    if (item.resolved !== expected) {
      throw new Error(
        `verify-upgrade: channel/db-path divergence: ${item.bin} resolves db path ${item.resolved}, expected ${expected}`,
      )
    }
  }
}

async function readStartTicks(pid: number): Promise<string> {
  const s = await readFile(`/proc/${pid}/stat`, "utf8")
  const close = s.lastIndexOf(")")
  return s.slice(close + 2).split(" ")[19] ?? ""
}

// The executable actually running in the owned pid. A shebang launcher (used by
// the cleanup test) resolves to its interpreter, so realpath(bin) alone would
// produce an identity that never matches and cleanup would refuse to signal.
async function readSpawnedExe(pid: number, fallback: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const target = await readlink(`/proc/${pid}/exe`).catch(() => "")
    if (target) return await realpath(target).catch(() => target)
    await Bun.sleep(25)
  }
  return fallback
}

// Every process whose /proc/<pid>/fd currently points at the pinned database
// (or its WAL/SHM sidecars). Unscannable pids are counted honestly; a scan that
// cannot see inside processes is not proof of absence.
export async function dbHolders(
  dbPath: string,
  sidecars = true,
): Promise<{ holders: Array<{ pid: number; exe: string }>; unscannable: number }> {
  const targets = new Set([dbPath])
  if (sidecars) {
    targets.add(`${dbPath}-wal`)
    targets.add(`${dbPath}-shm`)
  }
  const holders: Array<{ pid: number; exe: string }> = []
  let unscannable = 0
  let entries: string[] = []
  try {
    entries = (await readdir("/proc")).filter((e) => /^\d+$/.test(e))
  } catch {
    return { holders, unscannable: -1 }
  }
  for (const entry of entries) {
    const pid = Number(entry)
    const fdDir = `/proc/${pid}/fd`
    let fds: string[]
    try {
      fds = await readdir(fdDir)
    } catch {
      unscannable++
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = await readlink(path.join(fdDir, fd))
      } catch {
        continue
      }
      if (targets.has(target)) {
        const exe = await readlink(`/proc/${pid}/exe`).catch(() => "")
        holders.push({ pid, exe })
        break
      }
    }
  }
  return { holders, unscannable }
}

export type HealthAttempt = {
  at: string
  kind: "authorized" | "anonymous"
  status?: number
  error?: string
  timedOut: boolean
  ms: number
}

// Readiness timeout is not evidence of incompatibility; only an observed
// schema/readback failure may produce an unsafe verdict.
export class HealthTimeoutError extends Error {}

type Running = {
  child: ChildProcess
  identity: ProcessIdentity
  bin: string
  phase: string
  logFile: string
  health: Array<HealthAttempt>
}

// Registered immediately after spawn, before any await, so a failed health
// wait cannot leak the child. Identity is filled in right after.
const spawnedChildren = new Map<ChildProcess, ProcessIdentity | undefined>()

export function spawnedChildCount(): number {
  return spawnedChildren.size
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(50)
  return child.exitCode !== null
}

async function terminateOwned(child: ChildProcess, identity?: ProcessIdentity, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null) {
    spawnedChildren.delete(child)
    return
  }
  if (identity?.startTicks && !(await verifyIdentity(identity))) {
    spawnedChildren.delete(child)
    return
  }
  child.kill("SIGTERM")
  if (!(await waitForExit(child, graceMs))) {
    if (identity?.startTicks && !(await verifyIdentity(identity))) {
      spawnedChildren.delete(child)
      return
    }
    child.kill("SIGKILL")
    await waitForExit(child, 2_000)
  }
  spawnedChildren.delete(child)
}

export async function killSpawnedChildren(): Promise<void> {
  for (const [child, identity] of [...spawnedChildren]) await terminateOwned(child, identity)
}

async function probe(url: string, headers: Record<string, string> | undefined, timeoutMs: number) {
  const started = Date.now()
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    return { status: response.status, timedOut: false, ms: Date.now() - started }
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    return {
      error: error instanceof Error ? error.message : String(error),
      timedOut: name === "TimeoutError" || name === "AbortError",
      ms: Date.now() - started,
    }
  }
}

async function writeHealthAttempts(
  cfg: UpgradeConfig,
  phase: string,
  attempts: Array<HealthAttempt>,
  deadlineMs: number,
  requestMs: number,
) {
  await writeFile(
    path.join(cfg.testRoot, `health-${phase}.json`),
    JSON.stringify(
      {
        schema: "task12-health-attempts/v1",
        phase,
        requestTimeoutMs: requestMs,
        deadlineMs,
        attempts,
      },
      null,
      2,
    ),
  ).catch(() => {})
}

async function waitForHealth(
  cfg: UpgradeConfig,
  child: ChildProcess,
  logFile: string,
  phase: string,
  deadlineMs = HEALTH_DEADLINE_MS,
  requestMs = HEALTH_REQUEST_TIMEOUT_MS,
): Promise<Array<HealthAttempt>> {
  const deadline = Date.now() + deadlineMs
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
  const url = `http://127.0.0.1:${cfg.port}/global/health`
  const attempts: Array<HealthAttempt> = []
  const record = (kind: HealthAttempt["kind"], result: Awaited<ReturnType<typeof probe>>) => {
    attempts.push({ at: new Date().toISOString(), kind, ...result })
    if (attempts.length > 200) attempts.shift()
  }
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await writeHealthAttempts(cfg, phase, attempts, deadlineMs, requestMs)
      const log = await Bun.file(logFile)
        .text()
        .catch(() => "")
      throw new Error(`verify-upgrade: backend exited early (code ${child.exitCode})\n${log.slice(-2000)}`)
    }
    const budget = Math.max(1, Math.min(requestMs, deadline - Date.now()))
    const authorized = await probe(url, { Authorization: auth }, budget)
    record("authorized", authorized)
    if (authorized.status === 200) {
      const anonBudget = Math.max(1, Math.min(requestMs, deadline - Date.now()))
      const anonymous = await probe(url, undefined, anonBudget)
      record("anonymous", anonymous)
      if (anonymous.status === 401) {
        await writeHealthAttempts(cfg, phase, attempts, deadlineMs, requestMs)
        return attempts
      }
    }
    await Bun.sleep(250)
  }
  await writeHealthAttempts(cfg, phase, attempts, deadlineMs, requestMs)
  const recent = attempts
    .slice(-5)
    .map((a) => `${a.kind}:${a.status ?? a.error ?? "unknown"}${a.timedOut ? "(timeout)" : ""}`)
    .join(", ")
  throw new HealthTimeoutError(
    `verify-upgrade: backend health check timed out at ${url} after ${deadlineMs}ms (per-request ${requestMs}ms); last attempts: ${recent || "none"}`,
  )
}

export async function startServer(
  cfg: UpgradeConfig,
  bin: string,
  phase: string,
  env: Record<string, string>,
  options: { healthTimeoutMs?: number; healthRequestTimeoutMs?: number } = {},
): Promise<Running> {
  await assertPortFree("127.0.0.1", cfg.port)
  await mkdir(cfg.testRoot, { recursive: true, mode: 0o700 })
  const logFile = path.join(cfg.testRoot, `serve-${phase}.log`)
  const logHandle = Bun.file(logFile).writer()
  const child = spawn(bin, ["serve", "--port", String(cfg.port), "--hostname", "127.0.0.1"], {
    cwd: cfg.workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk) => logHandle.write(chunk))
  child.stderr?.on("data", (chunk) => logHandle.write(chunk))
  if (child.pid === undefined) throw new Error("verify-upgrade: backend failed to spawn (no pid)")
  spawnedChildren.set(child, undefined)
  const identity: ProcessIdentity = {
    pid: child.pid,
    exe: await readSpawnedExe(child.pid, await realpath(bin).catch(() => bin)),
    startTicks: await readStartTicks(child.pid),
  }
  if (!identity.startTicks) {
    await terminateOwned(child, undefined)
    await logHandle.flush()
    throw new Error(`verify-upgrade: could not read start ticks for spawned pid ${identity.pid}`)
  }
  spawnedChildren.set(child, identity)
  try {
    const health = await waitForHealth(
      cfg,
      child,
      logFile,
      phase,
      options.healthTimeoutMs,
      options.healthRequestTimeoutMs,
    )
    await logHandle.flush()
    return { child, identity, bin, phase, logFile, health }
  } catch (error) {
    await terminateOwned(child, identity)
    await logHandle.flush()
    const log = await Bun.file(logFile)
      .text()
      .catch(() => "")
    const message = error instanceof Error ? error.message : String(error)
    const enriched = `${message}\nstartup stdout/stderr tail:\n${log.slice(-2000)}`
    throw error instanceof HealthTimeoutError ? new HealthTimeoutError(enriched) : new Error(enriched)
  }
}

async function stopServer(running: Running, cfg: UpgradeConfig): Promise<void> {
  if (!(await verifyIdentity(running.identity))) {
    throw new Error(`verify-upgrade: refusing to stop pid ${running.identity.pid}; process identity no longer matches`)
  }
  await terminateOwned(running.child, running.identity)
  await assertWriterStopped(running, cfg)
}

// After a stop: the owned pid is gone, the port is free, and no other process
// holds the pinned database open (best effort; unscannable pids are recorded).
export async function assertWriterStopped(running: { identity: ProcessIdentity }, cfg: UpgradeConfig): Promise<void> {
  if (await verifyIdentity(running.identity)) {
    throw new Error(`verify-upgrade: owned writer pid ${running.identity.pid} is still alive`)
  }
  await assertPortFree("127.0.0.1", cfg.port)
  const { holders, unscannable } = await dbHolders(cfg.dbPath)
  if (holders.length > 0) {
    throw new Error(`verify-upgrade: database still held by: ${JSON.stringify(holders)}`)
  }
  if (unscannable !== 0) {
    // Honest note, not proof of absence; recorded by the caller's log.
    await appendFile(
      path.join(cfg.evidenceDir, "task-12-upgrade-rollback.log"),
      `NOTE: ${unscannable} /proc entries were unscannable during writer-stop check\n`,
    ).catch(() => {})
  }
}

type Api = {
  get: (p: string) => Promise<unknown>
  post: (p: string, body: unknown) => Promise<unknown>
  patch: (p: string, body: unknown) => Promise<unknown>
}

function api(cfg: UpgradeConfig): Api {
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")
  const base = `http://127.0.0.1:${cfg.port}`
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`verify-upgrade: API ${method} ${p} -> ${r.status}: ${text.slice(-300)}`)
    return text ? JSON.parse(text) : undefined
  }
  return {
    get: (p) => call("GET", p),
    post: (p, body) => call("POST", p, body),
    patch: (p, body) => call("PATCH", p, body),
  }
}

// ---- synthetic fixture data ------------------------------------------------

const T_MSG_USER = 1792397001000
const T_MSG_ASST = 1792397002000
const T_TODO = 1792397003000

type SessionInfo = Json & { id: string }

async function createFixtureSessions(rest: Api) {
  const parent = (await rest.post("/session", {
    title: "task12-synthetic-parent",
    metadata: { source: "task12-fixture", kind: "parent", marker: "T12PARENT-MARKER" },
  })) as SessionInfo
  const child = (await rest.post("/session", {
    parentID: parent.id,
    title: "task12-synthetic-child",
    metadata: { source: "task12-fixture", kind: "child", marker: "T12CHILD-MARKER" },
  })) as SessionInfo
  // Document metadata exercise: PATCH the parent's metadata with a document block.
  await rest.patch(`/session/${parent.id}`, {
    metadata: {
      source: "task12-fixture",
      kind: "parent",
      marker: "T12PARENT-MARKER",
      document: { title: "Task12 Document Metadata", lines: 42 },
    },
  })
  await rest.patch(`/session/${child.id}`, { title: "task12-synthetic-child-renamed" })
  return { parent, child }
}

function importPayload(session: SessionInfo, messages: Array<{ info: Json; parts: Json[] }>): Json {
  return { info: session, messages }
}

function parentMessages(parentID: string): Array<{ info: Json; parts: Json[] }> {
  return [
    {
      info: {
        id: "msg_t12_parent_user_01",
        sessionID: parentID,
        role: "user",
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture-model" },
        time: { created: T_MSG_USER },
      },
      parts: [
        {
          id: "prt_t12_parent_u01_a",
          sessionID: parentID,
          messageID: "msg_t12_parent_user_01",
          type: "text",
          text: "task12 synthetic parent user prompt T12MARKER-PARENT-TEXT",
        },
      ],
    },
    {
      info: {
        id: "msg_t12_parent_asst_01",
        sessionID: parentID,
        role: "assistant",
        parentID: "msg_t12_parent_user_01",
        agent: "build",
        mode: "build",
        modelID: "fixture-model",
        providerID: "fixture",
        path: { cwd: "/task12/fixture", root: "/task12/fixture" },
        cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: T_MSG_ASST },
      },
      parts: [
        {
          id: "prt_t12_parent_a01_a",
          sessionID: parentID,
          messageID: "msg_t12_parent_asst_01",
          type: "text",
          text: "task12 synthetic parent assistant reply T12MARKER-PARENT-REPLY",
        },
      ],
    },
  ]
}

function childMessages(childID: string): Array<{ info: Json; parts: Json[] }> {
  return [
    {
      info: {
        id: "msg_t12_child_user_01",
        sessionID: childID,
        role: "user",
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture-model" },
        time: { created: T_MSG_USER + 10 },
      },
      parts: [
        {
          id: "prt_t12_child_u01_a",
          sessionID: childID,
          messageID: "msg_t12_child_user_01",
          type: "text",
          text: "task12 synthetic child user prompt T12MARKER-CHILD-TEXT",
        },
      ],
    },
  ]
}

function newRunMessages(newID: string): Array<{ info: Json; parts: Json[] }> {
  return [
    {
      info: {
        id: "msg_t12_new_user_01",
        sessionID: newID,
        role: "user",
        agent: "build",
        model: { providerID: "fixture", modelID: "fixture-model" },
        time: { created: T_MSG_USER + 20 },
      },
      parts: [
        {
          id: "prt_t12_new_u01_a",
          sessionID: newID,
          messageID: "msg_t12_new_user_01",
          type: "text",
          text: "task12 synthetic new-run user prompt T12MARKER-NEW-TEXT",
        },
      ],
    },
  ]
}

async function insertTodos(
  bin: string,
  cfg: UpgradeConfig,
  env: Record<string, string>,
  sessionID: string,
  todos: Array<[string, string, string, number]>,
) {
  for (const [i, [content, status, priority, position]] of todos.entries()) {
    const sql = `INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES ('${sessionID}', '${content}', '${status}', '${priority}', ${position}, ${T_TODO + i}, ${T_TODO + i})`
    const r = await run(bin, ["db", sql, "--format", "json"], env, cfg.workspace)
    if (r.code !== 0) throw new Error(`verify-upgrade: todo insert failed: ${r.stderr.slice(-300)}`)
  }
}

// ---- canonical snapshot + semantic comparison ------------------------------

type Snapshot = {
  sessions: Array<Json>
  messages: Record<string, Array<Json>>
  todos: Record<string, Array<Json>>
  children: Record<string, Array<string>>
}

async function snapshot(rest: Api): Promise<Snapshot> {
  const sessions = (await rest.get("/session")) as Array<Json>
  const out: Snapshot = { sessions, messages: {}, todos: {}, children: {} }
  for (const s of sessions) {
    const id = s.id as string
    out.messages[id] = (await rest.get(`/session/${id}/message`)) as Array<Json>
    out.todos[id] = (await rest.get(`/session/${id}/todo`)) as Array<Json>
    const kids = (await rest.get(`/session/${id}/children`)) as Array<Json>
    out.children[id] = kids.map((k) => k.id as string)
  }
  return out
}

// Keys that genuinely change between reads without a semantic write. Anything
// else that differs is a finding, never silently dropped.
const VOLATILE_PATHS = new Set(["time.updated"])

function canonicalize(value: unknown, keyPath: Array<string> = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => canonicalize(v, [...keyPath, String(i)]))
  if (value && typeof value === "object") {
    const out: Json = {}
    const keys = Object.keys(value as Json).sort()
    for (const key of keys) {
      const leaf = [...keyPath, key]
      const tail = leaf.slice(-2).join(".")
      if (VOLATILE_PATHS.has(tail) || VOLATILE_PATHS.has(key)) continue
      out[key] = canonicalize((value as Json)[key], leaf)
    }
    return out
  }
  return value
}

export function semanticDiff(a: unknown, b: unknown, pathSoFar = ""): Array<{ path: string; a: unknown; b: unknown }> {
  const ca = canonicalize(a)
  const cb = canonicalize(b)
  const diffs: Array<{ path: string; a: unknown; b: unknown }> = []
  const walk = (x: unknown, y: unknown, p: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        diffs.push({ path: `${p}[length]`, a: x.length, b: y.length })
        return
      }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${p}[${i}]`)
      return
    }
    if (x && y && typeof x === "object" && typeof y === "object") {
      const keys = new Set([...Object.keys(x as Json), ...Object.keys(y as Json)])
      for (const key of [...keys].sort()) walk((x as Json)[key], (y as Json)[key], `${p}.${key}`)
      return
    }
    diffs.push({ path: p, a: x, b: y })
  }
  walk(ca, cb, pathSoFar || "$")
  return diffs
}

// ---- database fingerprints -------------------------------------------------

type Fingerprints = { integrity: string; schemaSha256: string; migrations: Array<string>; dbSha256: string }

export async function fingerprints(
  bin: string,
  cfg: UpgradeConfig,
  env: Record<string, string>,
): Promise<Fingerprints> {
  const q = async (sql: string) => {
    const r = await run(bin, ["db", sql, "--format", "json"], env, cfg.workspace)
    if (r.code !== 0) throw new Error(`verify-upgrade: db query failed (${sql}): ${r.stderr.slice(-300)}`)
    return r.stdout
  }
  await run(bin, ["db", "PRAGMA wal_checkpoint(TRUNCATE)", "--format", "json"], env, cfg.workspace)
  const integrityRaw = await q("PRAGMA integrity_check")
  const integrity = (() => {
    try {
      const rows = JSON.parse(integrityRaw) as Array<Json>
      return rows.map((r) => String(r.integrity_check)).join(",")
    } catch {
      return integrityRaw.trim()
    }
  })()
  // integrity_check can pass on a schema that cannot serve session rows; probe the data too.
  await q("SELECT id, title FROM session ORDER BY id")
  const schemaRaw = await q("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name, type")
  const schemaSha256 = createHash("sha256").update(canonicalizeJsonText(schemaRaw)).digest("hex")
  const migrationsRaw = await q("SELECT id FROM migration ORDER BY id")
  let migrations: Array<string> = []
  try {
    migrations = (JSON.parse(migrationsRaw) as Array<Json>).map((r) => String(r.id))
  } catch {
    migrations = []
  }
  const dbSha256 = await sha256File(cfg.dbPath)
  return { integrity, schemaSha256, migrations, dbSha256 }
}

function canonicalizeJsonText(text: string): string {
  try {
    return JSON.stringify(canonicalize(JSON.parse(text)))
  } catch {
    return text.trim()
  }
}

// ---- evidence --------------------------------------------------------------

class Log {
  lines: Array<string> = []
  constructor(private file: string) {}
  async write(line: string) {
    const stamped = `[${new Date().toISOString()}] ${line}`
    this.lines.push(stamped)
    process.stdout.write(stamped + "\n")
    await appendFile(this.file, stamped + "\n").catch(() => {})
  }
  async flush() {
    await writeFile(this.file, this.lines.join("\n") + "\n")
  }
}

// ---- main rehearsal --------------------------------------------------------

async function main(): Promise<number> {
  const cfg = parseArgs(process.env)
  await mkdir(cfg.evidenceDir, { recursive: true, mode: 0o700 })
  const log = new Log(path.join(cfg.evidenceDir, "task-12-upgrade-rollback.log"))
  const result: Json = {
    schema: "task12-state-compatibility/v1",
    startedAt: new Date().toISOString(),
    verdict: {
      compatible: null,
      rollbackSafe: null,
      outcome: "inconclusive",
      readiness: "pending",
      blockers: [] as Array<string>,
    },
  }
  const blockers = (result.verdict as Json).blockers as Array<string>
  let currentPhase = "preflight"
  const fail = (message: string) => {
    blockers.push(message)
    log.write(`BLOCKER: ${message}`)
  }

  try {
    await assertRootFresh(cfg.testRoot)
    await log.write(`config: ${JSON.stringify({ ...cfg, password: "[redacted]", username: "[redacted]" })}`)
    result.runtime = runtimeInfo()
    await log.write(`runtime: ${JSON.stringify(result.runtime)}`)

    // Preflight identities (no server spawned yet).
    const baseEnv = childEnv(cfg)
    const old = await assertOldIdentity(cfg.oldBin, baseEnv)
    await log.write(`old identity: ${JSON.stringify(old)}`)
    const neu = await assertNewIdentity(cfg.newBin, cfg.manifestPath, baseEnv)
    await log.write(
      `new identity: ${JSON.stringify({ version: neu.version, sha256: neu.sha256, buildId: neu.manifest.buildId })}`,
    )
    result.binaries = {
      old: { path: cfg.oldBin, ...old },
      new: {
        path: cfg.newBin,
        version: neu.version,
        sha256: neu.sha256,
        buildId: neu.manifest.buildId,
        manifest: cfg.manifestPath,
      },
    }

    // Channel-derived default paths (no OPENCODE_DB): documented divergence.
    const unpinnedEnv = { ...baseEnv }
    delete unpinnedEnv.OPENCODE_DB
    const oldDefault = await defaultDbPath(cfg.oldBin, unpinnedEnv)
    const newDefault = await defaultDbPath(cfg.newBin, unpinnedEnv)
    await log.write(`default db paths: old=${oldDefault} new=${newDefault} divergent=${oldDefault !== newDefault}`)
    // Pinned path must resolve identically in both binaries.
    const oldPinned = await defaultDbPath(cfg.oldBin, baseEnv)
    const newPinned = await defaultDbPath(cfg.newBin, baseEnv)
    assertSamePinnedPath(
      [
        { bin: cfg.oldBin, resolved: oldPinned },
        { bin: cfg.newBin, resolved: newPinned },
      ],
      cfg.dbPath,
    )
    await log.write(`pinned db path identical for both binaries: ${cfg.dbPath}`)
    result.storage = {
      pinnedDbPath: cfg.dbPath,
      pinnedVia: "OPENCODE_DB",
      derivation: { oldDefault, newDefault, channelDivergence: oldDefault !== newDefault },
      note: "Custom build channel 'file-preview' derives opencode-file-preview.db by default; the rehearsal pins OPENCODE_DB so all three runs share one path. Deployment must pin OPENCODE_DB (or set OPENCODE_DISABLE_CHANNEL_DB=1) or the custom build silently uses a separate database.",
    }

    // Fixture roots.
    for (const dir of [
      cfg.home,
      cfg.xdgConfig,
      cfg.xdgData,
      cfg.xdgState,
      cfg.xdgCache,
      cfg.tmpdir,
      cfg.configDir,
      cfg.workspace,
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    }
    await writeFile(cfg.configFile, JSON.stringify({ plugin: [], mcp: {} }, null, 2))
    await writeFile(path.join(cfg.workspace, "task12-fixture.md"), "# task12 fixture workspace\n")

    const runs: Array<Json> = []
    result.runs = runs
    const healthByPhase: Json = {}
    result.health = healthByPhase

    const fdObserve = async (running: Running) => {
      const fdDir = `/proc/${running.identity.pid}/fd`
      let fds: string[] = []
      try {
        fds = await readdir(fdDir)
      } catch (e) {
        return { observed: false, error: String(e), dbFiles: [] as Array<string> }
      }
      const dbFiles: Array<string> = []
      for (const fd of fds) {
        const target = await readlink(path.join(fdDir, fd)).catch(() => "")
        if (target.startsWith(cfg.dbPath)) dbFiles.push(target)
      }
      return { observed: true, dbFiles, fdCount: fds.length }
    }

    const contaminationScan = async (phase: string) => {
      const logFile = path.join(cfg.testRoot, `serve-${phase}.log`)
      const text = await Bun.file(logFile)
        .text()
        .catch(() => "")
      const findings: Array<string> = []
      if (text.includes(REAL_HOME)) findings.push(`log references REAL_HOME (${REAL_HOME})`)
      if (/plugin.*(loaded|installed)/i.test(text) && !/0 plugins/i.test(text))
        findings.push("possible plugin load in log")
      return { phase, findings, bytes: text.length }
    }

    // ============ Run 1: OLD creates synthetic state ============
    await log.write("=== RUN 1: old binary creates synthetic state ===")
    currentPhase = "run1-old"
    let running = await startServer(cfg, cfg.oldBin, "run1-old", baseEnv)
    healthByPhase["run1-old"] = running.health
    await log.write(
      `run1 old server pid=${running.identity.pid} startTicks=${running.identity.startTicks} exe=${running.identity.exe}`,
    )
    const fd1 = await fdObserve(running)
    await log.write(`run1 fd observation: ${JSON.stringify(fd1)}`)
    const rest = api(cfg)
    const { parent, child } = await createFixtureSessions(rest)
    await log.write(`run1 created parent=${parent.id} child=${child.id}`)
    await stopServer(running, cfg)
    await log.write("run1 old server stopped; writer stopped verified")

    // CLI writes while stopped: messages/parts via import, todos via db.
    const importParent = path.join(cfg.testRoot, "import-parent.json")
    const importChild = path.join(cfg.testRoot, "import-child.json")
    await writeFile(importParent, JSON.stringify(importPayload(parent, parentMessages(parent.id))))
    await writeFile(importChild, JSON.stringify(importPayload(child, childMessages(child.id))))
    for (const [file, label] of [
      [importParent, "parent"],
      [importChild, "child"],
    ] as const) {
      const r = await run(cfg.oldBin, ["import", file], baseEnv, cfg.workspace)
      await log.write(
        `run1 old import ${label}: exit=${r.code} out=${r.stdout.trim()} err=${r.stderr.trim().slice(-200)}`,
      )
      if (r.code !== 0) fail(`run1 old import ${label} failed`)
    }
    await insertTodos(cfg.oldBin, cfg, baseEnv, parent.id, [
      ["task12 synthetic parent todo one", "pending", "high", 0],
      ["task12 synthetic parent todo two", "completed", "medium", 1],
    ])
    await insertTodos(cfg.oldBin, cfg, baseEnv, child.id, [
      ["task12 synthetic child todo one", "in_progress", "low", 0],
    ])

    // Old reads back its own full canonical state.
    currentPhase = "run1b-old"
    running = await startServer(cfg, cfg.oldBin, "run1b-old", baseEnv)
    healthByPhase["run1b-old"] = running.health
    const fd1b = await fdObserve(running)
    await log.write(`run1b fd observation: ${JSON.stringify(fd1b)}`)
    const snap1 = await snapshot(rest)
    result.run1Canonical = snap1
    await stopServer(running, cfg)

    const fp1 = await fingerprints(cfg.oldBin, cfg, baseEnv)
    await log.write(
      `run1 fingerprints: ${JSON.stringify({ ...fp1, migrations: fp1.migrations.length + " migrations" })}`,
    )
    const exportParent1 = path.join(cfg.evidenceDir, "task-12-fixture-export-parent-old1.json")
    const exportChild1 = path.join(cfg.evidenceDir, "task-12-fixture-export-child-old1.json")
    for (const [id, dest] of [
      [parent.id, exportParent1],
      [child.id, exportChild1],
    ] as const) {
      const r = await run(cfg.oldBin, ["export", id], { ...baseEnv }, cfg.workspace)
      await log.write(`run1 old export ${id}: exit=${r.code}`)
      if (r.code !== 0) fail(`run1 old export ${id} failed: ${r.stderr.slice(-200)}`)
      else await writeFile(dest, r.stdout)
    }
    runs.push({ phase: "run1-old", binary: "old", version: old.version, fd: [fd1, fd1b], fingerprints: fp1 })

    // ============ Run 2: NEW on the same state ============
    await log.write("=== RUN 2: new binary on the same state ===")
    currentPhase = "run2-new"
    running = await startServer(cfg, cfg.newBin, "run2-new", baseEnv)
    healthByPhase["run2-new"] = running.health
    await log.write(
      `run2 new server pid=${running.identity.pid} startTicks=${running.identity.startTicks} exe=${running.identity.exe}`,
    )
    const fd2 = await fdObserve(running)
    await log.write(`run2 fd observation: ${JSON.stringify(fd2)}`)
    const snap2pre = await snapshot(rest)
    const oldDiffs = semanticDiff(snap1, snap2pre)
    await log.write(`run2 old-record semantic diffs after new open: ${JSON.stringify(oldDiffs).slice(0, 2000)}`)
    if (oldDiffs.length > 0)
      fail(`new binary changed or could not reproduce old records: ${JSON.stringify(oldDiffs).slice(0, 1000)}`)

    // New synthetic session + update through the new binary's API.
    const newSession = (await rest.post("/session", {
      title: "task12-new-run-session",
      metadata: { source: "task12-fixture", kind: "new-run", marker: "T12NEW-MARKER" },
    })) as SessionInfo
    await rest.patch(`/session/${newSession.id}`, {
      metadata: {
        source: "task12-fixture",
        kind: "new-run",
        marker: "T12NEW-MARKER",
        document: { title: "New Run Doc", lines: 7 },
      },
    })
    await log.write(`run2 created new session=${newSession.id}`)
    await stopServer(running, cfg)
    await log.write("run2 new server stopped; writer stopped verified")

    const importNew = path.join(cfg.testRoot, "import-new.json")
    await writeFile(importNew, JSON.stringify(importPayload(newSession, newRunMessages(newSession.id))))
    const rImportNew = await run(cfg.newBin, ["import", importNew], baseEnv, cfg.workspace)
    await log.write(
      `run2 new import: exit=${rImportNew.code} out=${rImportNew.stdout.trim()} err=${rImportNew.stderr.trim().slice(-200)}`,
    )
    if (rImportNew.code !== 0) fail("run2 new import failed")
    await insertTodos(cfg.newBin, cfg, baseEnv, newSession.id, [
      ["task12 synthetic new-run todo one", "pending", "high", 0],
    ])

    currentPhase = "run2b-new"
    running = await startServer(cfg, cfg.newBin, "run2b-new", baseEnv)
    healthByPhase["run2b-new"] = running.health
    const fd2b = await fdObserve(running)
    await log.write(`run2b fd observation: ${JSON.stringify(fd2b)}`)
    const snap2 = await snapshot(rest)
    result.run2Snapshot = snap2
    await stopServer(running, cfg)

    const fp2 = await fingerprints(cfg.newBin, cfg, baseEnv)
    await log.write(
      `run2 fingerprints: ${JSON.stringify({ ...fp2, migrations: fp2.migrations.length + " migrations" })}`,
    )
    const migrationsAppliedByNew = fp2.migrations.filter((id) => !fp1.migrations.includes(id))
    await log.write(`migrations applied by new binary: ${JSON.stringify(migrationsAppliedByNew)}`)
    const schemaChanged = fp2.schemaSha256 !== fp1.schemaSha256
    await log.write(`schema fingerprint changed by new binary: ${schemaChanged}`)
    runs.push({
      phase: "run2-new",
      binary: "new",
      version: neu.version,
      fd: [fd2, fd2b],
      fingerprints: fp2,
      migrationsAppliedByNew,
      schemaChanged,
    })

    // ============ Run 3: OLD again on the same state ============
    await log.write("=== RUN 3: old binary again on the same state (rollback) ===")
    currentPhase = "run3-old"
    running = await startServer(cfg, cfg.oldBin, "run3-old", baseEnv)
    healthByPhase["run3-old"] = running.health
    await log.write(`run3 old server pid=${running.identity.pid} startTicks=${running.identity.startTicks}`)
    const fd3 = await fdObserve(running)
    await log.write(`run3 fd observation: ${JSON.stringify(fd3)}`)
    const snap3 = await snapshot(rest)
    await stopServer(running, cfg)
    await log.write("run3 old server stopped; writer stopped verified")

    // Semantic comparison: run1 old records vs run3; run2 new records vs run3.
    const oldIds = [parent.id, child.id]
    const newIds = [newSession.id]
    const pick = (s: Snapshot, ids: Array<string>) => ({
      sessions: s.sessions.filter((x) => ids.includes(x.id as string)),
      messages: Object.fromEntries(ids.map((id) => [id, s.messages[id] ?? []])),
      todos: Object.fromEntries(ids.map((id) => [id, s.todos[id] ?? []])),
      children: Object.fromEntries(ids.map((id) => [id, s.children[id] ?? []])),
    })
    const oldDiffsRun3 = semanticDiff(pick(snap1, oldIds), pick(snap3, oldIds))
    const newDiffsRun3 = semanticDiff(pick(snap2, newIds), pick(snap3, newIds))
    await log.write(`run3 old-record diffs: ${JSON.stringify(oldDiffsRun3).slice(0, 2000)}`)
    await log.write(`run3 new-record diffs: ${JSON.stringify(newDiffsRun3).slice(0, 2000)}`)
    const fp3 = await fingerprints(cfg.oldBin, cfg, baseEnv)
    await log.write(
      `run3 fingerprints: ${JSON.stringify({ ...fp3, migrations: fp3.migrations.length + " migrations" })}`,
    )
    runs.push({ phase: "run3-old", binary: "old", version: old.version, fd: [fd3], fingerprints: fp3 })

    const samePathProof = {
      run1: fd1.observed && fd1.dbFiles.length > 0,
      run2: (fd2.observed && fd2.dbFiles.length > 0) || (fd2b.observed && fd2b.dbFiles.length > 0),
      run3: fd3.observed && fd3.dbFiles.length > 0,
      pinnedOutputs: { old: oldPinned, new: newPinned },
    }
    result.samePathProof = samePathProof
    result.semantic = {
      oldRecords: { equal: oldDiffsRun3.length === 0, diffs: oldDiffsRun3 },
      newRecords: { equal: newDiffsRun3.length === 0, diffs: newDiffsRun3 },
      volatileFieldsIgnored: [...VOLATILE_PATHS],
    }
    result.integrity = { run1: fp1.integrity, run2: fp2.integrity, run3: fp3.integrity }
    result.schemaFingerprints = {
      run1: fp1.schemaSha256,
      run2: fp2.schemaSha256,
      run3: fp3.schemaSha256,
      changed: schemaChanged || fp3.schemaSha256 !== fp1.schemaSha256,
    }
    result.migrations = {
      run1Count: fp1.migrations.length,
      run2Count: fp2.migrations.length,
      run3Count: fp3.migrations.length,
      appliedByNew: migrationsAppliedByNew,
    }
    result.contamination = []
    for (const phase of ["run1-old", "run1b-old", "run2-new", "run2b-new", "run3-old"]) {
      ;(result.contamination as Array<Json>).push(await contaminationScan(phase))
    }

    // Verdict.
    if (!fd1.observed || !fd2.observed || !fd3.observed) {
      await log.write(
        "NOTE: /proc fd observation incomplete for at least one run; same-path proof relies on pinned `db path` outputs and file identity",
      )
    }
    if (!samePathProof.run1 || !samePathProof.run2 || !samePathProof.run3) {
      fail("same database path was not observed open in every run")
    }
    if (oldDiffsRun3.length > 0)
      fail(`old records not semantically equal after rollback: ${JSON.stringify(oldDiffsRun3).slice(0, 500)}`)
    if (newDiffsRun3.length > 0)
      fail(`new records not semantically equal after rollback: ${JSON.stringify(newDiffsRun3).slice(0, 500)}`)
    for (const [phase, fp] of [
      ["run1", fp1],
      ["run2", fp2],
      ["run3", fp3],
    ] as const) {
      if (fp.integrity !== "ok") fail(`${phase} integrity_check failed: ${fp.integrity}`)
    }
    if (migrationsAppliedByNew.length > 0) {
      await log.write(
        `MIGRATION REPORT: new binary applied migrations ${JSON.stringify(migrationsAppliedByNew)}; old readability after them is proved by run 3`,
      )
    }
    if (spawnedChildCount() !== 0) fail(`rehearsal left ${spawnedChildCount()} spawned server(s) registered`)
    result.cleanup = { spawnedChildrenRemaining: spawnedChildCount() }
    const verdict = result.verdict as Json
    Object.assign(verdict, deriveVerdict(blockers))
    result.finishedAt = new Date().toISOString()
    await writeFile(path.join(cfg.evidenceDir, "task-12-state-compatibility.json"), JSON.stringify(result, null, 2))
    await log.write(`verdict: ${JSON.stringify(verdict)}`)
    await log.flush()
    return blockers.length === 0 ? 0 : 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await killSpawnedChildren()
    result.cleanup = { spawnedChildrenRemaining: spawnedChildCount(), phase: currentPhase }
    await log.write(`FATAL: ${message}`)
    blockers.push(`fatal: ${message}`)
    const readinessBlocked = error instanceof HealthTimeoutError
    const verdict = result.verdict as Json
    Object.assign(verdict, deriveVerdict(blockers, { readinessTimeout: readinessBlocked }))
    result.failure = {
      category: readinessBlocked ? "readiness" : "observed-failure",
      phase: currentPhase,
      message,
    }
    result.finishedAt = new Date().toISOString()
    result.fatalError = message
    await writeFile(path.join(cfg.evidenceDir, "task-12-state-compatibility.json"), JSON.stringify(result, null, 2))
    await log.flush()
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await main()
}
