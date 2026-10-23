// Task 12 guard tests: prove the upgrade rehearsal fails closed before any
// spawn and never hides an unsafe state transition. Every case is real: real
// binaries, real processes, real sqlite files. No .skip, no dry-run success.
//
// Run from SOURCE_ROOT: bun test ./scripts/file-preview/verify-upgrade.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { Database as SqliteDatabase } from "bun:sqlite"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { REAL_HOME, assertPortFree } from "../../packages/app/e2e/file-preview/server"
import {
  assertNewIdentity,
  assertOldIdentity,
  assertRootFresh,
  assertSamePinnedPath,
  binVersion,
  childEnv,
  dbHolders,
  defaultDbPath,
  fingerprints,
  parseArgs,
  run,
  semanticDiff,
  spawnedChildCount,
  startServer,
  DEPLOYMENT_READINESS_BLOCKER,
  deriveVerdict,
  type UpgradeConfig,
} from "./verify-upgrade"

const OLD_BIN = process.env.FILE_PREVIEW_OLD_BIN ?? "/usr/bin/opencode"
const NEW_BIN =
  process.env.FILE_PREVIEW_NEW_BIN ??
  "/home/audiophil/Projects/running/opencode-file-preview/builds/file-preview-1.19.3-g17af75887f6f/opencode"
const EVIDENCE_DIR =
  process.env.FILE_PREVIEW_EVIDENCE_DIR ??
  "/home/audiophil/Projects/running/opencode-file-preview/.omo/evidence/opencode-file-preview/a3"

const guardResults: Array<{ name: string; outcome: string }> = []

function tmpRoot(label: string): string {
  const root = path.join(
    "/tmp",
    `verify-upgrade-guard-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function baseConfig(testRoot: string): UpgradeConfig {
  return parseArgs({
    FILE_PREVIEW_OLD_BIN: OLD_BIN,
    FILE_PREVIEW_NEW_BIN: NEW_BIN,
    FILE_PREVIEW_TEST_ROOT: testRoot,
    FILE_PREVIEW_TEST_PORT: "4197",
  })
}

function record(name: string, outcome: string) {
  guardResults.push({ name, outcome })
}

afterAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 })
  const lines = guardResults.map((r) => `${r.outcome}: ${r.name}`)
  writeFileSync(path.join(EVIDENCE_DIR, "task-12-guards.log"), lines.join("\n") + "\n")
})

describe("parseArgs fail-closed guards", () => {
  test("refuses missing or relative binaries and roots", () => {
    expect(() =>
      parseArgs({ FILE_PREVIEW_OLD_BIN: "", FILE_PREVIEW_NEW_BIN: NEW_BIN, FILE_PREVIEW_TEST_ROOT: "/tmp/x" }),
    ).toThrow(/OLD_BIN/)
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: "builds/opencode",
        FILE_PREVIEW_TEST_ROOT: "/tmp/x",
      }),
    ).toThrow(/NEW_BIN/)
    expect(() => parseArgs({ FILE_PREVIEW_OLD_BIN: OLD_BIN, FILE_PREVIEW_NEW_BIN: NEW_BIN })).toThrow(/TEST_ROOT/)
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: NEW_BIN,
        FILE_PREVIEW_TEST_ROOT: "relative/root",
      }),
    ).toThrow(/absolute/)
    record("parseArgs refuses missing/relative inputs", "pass")
  })

  test("refuses reserved production ports 4096 and 4097", () => {
    const root = tmpRoot("ports")
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: NEW_BIN,
        FILE_PREVIEW_TEST_ROOT: root,
        FILE_PREVIEW_TEST_PORT: "4096",
      }),
    ).toThrow(/reserved/)
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: NEW_BIN,
        FILE_PREVIEW_TEST_ROOT: root,
        FILE_PREVIEW_TEST_PORT: "4097",
      }),
    ).toThrow(/reserved/)
    rmSync(root, { recursive: true, force: true })
    record("parseArgs refuses ports 4096/4097", "pass")
  })

  test("refuses roots and db paths under production state", () => {
    const productionRoot = path.join(REAL_HOME, ".local", "share", "opencode", "task12-guard")
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: NEW_BIN,
        FILE_PREVIEW_TEST_ROOT: productionRoot,
      }),
    ).toThrow(/production/)
    const productionConfig = path.join(REAL_HOME, ".config", "opencode", "task12-guard")
    expect(() =>
      parseArgs({
        FILE_PREVIEW_OLD_BIN: OLD_BIN,
        FILE_PREVIEW_NEW_BIN: NEW_BIN,
        FILE_PREVIEW_TEST_ROOT: productionConfig,
      }),
    ).toThrow(/production/)
    record("parseArgs refuses production-state roots", "pass")
  })

  test("refuses a nonempty existing root", async () => {
    const root = tmpRoot("nonempty")
    writeFileSync(path.join(root, "occupied.txt"), "not empty")
    await expect(assertRootFresh(root)).rejects.toThrow(/nonempty/)
    rmSync(root, { recursive: true, force: true })
    record("assertRootFresh refuses nonempty root", "pass")
  })
})

describe("binary identity guards", () => {
  test("refuses an old binary that is not exactly 1.18.18", async () => {
    const fakeBin = path.join(tmpRoot("fakebin"), "fake-opencode")
    writeFileSync(fakeBin, "#!/bin/sh\necho 1.19.3\n")
    chmodSync(fakeBin, 0o755)
    const cfg = baseConfig(tmpRoot("fakebin-root"))
    const error = await assertOldIdentity(fakeBin, childEnv(cfg)).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(String(error)).toMatch(/1\.18\.18/)
    // Nothing was spawned: the fixture port is still free.
    await assertPortFree("127.0.0.1", cfg.port)
    rmSync(path.dirname(fakeBin), { recursive: true, force: true })
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("assertOldIdentity refuses wrong old version; nothing spawned", "pass")
  })

  test("refuses the new binary presented as the old binary", async () => {
    const cfg = baseConfig(tmpRoot("swap"))
    const error = await assertOldIdentity(NEW_BIN, childEnv(cfg)).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(String(error)).toMatch(/1\.18\.18/)
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("assertOldIdentity refuses new binary as old", "pass")
  })

  test("refuses a new binary whose hash does not match the manifest", async () => {
    const cfg = baseConfig(tmpRoot("manifest"))
    const tampered = path.join(cfg.testRoot, "manifest-tampered.json")
    const manifest = await Bun.file(cfg.manifestPath).json()
    manifest.executable.sha256 = "0".repeat(64)
    await Bun.write(tampered, JSON.stringify(manifest))
    const error = await assertNewIdentity(NEW_BIN, tampered, childEnv(cfg)).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(String(error)).toMatch(/sha256/)
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("assertNewIdentity refuses manifest hash mismatch", "pass")
  })

  test("accepts the real old and new identities", async () => {
    const cfg = baseConfig(tmpRoot("identity-ok"))
    const old = await assertOldIdentity(OLD_BIN, childEnv(cfg))
    expect(old.version).toBe("1.18.18")
    const neu = await assertNewIdentity(NEW_BIN, cfg.manifestPath, childEnv(cfg))
    expect(neu.version).toBe(neu.manifest.version)
    expect(neu.manifest.channel).toBe("file-preview")
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("real old/new identities accepted", "pass")
  })
})

describe("channel db-path guards", () => {
  test("detects the channel-dependent default divergence and requires the pinned path", async () => {
    const cfg = baseConfig(tmpRoot("channel"))
    const unpinned = childEnv(cfg)
    delete unpinned.OPENCODE_DB
    const oldDefault = await defaultDbPath(OLD_BIN, unpinned)
    const newDefault = await defaultDbPath(NEW_BIN, unpinned)
    // The custom build's channel must not silently own a different database.
    expect(oldDefault).not.toBe(newDefault)
    expect(path.basename(newDefault)).toBe("opencode-file-preview.db")
    // Pinned: both binaries must resolve exactly the rehearsal path.
    const pinned = childEnv(cfg)
    const oldPinned = await defaultDbPath(OLD_BIN, pinned)
    const newPinned = await defaultDbPath(NEW_BIN, pinned)
    expect(() =>
      assertSamePinnedPath(
        [
          { bin: OLD_BIN, resolved: oldPinned },
          { bin: NEW_BIN, resolved: newPinned },
        ],
        cfg.dbPath,
      ),
    ).not.toThrow()
    // A divergent pinned resolution is a hard failure.
    expect(() => assertSamePinnedPath([{ bin: NEW_BIN, resolved: newDefault }], cfg.dbPath)).toThrow(/divergence/)
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("channel db-path divergence detected; pinned path enforced", "pass")
    // Four sequential CLI startups measured 1.2-1.9s each, over Bun's 5s per-test default.
  }, 30_000)
})

describe("extra writer detection", () => {
  test("detects a live second writer holding the database open", async () => {
    const root = tmpRoot("writer")
    const dbPath = path.join(root, "writer-probe.db")
    const db = new SqliteDatabase(dbPath)
    db.run("CREATE TABLE t (x TEXT)")
    db.run("INSERT INTO t VALUES ('held-open')")
    const { holders } = await dbHolders(dbPath)
    expect(holders.some((h) => h.pid === process.pid)).toBe(true)
    db.close()
    const after = await dbHolders(dbPath)
    expect(after.holders).toEqual([])
    rmSync(root, { recursive: true, force: true })
    record("extra writer detected via /proc fd scan", "pass")
  })
})

describe("incompatible schema / old read failure", () => {
  test("old binary probe fails on a hostile database and the fixture is preserved", async () => {
    const root = tmpRoot("hostile")
    mkdirSync(path.join(root, "workspace"), { recursive: true, mode: 0o700 })
    mkdirSync(path.join(root, "config"), { recursive: true, mode: 0o700 })
    writeFileSync(path.join(root, "config", "opencode.json"), JSON.stringify({ plugin: [], mcp: {} }))
    const dbPath = path.join(root, "hostile.db")
    const envSeed = childEnv({ ...baseConfig(root), dbPath })
    const seed = await run(OLD_BIN, ["db", "SELECT 1", "--format", "json"], envSeed, path.join(root, "workspace"))
    if (seed.code !== 0) console.log("seed stderr:", seed.stderr.slice(0, 500))
    expect(seed.code).toBe(0)
    const hostile = new SqliteDatabase(dbPath)
    hostile.run("DROP TABLE session")
    hostile.close()
    const before = Buffer.from(await Bun.file(dbPath).arrayBuffer())
    const cfg: UpgradeConfig = { ...baseConfig(root), dbPath }
    const error = await fingerprints(OLD_BIN, cfg, childEnv(cfg)).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeDefined()
    expect(String(error)).not.toMatch(/posix_spawn/)
    // The tool must not delete, restore or repair the fixture.
    const after = Buffer.from(await Bun.file(dbPath).arrayBuffer())
    expect(after.equals(before)).toBe(true)
    // Record the simulated incompatibility as evidence.
    mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 })
    await Bun.write(
      path.join(EVIDENCE_DIR, "task-12-incompatibility.json"),
      JSON.stringify(
        {
          schema: "task12-incompatibility/v1",
          simulated: "old-binary read failure against a database missing the session table",
          oldBin: OLD_BIN,
          dbPath,
          probeFailed: true,
          error: String(error).slice(0, 500),
          fixturePreserved: true,
          note: "The rehearsal tool refuses unsafe success: no deletion, restore, downgrade or repair of the fixture state.",
        },
        null,
        2,
      ),
    )
    rmSync(root, { recursive: true, force: true })
    record("hostile schema probe fails; fixture preserved; incompatibility.json written", "pass")
  })
})

describe("startup failure cleanup", () => {
  test("health timeout kills the spawned child, frees the port, and leaves no registry entry", async () => {
    const root = tmpRoot("startup-cleanup")
    mkdirSync(path.join(root, "workspace"), { recursive: true, mode: 0o700 })
    const fakeBin = path.join(root, "hang-opencode")
    writeFileSync(
      fakeBin,
      `#!${process.execPath}\nconst i = process.argv.indexOf("--port")\nconst port = Number(process.argv[i + 1])\nBun.serve({ hostname: "127.0.0.1", port, fetch() { return new Promise(() => {}) } })\n`,
    )
    chmodSync(fakeBin, 0o755)
    const cfg = baseConfig(root)
    const started = Date.now()
    const error = await startServer(cfg, fakeBin, "startup-hang", childEnv(cfg), {
      healthTimeoutMs: 2_000,
      healthRequestTimeoutMs: 500,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeDefined()
    expect(String(error)).toMatch(/timed out/)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(spawnedChildCount()).toBe(0)
    await assertPortFree("127.0.0.1", cfg.port)
    const health = (await Bun.file(path.join(root, "health-startup-hang.json")).json()) as {
      attempts: Array<{ timedOut: boolean }>
    }
    expect(health.attempts.length).toBeGreaterThan(0)
    expect(health.attempts.some((attempt) => attempt.timedOut)).toBe(true)
    expect(health.attempts.every((attempt) => attempt.status !== 200)).toBe(true)
    rmSync(root, { recursive: true, force: true })
    record("startup health timeout kills owned child and frees the port", "pass")
  }, 20_000)
})

describe("semantic comparison", () => {
  test("ignores only volatile timestamps and reports every other difference", () => {
    const a = { id: "s1", title: "same", time: { created: 1, updated: 2 }, metadata: { m: 1 } }
    const b = { id: "s1", title: "same", time: { created: 1, updated: 99 }, metadata: { m: 1 } }
    expect(semanticDiff(a, b)).toEqual([])
    const c = { id: "s1", title: "changed", time: { created: 1, updated: 3 }, metadata: { m: 1 } }
    const diffs = semanticDiff(a, c)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].path).toContain("title")
    record("semanticDiff volatile handling verified", "pass")
  })
})

describe("verdict derivation", () => {
  test("non-fatal blockers produce incompatible with blocked readiness; compatible is fixture-scoped", () => {
    const blocked = deriveVerdict(["semantic diff on session title"])
    expect(blocked.compatible).toBe(false)
    expect(blocked.rollbackSafe).toBe(false)
    expect(blocked.outcome).toBe("incompatible")
    expect(blocked.readiness).toBe("blocked")
    expect(blocked.readinessScope).toBe("synthetic-pinned-fixture")
    expect(blocked.deploymentReadiness).toBe("blocked")
    expect(blocked.deploymentBlockers).toEqual([DEPLOYMENT_READINESS_BLOCKER])

    const ready = deriveVerdict([])
    expect(ready.compatible).toBe(true)
    expect(ready.rollbackSafe).toBe(true)
    expect(ready.outcome).toBe("compatible")
    expect(ready.readiness).toBe("ready")
    expect(ready.readinessScope).toBe("synthetic-pinned-fixture")
    // Fixture readiness is never deployment approval.
    expect(ready.deploymentReadiness).toBe("blocked")

    const timedOut = deriveVerdict(["fatal: backend health check timed out"], { readinessTimeout: true })
    expect(timedOut.compatible).toBeNull()
    expect(timedOut.rollbackSafe).toBeNull()
    expect(timedOut.outcome).toBe("inconclusive")
    expect(timedOut.readiness).toBe("blocked")
    record("verdict derivation: blockers incompatible, compatible fixture-scoped, timeout inconclusive", "pass")
  })
})

describe("child environment isolation", () => {
  test("strips OPENCODE_TEST_HOME unless it equals the fixture HOME", () => {
    const cfg = baseConfig(tmpRoot("env"))
    const original = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = "/home/someone-else"
    expect(childEnv(cfg).OPENCODE_TEST_HOME).toBeUndefined()
    process.env.OPENCODE_TEST_HOME = cfg.home
    expect(childEnv(cfg).OPENCODE_TEST_HOME).toBe(cfg.home)
    process.env.OPENCODE_TEST_HOME = original
    rmSync(cfg.testRoot, { recursive: true, force: true })
    record("childEnv OPENCODE_TEST_HOME policy verified", "pass")
  })
})

// Keep binVersion referenced for the identity tests' error paths.
test("binVersion reports the real old version", async () => {
  const cfg = baseConfig(tmpRoot("binversion"))
  expect(await binVersion(OLD_BIN, childEnv(cfg))).toBe("1.18.18")
  rmSync(cfg.testRoot, { recursive: true, force: true })
  record("binVersion real old version", "pass")
})
