import { describe, expect, test } from "bun:test"
import { apiCommand, io } from "../src/commands/api.ts"
import { makeHttp } from "../src/core/http.ts"
import type { Platform } from "../src/core/platform.ts"

function fake(): { platform: Platform; seen: any[]; stop: () => void } {
  const seen: any[] = []
  const s = Bun.serve({ port: 0, fetch: async (req) => { seen.push({ method: req.method, url: req.url.replace(/^http:\/\/[^/]+/, ""), ct: req.headers.get("content-type"), x: req.headers.get("x-test"), body: await req.text() }); return Response.json({ echo: true, items: [1, 2, 3] }) } })
  const platform: Platform = { name: "fake", summary: "", spec: { kind: "none", source: "" }, credentials: { keys: [], hint: "", docsUrl: "" }, http: async () => makeHttp({ baseUrl: `http://localhost:${s.port}/v1` }), register() {} }
  return { platform, seen, stop: () => s.stop(true) }
}

async function run(args: string[], p: Platform) {
  const out: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (c: string) => { out.push(String(c)); return true }
  try { await apiCommand({ fake: p }).parseAsync(["node", "api", ...args]) } finally { (process.stdout as any).write = orig }
  return out.join("")
}

describe("social api", () => {
  test("GET with -q query and --jq filter", async () => {
    const f = fake()
    const out = await run(["fake", "things", "-q", "a=1", "-q", "b=two", "--jq", ".items | length"], f.platform)
    f.stop()
    expect(f.seen[0]).toMatchObject({ method: "GET", url: "/v1/things?a=1&b=two" })
    expect(out.trim()).toBe("3")
  })
  test("-f fields imply POST, are typed, and JSON-encoded", async () => {
    const f = fake()
    await run(["fake", "things", "-f", "n=2", "-f", "on=true", "-f", "tags=[\"a\"]", "--raw-field", "id=007", "-H", "X-Test: yes"], f.platform)
    f.stop()
    expect(f.seen[0].method).toBe("POST")
    expect(f.seen[0].ct).toBe("application/json")
    expect(f.seen[0].x).toBe("yes")
    expect(JSON.parse(f.seen[0].body)).toEqual({ n: 2, on: true, tags: ["a"], id: "007" })
  })
  test("--form sends urlencoded; -X overrides method", async () => {
    const f = fake()
    await run(["fake", "things/1", "-X", "PATCH", "-f", "a=b", "--form"], f.platform)
    f.stop()
    expect(f.seen[0]).toMatchObject({ method: "PATCH", ct: "application/x-www-form-urlencoded", body: "a=b" })
  })
  test("--input - reads a JSON body from stdin", async () => {
    const f = fake()
    const orig = io.stdin
    io.stdin = () => '{"from":"stdin"}'
    try { await run(["fake", "things", "--input", "-"], f.platform) } finally { io.stdin = orig }
    f.stop()
    expect(JSON.parse(f.seen[0].body)).toEqual({ from: "stdin" })
  })
})
