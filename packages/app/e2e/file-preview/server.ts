// Fail-closed launcher for the packaged file-preview browser suite.
//
// It owns one disposable root (HOME/XDG/config/tmp/state), one backend process
// and one loopback port, and it refuses to run against anything that looks like
// production state. It is used as the Playwright `webServer` command, so the UI
// served to the browser is the binary's own embedded same-origin frontend; no
// Vite or upstream dev server is involved.
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, readlinkSync, realpathSync } from "node:fs"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { createDeniedSymlink, writeDeniedFixture, writeFixtureWorkspace } from "./fixtures"

// Captured before any HOME/XDG override, so production-path checks use the real user.
export const REAL_HOME = process.env.HOME ?? os.homedir()

export const DEFAULT_TEST_PORT = 4196
export const RESERVED_PORTS = [4096, 4097]

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]+$/

// Prefixes/suffixes of provider and credential variables that must never reach
// the fixture backend. OPENCODE_* is stripped wholesale and replaced with the
// explicit isolated set below.
const BLOCKED_PREFIXES = [
  "OPENCODE_",
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "GEMINI_",
  "GOOGLE_GENERATIVE_",
  "OPENROUTER_",
  "GROQ_",
  "MISTRAL_",
  "DEEPSEEK_",
  "TOGETHER_",
  "FIREWORKS_",
  "PERPLEXITY_",
  "COHERE_",
  "VOYAGE_",
  "XAI_",
  "HUGGING_FACE_",
  "HUGGINGFACE_",
  "HF_",
  "GITHUB_",
  "GH_",
]
const BLOCKED_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]
const BLOCKED_EXACT = ["NODE_OPTIONS", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]

export type ServerConfig = {
  bin: string
  testRoot: string
  buildId: string
  port: number
  hostname: string
  home: string
  xdgConfig: string
  xdgData: string
  xdgState: string
  xdgCache: string
  tmpdir: string
  configDir: string
  configFile: string
  workspace: string
  logFile: string
  pidFile: string
  username: string
  password: string
}

export type ProcessIdentity = { pid: number; exe: string; startTicks: string }

export type RunningServer = {
  child: ChildProcess
  identity: ProcessIdentity
  config: ServerConfig
  baseURL: string
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`file-preview runner: required environment variable ${name} is missing or empty`)
  return value
}

export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (BLOCKED_EXACT.includes(key)) continue
    if (BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    if (BLOCKED_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue
    out[key] = value
  }
  return out
}

export function assertPortAllowed(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`file-preview runner: invalid port ${port}`)
  if (RESERVED_PORTS.includes(port)) {
    throw new Error(`file-preview runner: port ${port} is reserved for production/upgrade state and is refused`)
  }
}

export function assertTestRootSafe(testRoot: string, realHome = REAL_HOME): void {
  if (!path.isAbsolute(testRoot)) throw new Error(`file-preview runner: FILE_PREVIEW_TEST_ROOT must be absolute, got ${testRoot}`)
  const normalized = path.resolve(testRoot)
  const forbidden = [
    path.join(realHome, ".local", "share", "opencode"),
    path.join(realHome, ".config", "opencode"),
  ]
  for (const base of forbidden) {
    if (normalized === base || normalized.startsWith(base + path.sep)) {
      throw new Error(`file-preview runner: FILE_PREVIEW_TEST_ROOT resolves under production state (${base})`)
    }
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const bin = requireEnv(env, "FILE_PREVIEW_BIN")
  if (!path.isAbsolute(bin)) throw new Error(`file-preview runner: FILE_PREVIEW_BIN must be absolute, got ${bin}`)
  const testRoot = requireEnv(env, "FILE_PREVIEW_TEST_ROOT")
  const buildId = requireEnv(env, "FILE_PREVIEW_BUILD_ID")
  if (!BUILD_ID_PATTERN.test(buildId)) {
    throw new Error(`file-preview runner: FILE_PREVIEW_BUILD_ID must match ${BUILD_ID_PATTERN}, got ${buildId}`)
  }
  const port = env.FILE_PREVIEW_TEST_PORT ? Number(env.FILE_PREVIEW_TEST_PORT) : DEFAULT_TEST_PORT
  assertPortAllowed(port)
  assertTestRootSafe(testRoot)

  const configDir = path.join(testRoot, "config")
  return {
    bin,
    testRoot,
    buildId,
    port,
    hostname: "127.0.0.1",
    home: path.join(testRoot, "home"),
    xdgConfig: path.join(testRoot, "xdg", "config"),
    xdgData: path.join(testRoot, "xdg", "data"),
    xdgState: path.join(testRoot, "xdg", "state"),
    xdgCache: path.join(testRoot, "xdg", "cache"),
    tmpdir: path.join(testRoot, "tmp"),
    configDir,
    configFile: path.join(configDir, "opencode.json"),
    workspace: path.join(testRoot, "workspace"),
    logFile: path.join(testRoot, "backend.log"),
    pidFile: path.join(testRoot, "backend-pid.json"),
    username: "fixture",
    password: "fixture-only",
  }
}

async function assertTestRootFresh(testRoot: string): Promise<void> {
  const info = await stat(testRoot).catch(() => undefined)
  if (info === undefined) return
  if (!info.isDirectory()) throw new Error(`file-preview runner: FILE_PREVIEW_TEST_ROOT exists and is not a directory: ${testRoot}`)
  const entries = await readdir(testRoot)
  if (entries.length > 0) {
    throw new Error(`file-preview runner: FILE_PREVIEW_TEST_ROOT already exists and is nonempty: ${testRoot}`)
  }
}

export function assertPortFree(hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", () => reject(new Error(`file-preview runner: port ${port} is already in use on ${hostname}`)))
    probe.once("listening", () => probe.close(() => resolve()))
    probe.listen(port, hostname)
  })
}

const FIXTURE_CONFIG = { plugin: [], mcp: {} }

// The file watcher backend only subscribes to workspace changes for VCS locations
// with OPENCODE_EXPERIMENTAL_FILEWATCHER enabled (core/filesystem/watcher.ts), so the
// fixture workspace is git-initialized and the flag set before the backend starts.
export async function prepareRoots(config: ServerConfig): Promise<void> {
  for (const dir of [config.testRoot, config.home, config.xdgConfig, config.xdgData, config.xdgState, config.xdgCache, config.tmpdir, config.configDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }
  await Bun.write(config.configFile, JSON.stringify(FIXTURE_CONFIG, null, 2))
  await writeFixtureWorkspace(config.testRoot)
  await writeDeniedFixture(config.testRoot)
  await createDeniedSymlink(config.testRoot)
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", config.workspace])
  if (init.exitCode !== 0) {
    throw new Error(`file-preview runner: git init failed for ${config.workspace}: ${init.stderr.toString().trim()}`)
  }
}

export function backendEnv(config: ServerConfig): Record<string, string> {
  return {
    ...sanitizeEnv(process.env),
    HOME: config.home,
    XDG_CONFIG_HOME: config.xdgConfig,
    XDG_DATA_HOME: config.xdgData,
    XDG_STATE_HOME: config.xdgState,
    XDG_CACHE_HOME: config.xdgCache,
    TMPDIR: config.tmpdir,
    OPENCODE_CONFIG: config.configFile,
    OPENCODE_CONFIG_DIR: config.configDir,
    OPENCODE_SERVER_USERNAME: config.username,
    OPENCODE_SERVER_PASSWORD: config.password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    FILE_PREVIEW_BUILD_ID: config.buildId,
  }
}

function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return target
  }
}

function readStartTicks(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // field 22 is starttime; fields after the comm field (which may contain spaces) are stable.
    const close = stat.lastIndexOf(")")
    return stat.slice(close + 2).split(" ")[19] ?? ""
  } catch {
    return ""
  }
}

function exeOf(pid: number): string {
  try {
    return realpathSync(readlinkSync(`/proc/${pid}/exe`))
  } catch {
    return ""
  }
}

export async function verifyIdentity(identity: ProcessIdentity): Promise<boolean> {
  if (exeOf(identity.pid) !== realpathOrSelf(identity.exe)) return false
  const ticks = readStartTicks(identity.pid)
  return ticks !== "" && ticks === identity.startTicks
}

async function waitForHealth(config: ServerConfig, child: ChildProcess, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const auth = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64")
  const url = `http://${config.hostname}:${config.port}/global/health`
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      const log = await Bun.file(config.logFile).text().catch(() => "")
      throw new Error(`file-preview runner: backend exited early (code ${child.exitCode}, signal ${child.signalCode})\n${log.slice(-2000)}`)
    }
    // A connection accepted while the server is still booting can stay unanswered;
    // bound every probe so the readiness loop cannot hang on one socket.
    const response = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    if (response?.ok) {
      // The backend can answer authorized requests before its auth layer is
      // fully armed; readiness requires that unauthenticated requests are
      // already denied so no test runs inside the arming window.
      const anonymous = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
      if (anonymous?.status === 401) return
    }
    await Bun.sleep(250)
  }
  throw new Error(`file-preview runner: backend health check timed out at ${url}`)
}

// The owned child of the current process. The shutdown handler is installed
// before start() so a signal during the readiness wait is still cleaned up.
let active: RunningServer | undefined

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export async function start(config: ServerConfig): Promise<RunningServer> {
  await assertTestRootFresh(config.testRoot)
  assertPortAllowed(config.port)
  await assertPortFree(config.hostname, config.port)
  await prepareRoots(config)

  const logHandle = Bun.file(config.logFile).writer()
  const child = spawn(config.bin, ["serve", "--port", String(config.port), "--hostname", config.hostname], {
    cwd: config.workspace,
    env: backendEnv(config),
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk) => logHandle.write(chunk))
  child.stderr?.on("data", (chunk) => logHandle.write(chunk))

  if (child.pid === undefined) throw new Error("file-preview runner: backend failed to spawn (no pid)")
  const identity: ProcessIdentity = {
    pid: child.pid,
    exe: realpathOrSelf(config.bin),
    startTicks: readStartTicks(child.pid),
  }
  const running: RunningServer = { child, identity, config, baseURL: `http://${config.hostname}:${config.port}` }
  active = running
  try {
    await Bun.write(config.pidFile, JSON.stringify({ ...identity, buildId: config.buildId, port: config.port }, null, 2))
    await waitForHealth(config, child)
  } catch (error) {
    await stop(running).catch(() => {})
    throw error
  }
  await logHandle.flush()
  return running
}

export async function stop(running: RunningServer): Promise<void> {
  try {
    if (!(await verifyIdentity(running.identity))) {
      // A child that is already gone (no executable link) is the desired end
      // state; a live pid whose executable or start tick changed is never signalled.
      if (exeOf(running.identity.pid) === "") return
      throw new Error(`file-preview runner: refusing to stop pid ${running.identity.pid}; process identity no longer matches`)
    }
    running.child.kill("SIGTERM")
    const deadline = Date.now() + 10_000
    while (!hasExited(running.child) && Date.now() < deadline) await Bun.sleep(50)
    if (!hasExited(running.child) && (await verifyIdentity(running.identity))) {
      running.child.kill("SIGKILL")
      const killDeadline = Date.now() + 5_000
      while (!hasExited(running.child) && Date.now() < killDeadline) await Bun.sleep(50)
    }
  } finally {
    if (active === running) active = undefined
  }
}

export async function cleanupRoot(config: ServerConfig): Promise<void> {
  await rm(config.testRoot, { recursive: true, force: true })
}

if (import.meta.main) {
  let stopping: Promise<void> | undefined
  const shutdown = () => {
    if (stopping) return
    console.log("file-preview fixture backend stopping")
    stopping = (active ? stop(active) : Promise.resolve())
      .catch((error) => console.error(String(error)))
      .finally(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  process.on("SIGHUP", shutdown)
  const config = resolveConfig()
  const running = await start(config)
  console.log(`file-preview fixture backend ready at ${running.baseURL}`)
  await new Promise(() => {})
}
