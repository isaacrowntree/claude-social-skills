import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CALLBACK_PAGE, describeBody, dryRun, makeHttp, stopCallbackServer } from "../src/core/http.ts"
import { jqAll } from "../src/core/output.ts"

interface Seen { headers: Record<string, string>; text: string }
const seen: Seen[] = []
let reply: () => Response = () => Response.json({})
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    seen.push({ headers, text: await req.text() })
    return reply()
  },
})
afterAll(() => server.stop(true))
const http = makeHttp({ baseUrl: `http://127.0.0.1:${server.port}`, headers: () => ({ accept: "application/json" }) })
beforeEach(() => { seen.length = 0; reply = () => Response.json({}); dryRun.enabled = false })

describe("http", () => {
  test("a caller's header replaces the default whatever its case, instead of being joined to it", async () => {
    await http.request({ method: "POST", path: "/", body: { a: 1 }, headers: { "Content-Type": "application/json", Accept: "text/plain" } })
    expect(seen[0].headers["content-type"]).toBe("application/json")
    expect(seen[0].headers.accept).toBe("text/plain")
  })

  test("FormData always goes with fetch's own multipart boundary", async () => {
    const f = new FormData(); f.append("a", "1")
    await http.request({ method: "POST", path: "/", body: f, headers: { "content-type": "multipart/form-data" } })
    expect(seen[0].headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/)
  })

  test("binary responses come back as bytes; full returns status and headers; 204 is undefined; raw stays text", async () => {
    reply = () => new Response(new Uint8Array([1, 2, 255]), { headers: { "content-type": "application/octet-stream" } })
    expect([...(await http.request<Uint8Array>({ path: "/" }))]).toEqual([1, 2, 255])
    reply = () => new Response(null, { status: 204 })
    expect(await http.request({ path: "/" })).toBeUndefined()
    expect(await http.request({ path: "/", full: true })).toMatchObject({ status: 204, body: undefined })
    reply = () => new Response("<x/>", { headers: { "content-type": "text/xml" } })
    expect(await http.request<string>({ path: "/", raw: true })).toBe("<x/>")
  })

  test("allowHost refuses other hosts before anything is sent", async () => {
    const strict = makeHttp({ baseUrl: "https://api.ebay.com", allowHost: (h) => h.endsWith(".ebay.com") })
    await expect(strict.request({ path: `http://127.0.0.1:${server.port}/` })).rejects.toThrow(/refusing to send credentials to 127.0.0.1/)
    expect(seen).toHaveLength(0)
  })

  test("--dry-run fakes mutating calls but still sends noDryRun ones (token exchanges)", async () => {
    dryRun.enabled = true
    reply = () => Response.json({ access_token: "real" })
    expect(await http.request({ method: "POST", path: "/", body: {} })).toMatchObject({ dry_run: true })
    expect(await http.request<unknown>({ method: "POST", path: "/", form: { grant_type: "refresh_token" }, noDryRun: true })).toEqual({ access_token: "real" })
    expect(seen).toHaveLength(1)
  })
})

describe("what --dry-run prints", () => {
  test("secrets in form, JSON and Trading XML bodies are masked", () => {
    expect(describeBody("grant_type=refresh_token&refresh_token=v%5E1.1abc&code=xyz")).toBe("grant_type=refresh_token&refresh_token=***&code=***")
    expect(describeBody(JSON.stringify({ client_secret: "s", nested: { access_token: "t" }, title: "ok" }))).toBe('{"client_secret":"***","nested":{"access_token":"***"},"title":"ok"}')
    expect(describeBody("<R><RequesterCredentials><eBayAuthToken>AgAAA123</eBayAuthToken></RequesterCredentials></R>")).toBe("<R><RequesterCredentials><eBayAuthToken>***</eBayAuthToken></RequesterCredentials></R>")
  })

  test("GraphQL variables come before the (long) query; multipart parts and file sizes are listed", () => {
    const out = describeBody(JSON.stringify({ query: "mutation X { " + "f ".repeat(1000) + "}", variables: { input: { listingId: "1" } } }))
    expect(out.startsWith('variables: {\n  "input": {\n    "listingId": "1"')).toBe(true)
    const f = new FormData(); f.append("name", "x"); f.append("image", new File([new Uint8Array(3)], "a.jpg"))
    expect(describeBody(f)).toBe("name=x\nimage=<file a.jpg 3 bytes>")
  })
})

describe("--jq", () => {
  test("no results print nothing instead of crashing; several print one per line; trailing comments work", async () => {
    expect(await jqAll({ orders: [] }, ".orders[] | .id")).toEqual([])
    expect(await jqAll({ orders: [{ id: 1 }, { id: 2 }] }, ".orders[] | .id # ids")).toEqual([1, 2])
    expect(await jqAll({ a: [1, 2] }, ".a")).toEqual([[1, 2]])
  })
})

test("state.json is written 0600 and replaced atomically", async () => {
  process.env.SOCIAL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "social-state-"))
  const config = await import("../src/core/config.ts?state" + Date.now())
  config.writeState({ a: 1 })
  config.writeState({ b: 2 })
  expect(config.readState()).toEqual({ a: 1, b: 2 })
  expect(statSync(join(process.env.SOCIAL_CONFIG_DIR, "state.json")).mode & 0o777).toBe(0o600)
})

test("an OAuth callback page still reaches the browser when the server stops as soon as the code arrives", async () => {
  let resolve!: () => void
  const got = new Promise<void>((r) => (resolve = r))
  const cb = Bun.serve({ port: 0, fetch() { resolve(); return new Response("<h1>Authorised.</h1>" + "x".repeat(20000), { headers: CALLBACK_PAGE }) } })
  const page = fetch(`http://localhost:${cb.port}/?code=1`).then((r) => r.text())
  await got
  stopCallbackServer(cb) // the old server.stop(true) here cut the page off ("socket connection was closed unexpectedly")
  expect((await page).length).toBe(20020)
})
