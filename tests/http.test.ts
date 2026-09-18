import { describe, expect, test } from "bun:test"
import { makeHttp, ApiError, buildUrl, dryRun } from "../src/core/http.ts"

function serve(handler: (req: Request, n: number) => Response | Promise<Response>) {
  let n = 0
  const s = Bun.serve({ port: 0, fetch: (req) => handler(req, ++n) })
  return { s, url: `http://localhost:${s.port}`, calls: () => n }
}

describe("buildUrl", () => {
  test("joins base and path, encodes query, repeats arrays", () => {
    expect(buildUrl("https://api.example/v2/", "/users/me", { a: 1, b: ["x", "y"], c: undefined })).toBe("https://api.example/v2/users/me?a=1&b=x&b=y")
  })
  test("absolute path bypasses base", () => {
    expect(buildUrl("https://api.example/v2", "https://other.example/z")).toBe("https://other.example/z")
  })
})

describe("makeHttp", () => {
  test("JSON body, headers factory, parses JSON", async () => {
    const seen: any = {}
    const { s, url } = serve(async (req) => { seen.method = req.method; seen.auth = req.headers.get("authorization"); seen.ct = req.headers.get("content-type"); seen.body = await req.json(); return Response.json({ ok: 1 }) })
    const h = makeHttp({ baseUrl: url, headers: () => ({ authorization: "Bearer t" }) })
    const r = await h.request<any>({ path: "things", body: { a: 1 } })
    s.stop(true)
    expect(seen).toEqual({ method: "POST", auth: "Bearer t", ct: "application/json", body: { a: 1 } })
    expect(r).toEqual({ ok: 1 })
  })
  test("form body is urlencoded", async () => {
    const seen: any = {}
    const { s, url } = serve(async (req) => { seen.ct = req.headers.get("content-type"); seen.body = await req.text(); return Response.json({}) })
    await makeHttp({ baseUrl: url }).request({ path: "t", form: { grant_type: "x", n: 2 } })
    s.stop(true)
    expect(seen).toEqual({ ct: "application/x-www-form-urlencoded", body: "grant_type=x&n=2" })
  })
  test("non-2xx throws ApiError carrying status and body", async () => {
    const { s, url } = serve(() => new Response(JSON.stringify({ error: "nope" }), { status: 403 }))
    const err: any = await makeHttp({ baseUrl: url }).request({ path: "t" }).catch((e) => e)
    s.stop(true)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.json).toEqual({ error: "nope" })
  })
  test("retries GET on 503 up to 3 attempts, never retries POST", async () => {
    const g = serve((_, n) => (n < 3 ? new Response("down", { status: 503 }) : Response.json({ n })))
    const r = await makeHttp({ baseUrl: g.url }).request<any>({ path: "t" })
    g.s.stop(true)
    expect(r.n).toBe(3)
    const p = serve(() => new Response("down", { status: 503 }))
    await expect(makeHttp({ baseUrl: p.url }).request({ path: "t", body: {} })).rejects.toBeInstanceOf(ApiError)
    expect(p.calls()).toBe(1)
    p.s.stop(true)
  })
  test("429 waits Retry-After once and retries", async () => {
    const t0 = Date.now()
    const { s, url, calls } = serve((_, n) => (n === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "0.05" } }) : Response.json({ ok: true })))
    await makeHttp({ baseUrl: url }).request({ path: "t" })
    s.stop(true)
    expect(calls()).toBe(2)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40)
  })
  test("401 triggers onUnauthorized and one retry when it returns true", async () => {
    let refreshed = false
    const { s, url, calls } = serve((_, n) => (n === 1 ? new Response("expired", { status: 401 }) : Response.json({ ok: true })))
    const r = await makeHttp({ baseUrl: url, onUnauthorized: async () => (refreshed = true) }).request<any>({ path: "t" })
    s.stop(true)
    expect(refreshed).toBe(true); expect(calls()).toBe(2); expect(r.ok).toBe(true)
  })
  test("--dry-run short-circuits mutating calls and never hits the server", async () => {
    const { s, url, calls } = serve(() => Response.json({ real: true }))
    dryRun.enabled = true
    const r = await makeHttp({ baseUrl: url }).request<any>({ path: "t", body: { a: 1 } })
    const g = await makeHttp({ baseUrl: url }).request<any>({ path: "t" })
    dryRun.enabled = false
    s.stop(true)
    expect(r.dry_run).toBe(true); expect(g.real).toBe(true); expect(calls()).toBe(1)
  })
})
