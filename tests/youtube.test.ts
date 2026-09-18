import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"

// Point config at a scratch dir before the module reads it.
const dir = mkdtempSync(join(tmpdir(), "social-youtube-test-"))
process.env.SOCIAL_CONFIG_DIR = dir
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com"
process.env.GOOGLE_CLIENT_SECRET = "test-secret"

const { youtube, endpoints, uploadVideo } = await import("../src/platforms/youtube/index.ts")
const { ApiError } = await import("../src/core/http.ts")
const config = await import("../src/core/config.ts")

interface Seen { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: string }
const seen: Seen[] = []
let reply: (req: Seen) => Response = () => new Response("{}", { headers: { "content-type": "application/json" } })
let server: ReturnType<typeof Bun.serve>
let out = ""
const origWrite = process.stdout.write.bind(process.stdout)

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const s: Seen = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: Object.fromEntries(req.headers), body: await req.text() }
      seen.push(s)
      return reply(s)
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  endpoints.api = `${base}/youtube/v3`
  endpoints.upload = `${base}/upload/youtube/v3`
  endpoints.token = `${base}/token`
  process.stdout.write = ((chunk: any) => { out += String(chunk); return true }) as any
})
afterAll(() => { server.stop(true); process.stdout.write = origWrite })
beforeEach(() => {
  seen.length = 0; out = ""
  config.writeState({ youtube_tokens: { access_token: "tok-1", refresh_token: "ref-1", expires_at: Date.now() + 3600_000 } })
  reply = () => new Response("{}", { headers: { "content-type": "application/json" } })
})

async function run(...args: string[]) {
  const cmd = new Command("youtube").exitOverride()
  youtube.register(cmd)
  await cmd.parseAsync(args, { from: "user" })
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } })
const channel = { kind: "youtube#channelListResponse", items: [{ id: "UCabc", snippet: { title: "My Channel", customUrl: "@mychannel" }, statistics: { subscriberCount: "12", videoCount: "3", viewCount: "999" }, contentDetails: { relatedPlaylists: { uploads: "UUabc" } } }] }

test("me: GET channels?part=…&mine=true with bearer", async () => {
  reply = () => json(channel)
  await run("me")
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ method: "GET", path: "/youtube/v3/channels", query: { part: "snippet,statistics,contentDetails", mine: "true" } })
  expect(seen[0].headers.authorization).toBe("Bearer tok-1")
  expect(out).toContain("My Channel (UCabc)  @mychannel")
})

test("whoami returns the channel summary", async () => {
  reply = () => json(channel)
  expect(await youtube.whoami!()).toEqual({ id: "UCabc", title: "My Channel", handle: "@mychannel", subscribers: "12" })
})

test("videos: resolves the uploads playlist then lists playlistItems", async () => {
  reply = (r) => r.path.endsWith("/channels") ? json(channel) : json({ items: [{ snippet: { resourceId: { videoId: "vid1" }, title: "First", publishedAt: "2026-09-01T00:00:00Z" }, status: { privacyStatus: "public" } }], nextPageToken: "NEXT" })
  await run("videos", "-n", "7")
  expect(seen.map((s) => s.path)).toEqual(["/youtube/v3/channels", "/youtube/v3/playlistItems"])
  expect(seen[1]).toMatchObject({ method: "GET", query: { part: "snippet,contentDetails,status", playlistId: "UUabc", maxResults: "7" } })
  expect(seen[1].query.pageToken).toBeUndefined()
  expect(out).toContain("vid1  2026-09-01  public    First")
  expect(out).toContain("next: --page NEXT")
})

test("video <id>: GET videos?id=… with the stats parts; --json prints the item", async () => {
  reply = () => json({ items: [{ id: "dQw4w9WgXcQ", snippet: { title: "T", channelTitle: "C", publishedAt: "2009-10-25T06:57:33Z" }, statistics: { viewCount: "1" } }] })
  await run("video", "dQw4w9WgXcQ", "--json")
  expect(seen[0]).toMatchObject({ method: "GET", path: "/youtube/v3/videos", query: { part: "snippet,statistics,status,contentDetails", id: "dQw4w9WgXcQ" } })
  expect(JSON.parse(out).id).toBe("dQw4w9WgXcQ")
})

test("comments <videoId>: GET commentThreads with plainText", async () => {
  reply = () => json({ items: [{ id: "c1", snippet: { totalReplyCount: 2, topLevelComment: { snippet: { authorDisplayName: "Ann", textDisplay: "hi\nthere", publishedAt: "2026-09-02T00:00:00Z" } } } }] })
  await run("comments", "vid1", "-n", "5", "--order", "relevance")
  expect(seen[0]).toMatchObject({ method: "GET", path: "/youtube/v3/commentThreads", query: { part: "snippet", videoId: "vid1", maxResults: "5", order: "relevance", textFormat: "plainText" } })
  expect(out).toContain("c1  2026-09-02  Ann: hi there  (+2 replies)")
})

test("delete <videoId>: DELETE videos?id=… and a 204 empty body is fine", async () => {
  reply = () => new Response(null, { status: 204 })
  await run("delete", "vid1")
  expect(seen[0]).toMatchObject({ method: "DELETE", path: "/youtube/v3/videos", query: { id: "vid1" } })
  expect(out.trim()).toBe("deleted vid1")
})

test("upload: resumable initiation headers/body, then PUT of the bytes to the Location", async () => {
  const file = join(dir, "clip.mp4"); writeFileSync(file, "0123456789")
  const session = `http://127.0.0.1:${server.port}/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION`
  reply = (r) => r.query.upload_id ? json({ id: "newvid", status: { privacyStatus: "unlisted", uploadStatus: "uploaded" } }, 201) : new Response(null, { status: 200, headers: { location: session } })
  await run("upload", file, "--title", "Hello", "--description", "desc", "--privacy", "unlisted", "--tags", "a", "b")
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ method: "POST", path: "/upload/youtube/v3/videos", query: { uploadType: "resumable", part: "snippet,status" } })
  expect(seen[0].headers).toMatchObject({ authorization: "Bearer tok-1", "content-type": "application/json; charset=UTF-8", "x-upload-content-length": "10", "x-upload-content-type": "video/mp4" })
  expect(JSON.parse(seen[0].body)).toEqual({ snippet: { title: "Hello", description: "desc", tags: ["a", "b"] }, status: { privacyStatus: "unlisted" } })
  expect(seen[1]).toMatchObject({ method: "PUT", query: { upload_id: "SESSION" }, body: "0123456789" })
  expect(seen[1].headers["content-type"]).toBe("video/mp4")
  expect(out).toContain("newvid  unlisted  uploaded")
})

test("upload: rejects a bad --privacy before any request", async () => {
  await expect(run("upload", "/nonexistent.mp4", "--title", "x", "--privacy", "secret")).rejects.toThrow("--privacy must be")
  expect(seen).toHaveLength(0)
})

test("expired access token is refreshed at the token endpoint before the call", async () => {
  config.writeState({ youtube_tokens: { access_token: "old", refresh_token: "ref-1", expires_at: Date.now() - 1 } })
  reply = (r) => r.path === "/token" ? json({ access_token: "tok-2", expires_in: 3599, token_type: "Bearer" }) : json(channel)
  await run("me", "--json")
  expect(seen[0]).toMatchObject({ method: "POST", path: "/token" })
  expect(seen[0].headers["content-type"]).toBe("application/x-www-form-urlencoded")
  expect(Object.fromEntries(new URLSearchParams(seen[0].body))).toEqual({ client_id: "test-client.apps.googleusercontent.com", client_secret: "test-secret", grant_type: "refresh_token", refresh_token: "ref-1" })
  expect(seen[1].headers.authorization).toBe("Bearer tok-2")
  expect(config.readState<any>().youtube_tokens).toMatchObject({ access_token: "tok-2", refresh_token: "ref-1" })
})

test("a 401 triggers one refresh and a retry", async () => {
  let calls = 0
  reply = (r) => r.path === "/token" ? json({ access_token: "tok-3", expires_in: 3599 }) : ++calls === 1 ? json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401) : json(channel)
  await run("me", "--json")
  expect(seen.map((s) => `${s.method} ${s.path} ${s.headers.authorization}`)).toEqual(["GET /youtube/v3/channels Bearer tok-1", "POST /token undefined", "GET /youtube/v3/channels Bearer tok-3"])
})

test("ApiError surfaces Google's error body", async () => {
  // Shape verified live 2026-09-18 against https://www.googleapis.com/youtube/v3/videos with no credentials.
  const body = { error: { code: 403, message: "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", errors: [{ message: "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", domain: "global", reason: "forbidden" }], status: "PERMISSION_DENIED" } }
  reply = () => json(body, 403)
  const err = await run("video", "dQw4w9WgXcQ").catch((e) => e)
  expect(err).toBeInstanceOf(ApiError)
  expect(err.status).toBe(403)
  expect(err.json).toEqual(body)
  expect(err.message).toContain("PERMISSION_DENIED")
})

test("uploadVideo refuses a missing file without touching the network", async () => {
  await expect(uploadVideo("/definitely/not/here.mp4", { title: "x" })).rejects.toThrow("file not found")
  expect(seen).toHaveLength(0)
})
