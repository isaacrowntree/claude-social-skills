/**
 * Facebook, Instagram and Threads against a local fake Graph host. Every curated
 * command's exact method, path, query, auth header and body is asserted; nothing
 * touches the network.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Command } from "commander"
import { facebook, instagram, threads } from "../src/platforms/meta/index.ts"
import { GRAPH } from "../src/platforms/meta/graph.ts"
import { ApiError } from "../src/core/http.ts"

interface Seen { method: string; path: string; query: Record<string, string>; auth: string | null; contentType: string | null; body: Record<string, string> }
const seen: Seen[] = []
let nextResponses: Array<{ status?: number; body: unknown }> = []

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const text = await req.text()
    seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.get("authorization"), contentType: req.headers.get("content-type"), body: Object.fromEntries(new URLSearchParams(text)) })
    const r = nextResponses.shift() ?? { body: {} }
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  },
})

let out = ""
const realWrite = process.stdout.write.bind(process.stdout)
beforeAll(() => {
  GRAPH.facebook = `http://localhost:${server.port}/v26.0`
  GRAPH.threads = `http://localhost:${server.port}/v1.0`
  Object.assign(process.env, { FB_PAGE_ID: "111", FB_PAGE_ACCESS_TOKEN: "fb-tok", IG_USER_ID: "222", IG_ACCESS_TOKEN: "ig-tok", THREADS_USER_ID: "333", THREADS_ACCESS_TOKEN: "th-tok" })
  process.stdout.write = ((s: any) => { out += String(s); return true }) as any
})
afterAll(() => { process.stdout.write = realWrite; server.stop(true) })
beforeEach(() => { seen.length = 0; nextResponses = []; out = "" })

async function run(p: { register(c: Command): void }, argv: string[]) {
  const c = new Command().exitOverride(); p.register(c)
  await c.parseAsync(argv, { from: "user" })
}

// ---------- Facebook ----------

test("facebook post: POST /{page}/feed form message+link, bearer header", async () => {
  nextResponses = [{ body: { id: "111_999" } }]
  await run(facebook, ["post", "hello world", "--link", "https://example.com"])
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ method: "POST", path: "/v26.0/111/feed", auth: "Bearer fb-tok", contentType: "application/x-www-form-urlencoded", body: { message: "hello world", link: "https://example.com" } })
  expect(seen[0].query).toEqual({})
  expect(out.trim()).toBe("https://facebook.com/111_999")
})

test("facebook post --photo: POST /{page}/photos with url+caption", async () => {
  nextResponses = [{ body: { id: "555", post_id: "111_555" } }]
  await run(facebook, ["post", "pic", "--photo", "https://example.com/a.jpg", "--json"])
  expect(seen[0]).toMatchObject({ method: "POST", path: "/v26.0/111/photos", body: { url: "https://example.com/a.jpg", caption: "pic" } })
  expect(seen[0].body.link).toBeUndefined()
  expect(JSON.parse(out)).toEqual({ id: "555", post_id: "111_555" })
})

test("facebook post rejects --link with --photo before any request", async () => {
  await expect(run(facebook, ["post", "x", "--link", "https://a", "--photo", "https://b"])).rejects.toThrow(/cannot be combined/)
  expect(seen).toHaveLength(0)
})

test("facebook posts: GET /{page}/posts with fields and limit", async () => {
  nextResponses = [{ body: { data: [{ id: "111_1", message: "first\nline", created_time: "2026-09-01T00:00:00+0000" }] } }]
  await run(facebook, ["posts", "-n", "5"])
  expect(seen[0]).toMatchObject({ method: "GET", path: "/v26.0/111/posts", auth: "Bearer fb-tok", query: { fields: "id,message,created_time,permalink_url", limit: "5" } })
  expect(out).toBe("111_1  2026-09-01T00:00:00+0000  first line\n")
})

test("facebook delete: DELETE /{post-id}", async () => {
  nextResponses = [{ body: { success: true } }]
  await run(facebook, ["delete", "111_999"])
  expect(seen[0]).toMatchObject({ method: "DELETE", path: "/v26.0/111_999", auth: "Bearer fb-tok" })
  expect(out.trim()).toBe("deleted")
})

test("facebook whoami: GET /{page}?fields=id,name", async () => {
  nextResponses = [{ body: { id: "111", name: "My Page" } }]
  expect(await facebook.whoami!()).toEqual({ id: "111", name: "My Page" })
  expect(seen[0]).toMatchObject({ method: "GET", path: "/v26.0/111", query: { fields: "id,name" } })
})

// ---------- Instagram ----------

test("instagram post: container → status_code poll → media_publish", async () => {
  nextResponses = [{ body: { id: "c1" } }, { body: { id: "c1", status_code: "FINISHED" } }, { body: { id: "m1" } }]
  await run(instagram, ["post", "https://example.com/a.jpg", "--caption", "cap #tag"])
  expect(seen.map((s) => [s.method, s.path])).toEqual([["POST", "/v26.0/222/media"], ["GET", "/v26.0/c1"], ["POST", "/v26.0/222/media_publish"]])
  expect(seen[0]).toMatchObject({ auth: "Bearer ig-tok", body: { image_url: "https://example.com/a.jpg", caption: "cap #tag" } })
  expect(seen[0].body.media_type).toBeUndefined()
  expect(seen[1].query).toEqual({ fields: "status_code,status" })
  expect(seen[2].body).toEqual({ creation_id: "c1" })
  expect(out.trim()).toBe("published media m1")
})

test("instagram reel: media_type=REELS, keeps polling until FINISHED", async () => {
  nextResponses = [{ body: { id: "c2" } }, { body: { status_code: "IN_PROGRESS" } }, { body: { status_code: "FINISHED" } }, { body: { id: "m2" } }]
  await run(instagram, ["reel", "https://example.com/v.mp4", "--caption", "reel", "--json"])
  expect(seen[0].body).toEqual({ video_url: "https://example.com/v.mp4", media_type: "REELS", caption: "reel" })
  expect(seen.filter((s) => s.path === "/v26.0/c2")).toHaveLength(2)
  expect(seen.at(-1)!.body).toEqual({ creation_id: "c2" })
  expect(JSON.parse(out)).toEqual({ id: "m2" })
}, 10_000)

test("instagram post: ERROR container aborts before publish", async () => {
  nextResponses = [{ body: { id: "c3" } }, { body: { status_code: "ERROR", status: "Media download failed" } }]
  await expect(run(instagram, ["post", "https://example.com/bad.jpg"])).rejects.toThrow(/container c3 ERROR: Media download failed/)
  expect(seen.some((s) => s.path.endsWith("media_publish"))).toBe(false)
})

test("instagram media: GET /{user}/media", async () => {
  nextResponses = [{ body: { data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-09-01T00:00:00+0000", caption: "hi" }] } }]
  await run(instagram, ["media", "-n", "3"])
  expect(seen[0]).toMatchObject({ method: "GET", path: "/v26.0/222/media", auth: "Bearer ig-tok", query: { fields: "id,caption,media_type,permalink,timestamp", limit: "3" } })
  expect(out).toBe("m1  2026-09-01T00:00:00+0000  IMAGE     hi\n")
})

test("instagram me / whoami: GET /{user}", async () => {
  nextResponses = [{ body: { id: "222", username: "acct", followers_count: 5, media_count: 2 } }, { body: { id: "222", username: "acct" } }]
  await run(instagram, ["me"])
  expect(seen[0]).toMatchObject({ path: "/v26.0/222", query: { fields: "id,username,name,followers_count,media_count" } })
  expect(out.trim()).toBe("@acct (222)  followers 5  media 2")
  expect(await instagram.whoami!()).toEqual({ id: "222", username: "acct" })
  expect(seen[1].query).toEqual({ fields: "id,username" })
})

// ---------- Threads ----------

test("threads post: TEXT container → status poll → threads_publish", async () => {
  nextResponses = [{ body: { id: "t1" } }, { body: { id: "t1", status: "FINISHED" } }, { body: { id: "p1" } }]
  await run(threads, ["post", "hello threads"])
  expect(seen.map((s) => [s.method, s.path])).toEqual([["POST", "/v1.0/333/threads"], ["GET", "/v1.0/t1"], ["POST", "/v1.0/333/threads_publish"]])
  expect(seen[0]).toMatchObject({ auth: "Bearer th-tok", body: { media_type: "TEXT", text: "hello threads" } })
  expect(seen[1].query).toEqual({ fields: "status,error_message" })
  expect(seen[2].body).toEqual({ creation_id: "t1" })
  expect(out.trim()).toBe("published thread p1")
})

test("threads post --image: IMAGE container with image_url", async () => {
  nextResponses = [{ body: { id: "t2" } }, { body: { status: "FINISHED" } }, { body: { id: "p2" } }]
  await run(threads, ["post", "look", "--image", "https://example.com/a.png", "--json"])
  expect(seen[0].body).toEqual({ media_type: "IMAGE", image_url: "https://example.com/a.png", text: "look" })
  expect(JSON.parse(out)).toEqual({ id: "p2" })
})

test("threads posts: GET /{user}/threads", async () => {
  nextResponses = [{ body: { data: [{ id: "p1", text: "hi", timestamp: "2026-09-01T00:00:00+0000" }, { id: "p2", media_type: "IMAGE", timestamp: "2026-09-02T00:00:00+0000" }] } }]
  await run(threads, ["posts", "-n", "2"])
  expect(seen[0]).toMatchObject({ method: "GET", path: "/v1.0/333/threads", auth: "Bearer th-tok", query: { fields: "id,text,media_type,permalink,timestamp", limit: "2" } })
  expect(out).toBe("p1  2026-09-01T00:00:00+0000  hi\np2  2026-09-02T00:00:00+0000  [IMAGE]\n")
})

test("threads me / whoami: GET /me", async () => {
  nextResponses = [{ body: { id: "333", username: "me", name: "Me", threads_biography: "bio" } }, { body: { id: "333", username: "me" } }]
  await run(threads, ["me"])
  expect(seen[0]).toMatchObject({ path: "/v1.0/me", query: { fields: "id,username,name,threads_biography" } })
  expect(out.trim()).toBe("@me (333)  Me\nbio")
  expect(await threads.whoami!()).toEqual({ id: "333", username: "me" })
})

// ---------- errors ----------

test("ApiError carries the Graph error body (shape recorded live from graph.facebook.com)", async () => {
  const body = { error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190, fbtrace_id: "AjqIH3QWCBV2AePCNyF5oI7" } }
  nextResponses = [{ status: 401, body }]
  const err = await run(facebook, ["me"]).catch((e) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err.status).toBe(401)
  expect(err.json).toEqual(body)
  expect(err.message).toContain("OAuthException")
  expect(err.message).not.toContain("fb-tok")
})

test("missing credentials throw one helpful error naming every key, without a request", async () => {
  const saved = { ...process.env }
  delete process.env.THREADS_USER_ID; delete process.env.THREADS_ACCESS_TOKEN
  try {
    await expect(run(threads, ["me"])).rejects.toThrow(/Missing THREADS_USER_ID, THREADS_ACCESS_TOKEN/)
    expect(seen).toHaveLength(0)
  } finally { Object.assign(process.env, saved) }
})
