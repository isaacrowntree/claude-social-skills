import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"

// Config is read at import time, so point it at an empty dir and fake the instance before loading the module.
const dir = mkdtempSync(join(tmpdir(), "social-mastodon-test-"))
process.env.SOCIAL_CONFIG_DIR = dir
process.env.MASTODON_ACCESS_TOKEN = "test-token"

interface Seen { method: string; path: string; query: Record<string, string[]>; headers: Record<string, string>; body: any; formFields?: Record<string, string> }
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
    const s: Seen = { method: req.method, path: u.pathname, query, headers, body: undefined }
    const ct = req.headers.get("content-type") ?? ""
    if (ct.startsWith("multipart/form-data")) {
      const fd = await req.formData(); s.formFields = {}
      for (const [k, v] of fd) s.formFields[k] = v instanceof Blob ? `blob:${v.size}:${(v as File).name}` : String(v)
    } else if (ct.startsWith("application/x-www-form-urlencoded")) s.body = Object.fromEntries(new URLSearchParams(await req.text()))
    else { const t = await req.text(); s.body = t ? JSON.parse(t) : undefined }
    seen.push(s)
    return reply(s)
  },
})
process.env.MASTODON_INSTANCE = `http://127.0.0.1:${server.port}`

const { mastodon } = await import("../src/platforms/mastodon/index.ts")
const { ApiError } = await import("../src/core/http.ts")

let out = ""
const realWrite = process.stdout.write.bind(process.stdout)
async function run(...args: string[]) {
  out = ""
  process.stdout.write = ((chunk: any) => { out += String(chunk); return true }) as any
  try {
    const cmd = new Command("mastodon").exitOverride()
    mastodon.register(cmd)
    await cmd.parseAsync(args, { from: "user" })
  } finally { process.stdout.write = realWrite }
}

const status = { id: "1", uri: "http://x/1", url: "http://x/@me/1", created_at: "2026-09-18T00:00:00.000Z", content: "<p>hello</p>", visibility: "public", account: { acct: "me" }, reblog: null }
const account = { id: "9", acct: "me", display_name: "Me", followers_count: 1, following_count: 2, statuses_count: 3, url: "http://x/@me", note: "<p>bio</p>" }

beforeEach(() => { seen.length = 0; reply = () => Response.json({}) })
afterAll(() => server.stop(true))

describe("mastodon curated commands", () => {
  test("post sends status + reply + visibility + cw with bearer and idempotency key", async () => {
    reply = () => Response.json(status)
    await run("post", "hi there", "--reply-to", "42", "--visibility", "unlisted", "--cw", "spoilers")
    expect(seen).toHaveLength(1)
    const r = seen[0]
    expect(r.method).toBe("POST"); expect(r.path).toBe("/api/v1/statuses")
    expect(r.headers.authorization).toBe("Bearer test-token")
    expect(r.headers["content-type"]).toBe("application/json")
    expect(r.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.body).toEqual({ status: "hi there", in_reply_to_id: "42", visibility: "unlisted", spoiler_text: "spoilers" })
    expect(out.trim()).toBe("http://x/@me/1")
  })

  test("post --media uploads each file to /api/v2/media then attaches the ids", async () => {
    const f = join(dir, "pic.png"); writeFileSync(f, new Uint8Array([137, 80, 78, 71]))
    reply = (s) => s.path === "/api/v2/media" ? Response.json({ id: "m1", type: "image", url: "http://x/m1.png" }) : Response.json(status)
    await run("post", "with pic", "--media", f, "--json")
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/v2/media", "POST /api/v1/statuses"])
    expect(seen[0].headers["content-type"]).toStartWith("multipart/form-data")
    expect(seen[0].formFields).toEqual({ file: "blob:4:pic.png" })
    expect(seen[1].body).toEqual({ status: "with pic", media_ids: ["m1"] })
    expect(JSON.parse(out).id).toBe("1")
  })

  test("upload polls /api/v1/media/:id until the url is set (202 async processing)", async () => {
    const f = join(dir, "clip.mp4"); writeFileSync(f, "vid")
    let polls = 0
    reply = (s) => s.path === "/api/v2/media" ? Response.json({ id: "m2", type: "video", url: null }, { status: 202 }) : (++polls < 2 ? Response.json({ id: "m2", type: "video", url: null }, { status: 206 }) : Response.json({ id: "m2", type: "video", url: "http://x/m2.mp4" }))
    await run("upload", f, "--description", "alt text")
    expect(seen[0].formFields).toEqual({ file: "blob:3:clip.mp4", description: "alt text" })
    expect(seen.slice(1).every((s) => s.method === "GET" && s.path === "/api/v1/media/m2")).toBe(true)
    expect(seen).toHaveLength(3)
    expect(out.trim()).toBe("m2  video  http://x/m2.mp4")
  }, 10_000)

  test("delete", async () => {
    reply = () => Response.json({ ...status, text: "hello" })
    await run("delete", "1")
    expect(seen[0].method).toBe("DELETE"); expect(seen[0].path).toBe("/api/v1/statuses/1")
    expect(seen[0].headers.authorization).toBe("Bearer test-token")
    expect(out.trim()).toBe("deleted 1: hello")
  })

  test("timeline caps limit at 40 and formats one line per status", async () => {
    reply = () => Response.json([status, { ...status, id: "2", content: "", reblog: { ...status, account: { acct: "other" } } }])
    await run("timeline", "-n", "100")
    expect(seen[0].method).toBe("GET"); expect(seen[0].path).toBe("/api/v1/timelines/home")
    expect(seen[0].query).toEqual({ limit: ["40"] })
    expect(out.trim().split("\n")).toEqual(["1  2026-09-18T00:00  @me  hello", "2  2026-09-18T00:00  @me  RT @other: hello"])
  })

  test("profile strips @ and sends acct; --jq works", async () => {
    reply = () => Response.json(account)
    await run("profile", "@someone@example.org", "--jq", ".acct")
    expect(seen[0].path).toBe("/api/v1/accounts/lookup"); expect(seen[0].query).toEqual({ acct: ["someone@example.org"] })
    expect(out.trim()).toBe("me")
  })

  test("me hits verify_credentials", async () => {
    reply = () => Response.json(account)
    await run("me")
    expect(seen[0].path).toBe("/api/v1/accounts/verify_credentials"); expect(seen[0].headers.authorization).toBe("Bearer test-token")
    expect(out.split("\n")[0]).toBe("@me (9)  Me  followers 1  following 2  posts 3")
  })

  test("notifications passes limit and types[]", async () => {
    reply = () => Response.json([{ id: "n1", type: "mention", created_at: "2026-09-18T01:02:03Z", account: { acct: "who" }, status }])
    await run("notifications", "-n", "5", "--types", "mention", "follow")
    expect(seen[0].path).toBe("/api/v1/notifications"); expect(seen[0].query).toEqual({ limit: ["5"], "types[]": ["mention", "follow"] })
    expect(out.trim()).toBe("n1  2026-09-18T01:02  mention    @who  hello")
  })

  test("whoami is one verify_credentials read", async () => {
    reply = () => Response.json(account)
    expect(await mastodon.whoami!()).toEqual({ id: "9", acct: "me", instance: `127.0.0.1:${server.port}` })
    expect(seen).toHaveLength(1); expect(seen[0].path).toBe("/api/v1/accounts/verify_credentials")
  })

  test("ApiError surfaces Mastodon's error body", async () => {
    reply = () => Response.json({ error: "Record not found" }, { status: 404 })
    const err = await run("profile", "nobody").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(404)
    expect(err.json).toEqual({ error: "Record not found" })
    expect(err.message).toContain("HTTP 404 GET")
  })
})
