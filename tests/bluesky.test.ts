import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"

// Config is read at import time: point it at a temp dir holding a stored session that targets the fake PDS.
const dir = mkdtempSync(join(tmpdir(), "social-bluesky-test-"))
process.env.SOCIAL_CONFIG_DIR = dir
delete process.env.BLUESKY_HANDLE; delete process.env.BLUESKY_APP_PASSWORD

interface Seen { method: string; path: string; query: Record<string, string[]>; headers: Record<string, string>; body: any }
const seen: Seen[] = []
let reply: (s: Seen) => Response = () => Response.json({})

const server = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url)
    const query: Record<string, string[]> = {}
    for (const [k, v] of u.searchParams) (query[k] ??= []).push(v)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    const ct = req.headers.get("content-type") ?? ""
    const s: Seen = { method: req.method, path: u.pathname, query, headers, body: undefined }
    if (ct.startsWith("application/json")) { const t = await req.text(); s.body = t ? JSON.parse(t) : undefined }
    else if (req.method !== "GET") s.body = new Uint8Array(await req.arrayBuffer())
    seen.push(s)
    return reply(s)
  },
})
const PDS = `http://127.0.0.1:${server.port}`

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`
const DID = "did:plc:testtesttesttesttesttest"
const session = { accessJwt: jwt(Math.floor(Date.now() / 1000) + 3600), refreshJwt: jwt(Math.floor(Date.now() / 1000) + 86400 * 30), did: DID, handle: "me.test", active: true, service: PDS, pds: PDS }
writeFileSync(join(dir, "state.json"), JSON.stringify({ bluesky_session: session }))

const { bluesky } = await import("../src/platforms/bluesky/index.ts")
const { ApiError } = await import("../src/core/http.ts")

let out = ""
const realWrite = process.stdout.write.bind(process.stdout)
async function run(...args: string[]) {
  out = ""
  process.stdout.write = ((chunk: any) => { out += String(chunk); return true }) as any
  try {
    const cmd = new Command("bluesky").exitOverride()
    bluesky.register(cmd)
    await cmd.parseAsync(args, { from: "user" })
  } finally { process.stdout.write = realWrite }
}

const created = { uri: `at://${DID}/app.bsky.feed.post/3abc`, cid: "bafycid" }
const feedItem = (text: string, handle = "me.test") => ({ post: { uri: `at://${DID}/app.bsky.feed.post/3xyz`, cid: "c", author: { handle, did: DID }, record: { text, createdAt: "2026-09-18T01:02:03.000Z" } } })
const profile = { did: DID, handle: "me.test", followersCount: 5, followsCount: 6, postsCount: 7, description: "bio" }

beforeEach(() => { seen.length = 0; reply = () => Response.json({}) })
afterAll(() => server.stop(true))

describe("bluesky curated commands", () => {
  test("post creates an app.bsky.feed.post record on the PDS with the session bearer", async () => {
    reply = () => Response.json(created)
    await run("post", "hello world")
    expect(seen).toHaveLength(1)
    const r = seen[0]!
    expect(r.method).toBe("POST"); expect(r.path).toBe("/xrpc/com.atproto.repo.createRecord")
    expect(r.headers.authorization).toBe(`Bearer ${session.accessJwt}`)
    expect(r.headers["content-type"]).toBe("application/json")
    expect(r.body.repo).toBe(DID); expect(r.body.collection).toBe("app.bsky.feed.post")
    expect(r.body.record).toMatchObject({ $type: "app.bsky.feed.post", text: "hello world" })
    expect(r.body.record.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/)
    expect(r.body.record.facets).toBeUndefined()
    expect(out.trim()).toBe(`https://bsky.app/profile/me.test/post/3abc\n${created.uri}`)
  })

  test("post detects link and mention facets, resolving the mention via resolveHandle", async () => {
    reply = (s) => s.path.endsWith("resolveHandle") ? Response.json({ did: "did:plc:alice" }) : Response.json(created)
    await run("post", "hi @alice.test see https://example.com", "--json")
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /xrpc/com.atproto.identity.resolveHandle", "POST /xrpc/com.atproto.repo.createRecord"])
    expect(seen[0]!.query).toEqual({ handle: ["alice.test"] })
    const facets = seen[1]!.body.record.facets
    expect(facets).toHaveLength(2)
    expect(facets[0].features).toEqual([{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" }])
    expect(facets[0].index).toEqual({ byteStart: 3, byteEnd: 14 })
    expect(facets[1].features).toEqual([{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }])
    expect(JSON.parse(out)).toEqual(created)
  })

  test("post --reply-to looks the parent up with getPosts and sets root/parent", async () => {
    const parentUri = "at://did:plc:other/app.bsky.feed.post/3parent"
    const rootRef = { uri: "at://did:plc:other/app.bsky.feed.post/3root", cid: "rootcid" }
    reply = (s) => s.path.endsWith("getPosts") ? Response.json({ posts: [{ uri: parentUri, cid: "parentcid", record: { text: "x", reply: { root: rootRef, parent: rootRef } } }] }) : Response.json(created)
    await run("post", "replying", "--reply-to", parentUri, "--json")
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /xrpc/app.bsky.feed.getPosts", "POST /xrpc/com.atproto.repo.createRecord"])
    expect(seen[0]!.query).toEqual({ uris: [parentUri] })
    expect(seen[1]!.body.record.reply).toEqual({ parent: { uri: parentUri, cid: "parentcid" }, root: rootRef })
  })

  test("post --image uploads raw bytes with the file's mime type, then embeds the blobs", async () => {
    const f = join(dir, "pic.png"); writeFileSync(f, new Uint8Array([137, 80, 78, 71]))
    const blob = { $type: "blob", ref: { $link: "bafyblob" }, mimeType: "image/png", size: 4 }
    reply = (s) => s.path.endsWith("uploadBlob") ? Response.json({ blob }) : Response.json(created)
    await run("post", "with pic", "--image", f, "--alt", "a picture", "--json")
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /xrpc/com.atproto.repo.uploadBlob", "POST /xrpc/com.atproto.repo.createRecord"])
    expect(seen[0]!.headers["content-type"]).toBe("image/png")
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${session.accessJwt}`)
    expect(Array.from(seen[0]!.body)).toEqual([137, 80, 78, 71])
    expect(seen[1]!.body.record.embed).toEqual({ $type: "app.bsky.embed.images", images: [{ alt: "a picture", image: blob }] })
  })

  test("delete sends deleteRecord for an at:// uri and for a bare rkey", async () => {
    await run("delete", "at://did:plc:other/app.bsky.feed.post/3del")
    expect(seen[0]!.method).toBe("POST"); expect(seen[0]!.path).toBe("/xrpc/com.atproto.repo.deleteRecord")
    expect(seen[0]!.body).toEqual({ repo: "did:plc:other", collection: "app.bsky.feed.post", rkey: "3del" })
    expect(out.trim()).toBe("deleted at://did:plc:other/app.bsky.feed.post/3del")
    await run("delete", "3mine")
    expect(seen[1]!.body).toEqual({ repo: DID, collection: "app.bsky.feed.post", rkey: "3mine" })
  })

  test("timeline reads the home feed with limit, and an author feed when a handle is given", async () => {
    reply = () => Response.json({ feed: [feedItem("first post\nsecond line")] })
    await run("timeline", "-n", "5")
    expect(seen[0]!.method).toBe("GET"); expect(seen[0]!.path).toBe("/xrpc/app.bsky.feed.getTimeline")
    expect(seen[0]!.query).toEqual({ limit: ["5"] })
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${session.accessJwt}`)
    expect(out.trim()).toBe(`at://${DID}/app.bsky.feed.post/3xyz  2026-09-18T01:02  @me.test: first post second line`)
    await run("timeline", "@bsky.app", "-n", "500", "--jq", ".feed[0].post.author.handle")
    expect(seen[1]!.path).toBe("/xrpc/app.bsky.feed.getAuthorFeed")
    expect(seen[1]!.query).toEqual({ actor: ["bsky.app"], limit: ["100"] })
    expect(out.trim()).toBe("me.test")
  })

  test("profile and me call getProfile by handle and by the session did", async () => {
    reply = () => Response.json(profile)
    await run("profile", "@me.test")
    expect(seen[0]!.path).toBe("/xrpc/app.bsky.actor.getProfile"); expect(seen[0]!.query).toEqual({ actor: ["me.test"] })
    expect(out.trim()).toBe(`@me.test (${DID})  followers 5  following 6  posts 7\nbio`)
    await run("me", "--json")
    expect(seen[1]!.query).toEqual({ actor: [DID] })
    expect(JSON.parse(out).handle).toBe("me.test")
  })

  test("whoami is one getSession call", async () => {
    reply = () => Response.json({ did: DID, handle: "me.test", active: true, email: "x@y" })
    expect(await bluesky.whoami!()).toEqual({ did: DID, handle: "me.test", active: true })
    expect(seen[0]!.path).toBe("/xrpc/com.atproto.server.getSession")
  })

  test("http() is a PDS client usable by `social api bluesky <nsid>`", async () => {
    reply = () => Response.json(profile)
    const h = await bluesky.http()
    expect(h.url("app.bsky.actor.getProfile", { actor: "x" })).toBe(`${PDS}/xrpc/app.bsky.actor.getProfile?actor=x`)
    await h.request({ path: "app.bsky.actor.getProfile", query: { actor: "x" } })
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${session.accessJwt}`)
  })

  test("a 400 ExpiredToken resumes the session (refreshSession + getSession) and retries once", async () => {
    let expired = true
    reply = (s) => {
      if (s.path.endsWith("refreshSession")) { expired = false; return Response.json({ accessJwt: jwt(9e9), refreshJwt: "r2", did: DID, handle: "me.test" }) }
      if (expired) return Response.json({ error: "ExpiredToken", message: "Token has expired" }, { status: 400 })
      if (s.path.endsWith("getSession")) return Response.json({ did: DID, handle: "me.test", active: true })
      return Response.json(profile)
    }
    await run("me", "--json")
    expect(seen.map((s) => s.path.replace("/xrpc/", ""))).toEqual(["app.bsky.actor.getProfile", "com.atproto.server.getSession", "com.atproto.server.refreshSession", "com.atproto.server.getSession", "app.bsky.actor.getProfile"])
    expect(seen[2]!.headers.authorization).toBe(`Bearer ${session.refreshJwt}`)
    expect(seen[4]!.headers.authorization).toBe(`Bearer ${jwt(9e9)}`)
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).bluesky_session).toMatchObject({ accessJwt: jwt(9e9), refreshJwt: "r2", pds: PDS })
    writeFileSync(join(dir, "state.json"), JSON.stringify({ bluesky_session: session }))
  })

  test("ApiError surfaces the XRPC error body", async () => {
    reply = () => Response.json({ error: "InvalidRequest", message: "Profile not found" }, { status: 400 })
    const err = await run("profile", "nobody").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.json).toEqual({ error: "InvalidRequest", message: "Profile not found" })
    expect(err.message).toContain("Profile not found")
  })
})
