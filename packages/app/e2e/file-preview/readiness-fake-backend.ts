// Test-only backend used to prove readiness ordering. It never serves the product.
// Every /global/health probe is appended to a JSONL event log, and an anonymous
// probe returns 200 until the test creates the arm file, then 401.
import { appendFileSync, existsSync } from "node:fs"

type Event = { path: string; auth: "basic" | "anon"; status: number; at: number }

const argv = process.argv.slice(2)
const readArg = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const port = Number(readArg("--port"))
const hostname = readArg("--hostname") ?? "127.0.0.1"
const events = process.env.FILE_PREVIEW_FAKE_EVENTS
const armFile = process.env.FILE_PREVIEW_FAKE_ARM

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`readiness fake backend: invalid --port ${String(readArg("--port"))}`)
}
if (!events || !armFile) {
  throw new Error("readiness fake backend: FILE_PREVIEW_FAKE_EVENTS and FILE_PREVIEW_FAKE_ARM are required")
}

const record = (auth: Event["auth"], status: number): void => {
  const event: Event = { path: "/global/health", auth, status, at: Date.now() }
  appendFileSync(events, `${JSON.stringify(event)}\n`)
}

const server = Bun.serve({
  hostname,
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/global/health") {
      record("anon", 401)
      return new Response("unauthorized", { status: 401 })
    }
    const authed = request.headers.get("authorization")?.startsWith("Basic ") === true
    if (authed) {
      record("basic", 200)
      return Response.json({ healthy: true })
    }
    const status = existsSync(armFile) ? 401 : 200
    record("anon", status)
    return status === 200 ? Response.json({ healthy: true }) : new Response("unauthorized", { status: 401 })
  },
})

const shutdown = (): void => {
  server.stop(true).finally(() => process.exit(0))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
