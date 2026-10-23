import { afterEach, beforeEach, expect, test } from "bun:test"

const STORAGE_KEY = "opencode.file-tab-reload-handoff.v1"
const OWNER = "server-a:workspace-a:session-1"

type HandoffModule = typeof import("./file-tab-reload-handoff")
type Tab = { mode?: "preview" | "source"; scroll?: { x: number; y: number } }

let documents = 0

// A fresh module instance has a fresh per-document nonce, which is exactly what a reload
// creates. No test-only reset export is needed in the product module.
async function fresh(): Promise<HandoffModule> {
  documents += 1
  return import(`./file-tab-reload-handoff?doc=${documents}`) as Promise<HandoffModule>
}

function stored() {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  return raw === null ? undefined : (JSON.parse(raw) as { nonce: string; owner: string; tabs: Record<string, unknown> })
}

async function arm(owner = OWNER, tabs: Record<string, Tab> = { "file://docs/a.md": { mode: "source" } }) {
  const doc = await fresh()
  doc.registerFileTabReloadHandoffCapture(() => ({ owner, tabs }))
  doc.writeFileTabReloadHandoffFromCapture()
  return doc
}

const navigation = Object.getOwnPropertyDescriptor(performance, "getEntriesByType")

function stubNavigation(type?: "reload" | "navigate") {
  Object.defineProperty(performance, "getEntriesByType", {
    configurable: true,
    value: (kind: string) => (kind === "navigation" && type ? [{ type }] : []),
  })
}

beforeEach(() => {
  sessionStorage.removeItem(STORAGE_KEY)
  stubNavigation("navigate")
})

afterEach(() => {
  if (navigation) Object.defineProperty(performance, "getEntriesByType", navigation)
  else delete (performance as unknown as Record<string, unknown>).getEntriesByType
})

test("same-document reads keep the carrier armed; a fresh reload document consumes it once", async () => {
  const doc1 = await arm()
  expect(stored()).not.toBeUndefined()

  // Same document: the provider remounts before the scheduled reload. The nonce matches, so
  // even a reload-typed navigation entry must not consume the carrier.
  stubNavigation("reload")
  expect(doc1.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
  expect(stored()).not.toBeUndefined()

  const doc2 = await fresh()
  stubNavigation("reload")
  expect(doc2.takeFileTabReloadHandoff(OWNER)).toEqual({ "file://docs/a.md": { mode: "source" } })
  expect(stored()).toBeUndefined()
  expect(doc2.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
})

test("a non-reload entry discards the carrier so a later reload cannot resurrect it", async () => {
  await arm()

  const doc2 = await fresh()
  stubNavigation("navigate")
  expect(doc2.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
  expect(stored()).toBeUndefined()

  const doc3 = await fresh()
  stubNavigation("reload")
  expect(doc3.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
})

test("missing navigation timing fails closed and discards the carrier", async () => {
  await arm()

  const doc2 = await fresh()
  stubNavigation(undefined)
  expect(doc2.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
  expect(stored()).toBeUndefined()
})

test("a wrong owner discards the carrier instead of restoring or leaving it armed", async () => {
  await arm()

  const doc2 = await fresh()
  stubNavigation("reload")
  expect(doc2.takeFileTabReloadHandoff("server-b:workspace-b:session-1")).toBeUndefined()
  expect(stored()).toBeUndefined()

  const doc3 = await fresh()
  stubNavigation("reload")
  expect(doc3.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
})

test("a write with no capture or no chosen modes clears an earlier carrier", async () => {
  const doc = await fresh()
  sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ nonce: "doc-old", owner: OWNER, tabs: { "file://docs/a.md": { mode: "source" } } }),
  )
  doc.writeFileTabReloadHandoffFromCapture()
  expect(stored()).toBeUndefined()

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ nonce: "doc-old", owner: OWNER, tabs: {} }))
  const unregister = doc.registerFileTabReloadHandoffCapture(() => ({ owner: OWNER, tabs: {} }))
  doc.writeFileTabReloadHandoffFromCapture()
  expect(stored()).toBeUndefined()
  unregister()
})

test("malformed and untrusted payloads are cleared or filtered safely", async () => {
  const doc = await fresh()
  sessionStorage.setItem(STORAGE_KEY, "not json")
  expect(doc.takeFileTabReloadHandoff(OWNER)).toBeUndefined()
  expect(stored()).toBeUndefined()

  sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      nonce: "doc-old",
      owner: OWNER,
      tabs: {
        "file://ok.md": { mode: "ultra", scroll: { x: 1, y: Number.NaN } },
        context: { mode: "source" },
        "file://valid.md": { mode: "preview", scroll: { x: 2, y: 3 } },
      },
    }),
  )
  stubNavigation("reload")
  expect(doc.takeFileTabReloadHandoff(OWNER)).toEqual({
    "file://valid.md": { mode: "preview", scroll: { x: 2, y: 3 } },
  })
  expect(stored()).toBeUndefined()
})

test("a denied sessionStorage getter cannot break the write or take paths", async () => {
  await arm()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("denied", "SecurityError")
    },
  })
  try {
    const doc = await fresh()
    expect(() => doc.writeFileTabReloadHandoffFromCapture()).not.toThrow()
    expect(() => doc.takeFileTabReloadHandoff(OWNER)).not.toThrow()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor)
    else delete (globalThis as unknown as Record<string, unknown>).sessionStorage
  }
})

test("cleanup clears only its own capture registration", async () => {
  const doc = await fresh()
  let first = 0
  let second = 0
  const unregisterFirst = doc.registerFileTabReloadHandoffCapture(() => {
    first += 1
    return { owner: OWNER, tabs: {} }
  })
  doc.registerFileTabReloadHandoffCapture(() => {
    second += 1
    return { owner: OWNER, tabs: {} }
  })
  unregisterFirst()
  doc.writeFileTabReloadHandoffFromCapture()
  expect(first).toBe(0)
  expect(second).toBe(1)
})
