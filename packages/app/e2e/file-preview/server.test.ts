// Runner guard tests. These prove the launcher fails closed before spawning
// anything. Run from packages/app: `bun test e2e/file-preview/server.test.ts`.
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_TEST_PORT,
  REAL_HOME,
  assertPortAllowed,
  assertPortFree,
  assertTestRootSafe,
  backendEnv,
  prepareRoots,
  resolveConfig,
  sanitizeEnv,
  start,
  stop,
  verifyIdentity,
  type ProcessIdentity,
  type RunningServer,
} from "./server"

const validEnv = {
  FILE_PREVIEW_BIN: "/tmp/opencode/opencode-fixture",
  FILE_PREVIEW_TEST_ROOT: "/tmp/opencode/file-preview-guard-root",
  FILE_PREVIEW_BUILD_ID: "guard-build-1",
}

describe("resolveConfig", () => {
  test("throws when FILE_PREVIEW_BIN is missing", () => {
    expect(() => resolveConfig({ ...validEnv, FILE_PREVIEW_BIN: "" })).toThrow(/FILE_PREVIEW_BIN/)
  })

  test("throws when FILE_PREVIEW_TEST_ROOT is missing", () => {
    expect(() => resolveConfig({ ...validEnv, FILE_PREVIEW_TEST_ROOT: undefined })).toThrow(/FILE_PREVIEW_TEST_ROOT/)
  })

  test("throws when FILE_PREVIEW_BUILD_ID has an invalid pattern", () => {
    expect(() => resolveConfig({ ...validEnv, FILE_PREVIEW_BUILD_ID: "bad build id" })).toThrow(/FILE_PREVIEW_BUILD_ID/)
  })

  test("refuses reserved port 4096", () => {
    expect(() => resolveConfig({ ...validEnv, FILE_PREVIEW_TEST_PORT: "4096" })).toThrow(/reserved/)
  })

  test("defaults to loopback port 4196", () => {
    const config = resolveConfig(validEnv)
    expect(config.port).toBe(DEFAULT_TEST_PORT)
    expect(config.hostname).toBe("127.0.0.1")
    expect(config.bin).toBe(validEnv.FILE_PREVIEW_BIN)
  })
})

describe("assertPortAllowed", () => {
  test("refuses 4096 and 4097", () => {
    expect(() => assertPortAllowed(4096)).toThrow(/reserved/)
    expect(() => assertPortAllowed(4097)).toThrow(/reserved/)
  })

  test("refuses out-of-range ports", () => {
    expect(() => assertPortAllowed(0)).toThrow(/invalid port/)
    expect(() => assertPortAllowed(70_000)).toThrow(/invalid port/)
  })
})

describe("assertPortFree", () => {
  test("refuses a busy listener", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
    const port = blocker.port
    if (port === undefined) throw new Error("Bun.serve did not report a port")
    try {
      const error = await assertPortFree("127.0.0.1", port).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(String(error)).toMatch(/already in use/)
    } finally {
      await blocker.stop(true)
    }
  })
})

describe("assertTestRootSafe", () => {
  test("refuses a root under production config state", () => {
    expect(() => assertTestRootSafe("/home/prod/.config/opencode/tmp", "/home/prod")).toThrow(/production/)
  })

  test("refuses a root under production data state", () => {
    expect(() => assertTestRootSafe("/home/prod/.local/share/opencode", "/home/prod")).toThrow(/production/)
  })

  test("refuses a relative root and accepts an owned root", () => {
    expect(() => assertTestRootSafe("relative/root", "/home/prod")).toThrow(/absolute/)
    expect(() => assertTestRootSafe("/tmp/opencode/owned-root", REAL_HOME)).not.toThrow()
  })
})

describe("sanitizeEnv", () => {
  test("strips provider credentials and config pointers but keeps neutral values", () => {
    const sanitized = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "C",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      OPENCODE_CONFIG: "/home/user/.config/opencode/opencode.json",
      OPENCODE_SERVER_PASSWORD: "production-password",
      MY_SERVICE_TOKEN: "token",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NODE_OPTIONS: "--require evil",
    })
    expect(sanitized.PATH).toBe("/usr/bin")
    expect(sanitized.HOME).toBe("/home/user")
    expect(sanitized.LANG).toBe("C")
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined()
    expect(sanitized.OPENAI_API_KEY).toBeUndefined()
    expect(sanitized.GH_TOKEN).toBeUndefined()
    expect(sanitized.GITHUB_TOKEN).toBeUndefined()
    expect(sanitized.OPENCODE_CONFIG).toBeUndefined()
    expect(sanitized.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(sanitized.MY_SERVICE_TOKEN).toBeUndefined()
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(sanitized.NODE_OPTIONS).toBeUndefined()
  })
})

describe("backendEnv", () => {
  test("sets the experimental file watcher flag and strips ambient OPENCODE_* overrides", () => {
    const config = resolveConfig(validEnv)
    const env = backendEnv(config)
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
    const ambient = sanitizeEnv({
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "false",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
    })
    expect(ambient.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBeUndefined()
    expect(ambient.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER).toBeUndefined()
  })
})

describe("prepareRoots", () => {
  test("git-initializes the fixture workspace before backend start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "file-preview-roots-guard-"))
    try {
      const config = resolveConfig({ ...validEnv, FILE_PREVIEW_TEST_ROOT: root })
      await prepareRoots(config)
      const gitDir = await stat(path.join(config.workspace, ".git"))
      expect(gitDir.isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const wrapperBinary = process.env.FILE_PREVIEW_BIN
const wrapperBinaryReady = wrapperBinary !== undefined && existsSync(wrapperBinary)

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (predicate()) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(poll, 50)
    }
    poll()
  })
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = server.port
  if (port === undefined) throw new Error("Bun.serve did not report a port")
  await server.stop(true)
  return port
}

async function launchWrapper(): Promise<{
  child: ReturnType<typeof spawn>
  root: string
  port: number
  pidFile: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-preview-wrapper-"))
  const port = await freePort()
  const child = spawn(process.execPath, ["e2e/file-preview/server.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FILE_PREVIEW_BIN: wrapperBinary!,
      FILE_PREVIEW_TEST_ROOT: root,
      FILE_PREVIEW_BUILD_ID: "wrapper-teardown",
      FILE_PREVIEW_TEST_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { child, root, port, pidFile: path.join(root, "backend-pid.json") }
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
    }
    const onData = (chunk: Buffer) => {
      if (!String(chunk).includes("ready at")) return
      cleanup()
      resolve()
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`wrapper exited before ready (code ${code})`))
    }
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
  })
}

// Test-only cleanup after a failed assertion; identity checked before signalling.
async function killOwnedBackend(root: string): Promise<void> {
  const identity = (await Bun.file(path.join(root, "backend-pid.json"))
    .json()
    .catch(() => undefined)) as ProcessIdentity | undefined
  if (identity === undefined) return
  if (!(await verifyIdentity(identity))) return
  process.kill(identity.pid, "SIGKILL")
}

describe("wrapper termination (actual subprocess)", () => {
  test.skipIf(!wrapperBinaryReady)(
    "SIGTERM after ready stops the owned backend and frees the port",
    async () => {
      const wrapper = await launchWrapper()
      try {
        await waitForReady(wrapper.child)
        const identity = (await Bun.file(wrapper.pidFile).json()) as ProcessIdentity
        expect(existsSync(`/proc/${identity.pid}`)).toBe(true)
        wrapper.child.kill("SIGTERM")
        const code = await new Promise<number | null>((resolve) => wrapper.child.once("exit", resolve))
        expect(code).toBe(0)
        expect(await waitUntil(() => !existsSync(`/proc/${identity.pid}`), 15_000)).toBe(true)
        await assertPortFree("127.0.0.1", wrapper.port)
        expect(existsSync(wrapper.root)).toBe(true)
      } finally {
        wrapper.child.kill("SIGKILL")
        await killOwnedBackend(wrapper.root)
        await rm(wrapper.root, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.skipIf(!wrapperBinaryReady)(
    "SIGTERM during startup stops the backend it already spawned",
    async () => {
      const wrapper = await launchWrapper()
      try {
        expect(await waitUntil(() => existsSync(wrapper.pidFile), 120_000)).toBe(true)
        const identity = (await Bun.file(wrapper.pidFile).json()) as ProcessIdentity
        expect(existsSync(`/proc/${identity.pid}`)).toBe(true)
        wrapper.child.kill("SIGTERM")
        expect(await waitUntil(() => !existsSync(`/proc/${identity.pid}`), 15_000)).toBe(true)
        await assertPortFree("127.0.0.1", wrapper.port)
        expect(existsSync(wrapper.root)).toBe(true)
      } finally {
        wrapper.child.kill("SIGKILL")
        await killOwnedBackend(wrapper.root)
        await rm(wrapper.root, { recursive: true, force: true })
      }
    },
    240_000,
  )
})

describe("stop", () => {
  test("refuses a pid whose executable no longer matches", async () => {
    let killed = false
    const running = {
      child: {
        kill: () => {
          killed = true
        },
      },
      identity: { pid: process.pid, exe: "/bin/definitely-not-this-process", startTicks: "0" },
      config: {},
      baseURL: "http://127.0.0.1:4196",
    } as unknown as RunningServer
    const error = await stop(running).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(String(error)).toMatch(/identity no longer matches/)
    expect(killed).toBe(false)
  })
})

type FakeEvent = { path: string; auth: "basic" | "anon"; status: number; at: number }
type FakeBackendIdentity = ProcessIdentity & { script: string }
type FakeLaunch = {
  child: ReturnType<typeof spawn>
  root: string
  binDir: string
  events: string
  arm: string
  port: number
  identity: FakeBackendIdentity
}

const fakeBackendSource = path.resolve(import.meta.dir, "readiness-fake-backend.ts")
const configEnv = {
  FILE_PREVIEW_BIN: validEnv.FILE_PREVIEW_BIN,
  FILE_PREVIEW_TEST_ROOT: validEnv.FILE_PREVIEW_TEST_ROOT,
  FILE_PREVIEW_BUILD_ID: validEnv.FILE_PREVIEW_BUILD_ID,
  FILE_PREVIEW_TEST_PORT: "4196",
}

function parseFakeEvent(value: unknown): FakeEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined
  if (!("path" in value) || !("auth" in value) || !("status" in value) || !("at" in value)) return undefined
  const { path, auth, status, at } = value
  if (typeof path !== "string" || (auth !== "basic" && auth !== "anon")) return undefined
  if (typeof status !== "number" || typeof at !== "number") return undefined
  return { path, auth, status, at }
}

function readFakeEvents(file: string): FakeEvent[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): unknown => JSON.parse(line))
      .map(parseFakeEvent)
      .filter((event): event is FakeEvent => event !== undefined)
  } catch {
    return []
  }
}

function readCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
  } catch {
    return []
  }
}

function isLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"
  } catch {
    return false
  }
}

async function verifyOwnFakeBackend(identity: FakeBackendIdentity): Promise<boolean> {
  if (!(await verifyIdentity(identity))) return false
  return readCmdline(identity.pid).includes(identity.script)
}

async function discoverFakeBackend(launch: Omit<FakeLaunch, "identity">): Promise<FakeBackendIdentity> {
  const pidFile = path.join(launch.root, "backend-pid.json")
  if (!(await waitUntil(() => existsSync(pidFile), 60_000))) {
    throw new Error(`readiness fake backend: pid file did not appear at ${pidFile}`)
  }
  const raw: unknown = await Bun.file(pidFile)
    .json()
    .catch(() => undefined)
  if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("startTicks" in raw)) {
    throw new Error(`readiness fake backend: malformed pid file at ${pidFile}`)
  }
  const pid = raw.pid
  const startTicks = raw.startTicks
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof startTicks !== "string" ||
    startTicks === ""
  ) {
    throw new Error(`readiness fake backend: pid/startTicks invalid in ${pidFile}`)
  }
  const identity: FakeBackendIdentity = {
    pid,
    exe: realpathSync(process.execPath),
    startTicks,
    script: fakeBackendSource,
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await verifyOwnFakeBackend(identity)) return identity
    if (!isLive(pid)) break
    await Bun.sleep(50)
  }
  throw new Error(
    `readiness fake backend: pid ${pid} failed exe/startTicks/script ownership verification; root preserved at ${launch.root}`,
  )
}

async function writeFakeLauncher(binDir: string): Promise<string> {
  const bin = path.join(binDir, "fake-backend.sh")
  await Bun.write(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeBackendSource)} "$@"\n`,
  )
  await chmod(bin, 0o755)
  return bin
}

async function launchFakeWrapper(armed: boolean): Promise<FakeLaunch> {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-preview-fake-root-"))
  const binDir = await mkdtemp(path.join(os.tmpdir(), "file-preview-fake-bin-"))
  const bin = await writeFakeLauncher(binDir)
  const events = path.join(binDir, "events.jsonl")
  const arm = path.join(binDir, "arm")
  if (armed) await Bun.write(arm, "")
  const port = await freePort()
  const child = spawn(process.execPath, ["e2e/file-preview/server.ts"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FILE_PREVIEW_BIN: bin,
      FILE_PREVIEW_TEST_ROOT: root,
      FILE_PREVIEW_BUILD_ID: "readiness-fake",
      FILE_PREVIEW_TEST_PORT: String(port),
      FILE_PREVIEW_FAKE_EVENTS: events,
      FILE_PREVIEW_FAKE_ARM: arm,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const base = { child, root, binDir, events, arm, port }
  try {
    const identity = await discoverFakeBackend(base)
    return { ...base, identity }
  } catch (error) {
    const wrapperStop = await stopOwnedWrapper(child).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    if (wrapperStop !== undefined) {
      throw new AggregateError([error, wrapperStop], "readiness fake wrapper cleanup failed")
    }
    throw error
  }
}

function collectStdout(child: ReturnType<typeof spawn>): () => string {
  let text = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString()
  })
  return () => text
}

function signalIfPresent(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function stopOwnedFakeBackend(identity: FakeBackendIdentity, root: string): Promise<void> {
  const refuse = (reason: string): never => {
    throw new Error(`readiness fake backend: ${reason}; not signalling, root preserved at ${root}`)
  }
  if (!(await verifyOwnFakeBackend(identity))) {
    if (!isLive(identity.pid)) return
    refuse(`pid ${identity.pid} is live but its exe/startTicks/script no longer match`)
  }
  signalIfPresent(identity.pid, "SIGTERM")
  if (await waitUntil(() => !isLive(identity.pid), 15_000)) return
  if (!(await verifyOwnFakeBackend(identity))) {
    refuse(`pid ${identity.pid} identity changed during the grace period`)
  }
  signalIfPresent(identity.pid, "SIGKILL")
  if (!(await waitUntil(() => !isLive(identity.pid), 5_000))) {
    refuse(`pid ${identity.pid} is still live after SIGKILL`)
  }
}

async function stopOwnedWrapper(child: ReturnType<typeof spawn>): Promise<void> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (!exited()) child.kill("SIGTERM")
  if (await waitUntil(exited, 20_000)) return
  if (!exited()) child.kill("SIGKILL")
  if (!(await waitUntil(exited, 10_000))) {
    throw new Error(`readiness fake wrapper: pid ${child.pid} did not reach a terminal exit; root preserved`)
  }
}

async function cleanupFake(launch: FakeLaunch): Promise<void> {
  await stopOwnedFakeBackend(launch.identity, launch.root)
  if (isLive(launch.identity.pid)) {
    throw new Error(`readiness fake backend: pid ${launch.identity.pid} still live; root preserved at ${launch.root}`)
  }
  await stopOwnedWrapper(launch.child)
  await rm(launch.root, { recursive: true, force: true })
  await rm(launch.binDir, { recursive: true, force: true })
}

describe("readiness config contract", () => {
  test("waits on the wrapper ready line and keeps no url probe", async () => {
    const saved = Object.keys(configEnv).map((key) => [key, process.env[key]] as const)
    Object.assign(process.env, configEnv)
    try {
      const config = (await import("../../playwright.file-preview.config")).default
      const webServer = config.webServer
      if (webServer === undefined || Array.isArray(webServer)) throw new Error("expected one webServer entry")
      expect(webServer.url).toBeUndefined()
      const stdout = webServer.wait?.stdout
      if (!(stdout instanceof RegExp)) throw new Error("config.webServer.wait.stdout must be a RegExp")
      expect(stdout.test("file-preview fixture backend ready at http://127.0.0.1:4196")).toBe(true)
      expect(stdout.test("file-preview fixture backend stopping")).toBe(false)
      expect(config.use?.baseURL).toBe("http://127.0.0.1:4196")
      const source = await Bun.file(path.resolve(import.meta.dir, "server.ts")).text()
      expect(source).toContain("file-preview fixture backend ready at")
      expect(source).toContain("file-preview fixture backend stopping")
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe("start port refusal", () => {
  test("refuses a busy port before spawning the backend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "file-preview-busy-root-"))
    const binDir = await mkdtemp(path.join(os.tmpdir(), "file-preview-busy-bin-"))
    const bin = await writeFakeLauncher(binDir)
    const events = path.join(binDir, "events.jsonl")
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") })
    const port = blocker.port
    if (port === undefined) throw new Error("Bun.serve did not report a port")
    try {
      const config = resolveConfig({
        ...validEnv,
        FILE_PREVIEW_BIN: bin,
        FILE_PREVIEW_TEST_ROOT: root,
        FILE_PREVIEW_TEST_PORT: String(port),
      })
      const error = await start(config).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(String(error)).toMatch(/already in use/)
      expect(existsSync(events)).toBe(false)
    } finally {
      await blocker.stop(true)
      await rm(root, { recursive: true, force: true })
      await rm(binDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("stdout readiness ordering (actual wrapper subprocess)", () => {
  test("prints ready only after an authed 200 and an anonymous 401", async () => {
    const launch = await launchFakeWrapper(true)
    try {
      const stdout = collectStdout(launch.child)
      expect(await waitUntil(() => stdout().includes("file-preview fixture backend ready at"), 60_000)).toBe(true)
      const health = readFakeEvents(launch.events).filter((event) => event.path === "/global/health")
      const firstBasic = health.findIndex((event) => event.auth === "basic" && event.status === 200)
      const firstAnon401 = health.findIndex((event) => event.auth === "anon" && event.status === 401)
      expect(firstBasic).toBeGreaterThanOrEqual(0)
      expect(firstAnon401).toBeGreaterThan(firstBasic)
      expect(health.some((event) => event.auth === "anon" && event.status === 200)).toBe(false)
    } finally {
      await cleanupFake(launch)
    }
  }, 120_000)

  test("anonymous 200 alone never readies; arming 401 completes readiness", async () => {
    const launch = await launchFakeWrapper(false)
    try {
      const stdout = collectStdout(launch.child)
      const sawAuthedAfterAnon200 = (): boolean => {
        const health = readFakeEvents(launch.events).filter((event) => event.path === "/global/health")
        const firstAnon200 = health.findIndex((event) => event.auth === "anon" && event.status === 200)
        return (
          firstAnon200 >= 0 &&
          health.slice(firstAnon200 + 1).some((event) => event.auth === "basic" && event.status === 200)
        )
      }
      expect(await waitUntil(sawAuthedAfterAnon200, 60_000)).toBe(true)
      const before = readFakeEvents(launch.events).filter((event) => event.path === "/global/health")
      expect(before.some((event) => event.auth === "anon" && event.status === 401)).toBe(false)
      expect(stdout()).not.toContain("file-preview fixture backend ready at")
      await Bun.write(launch.arm, "")
      expect(await waitUntil(() => stdout().includes("file-preview fixture backend ready at"), 60_000)).toBe(true)
      const health = readFakeEvents(launch.events).filter((event) => event.path === "/global/health")
      const lastAnonymous = [...health].reverse().find((event) => event.auth === "anon")
      expect(lastAnonymous?.status).toBe(401)
    } finally {
      await cleanupFake(launch)
    }
  }, 150_000)
})

describe("owned fake backend teardown", () => {
  test("refuses a stale startTicks and preserves the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "file-preview-stale-identity-"))
    const marker = path.join(root, "marker")
    await Bun.write(marker, "keep")
    try {
      const identity: FakeBackendIdentity = {
        pid: process.pid,
        exe: realpathSync(process.execPath),
        startTicks: "0",
        script: fakeBackendSource,
      }
      const error = await stopOwnedFakeBackend(identity, root).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(String(error)).toMatch(/not signalling/)
      expect(existsSync(marker)).toBe(true)
      expect(isLive(process.pid)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
