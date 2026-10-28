/**
 * Reddit module against a local fake. Asserts the exact method, path, query, headers and
 * body each curated command sends; no network.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"

const dir = mkdtempSync(join(tmpdir(), "social-reddit-test-"))
process.env.SOCIAL_CONFIG_DIR = dir
process.env.REDDIT_CLIENT_ID = "cid"
process.env.REDDIT_CLIENT_SECRET = "csecret"
process.env.REDDIT_USERNAME = "testuser"
process.env.REDDIT_PASSWORD = "testpass"

interface Seen { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: string }
const seen: Seen[] = []
type Reply = { status?: number; body: unknown }
/** Responses are served in order; the last one repeats. */
let replies: Reply[] = [{ body: {} }]
const reply = (...r: Reply[]) => { replies = r }
let server: ReturnType<typeof Bun.serve>
let reddit: typeof import("../src/platforms/reddit/index.ts").reddit
let ApiError: typeof import("../src/core/http.ts").ApiError
// Where the config module reads state (it follows SOCIAL_CONFIG_DIR, set above).
let stateFile: string
let out = ""
const origWrite = process.stdout.write.bind(process.stdout)

beforeAll(async () => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: Object.fromEntries(req.headers), body: await req.text() })
      const r = replies.length > 1 ? replies.shift()! : replies[0]
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  process.env.REDDIT_API_BASE = base
  process.env.REDDIT_WWW_BASE = base
  ;({ reddit } = await import("../src/platforms/reddit/index.ts"))
  ;({ ApiError } = await import("../src/core/http.ts"))
  stateFile = (await import("../src/core/config.ts")).stateFilePath()
  process.stdout.write = ((s: any) => { out += String(s); return true }) as any
})
afterAll(() => { server.stop(true); process.stdout.write = origWrite; rmSync(dir, { recursive: true, force: true }) })

function writeStateFile(json: unknown) { mkdirSync(join(stateFile, ".."), { recursive: true }); writeFileSync(stateFile, JSON.stringify(json)) }
const readTokens = async () => JSON.parse(await Bun.file(stateFile).text()).reddit_tokens
function storeToken(t: Record<string, unknown> = {}) {
  writeStateFile({ reddit_tokens: { access_token: "tok123", expires_at: Date.now() + 3600_000, grant: "password", username: "testuser", ...t } })
}
beforeEach(() => { seen.length = 0; out = ""; reply({ body: {} }); storeToken() })

async function run(...argv: string[]) {
  const cmd = new Command("reddit"); cmd.exitOverride(); reddit.register(cmd)
  await cmd.parseAsync(argv, { from: "user" })
}
const form = (s: Seen) => Object.fromEntries(new URLSearchParams(s.body))

describe("reddit", () => {
  test("every request carries the bearer token and a descriptive User-Agent", async () => {
    reply({ body: { name: "testuser", id: "abc", link_karma: 1, comment_karma: 2, created_utc: 0 } })
    await run("me")
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe("GET")
    expect(seen[0].path).toBe("/api/v1/me")
    expect(seen[0].headers.authorization).toBe("Bearer tok123")
    expect(seen[0].headers["user-agent"]).toBe("social-cli/2.0 by u/testuser")
    expect(out).toContain("u/testuser (abc)")
  })

  test("password grant when no token is stored: Basic client auth + urlencoded form on www", async () => {
    writeStateFile({})
    reply({ body: { access_token: "fresh", token_type: "bearer", expires_in: 3600, scope: "*" } }, { body: { name: "testuser", id: "x" } })
    await run("me", "--json")
    expect(seen[0].method).toBe("POST")
    expect(seen[0].path).toBe("/api/v1/access_token")
    expect(seen[0].headers.authorization).toBe("Basic " + Buffer.from("cid:csecret").toString("base64"))
    expect(seen[0].headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(seen[0].headers["user-agent"]).toBe("social-cli/2.0 by u/testuser")
    expect(form(seen[0])).toEqual({ grant_type: "password", username: "testuser", password: "testpass" })
    expect(seen[1].headers.authorization).toBe("Bearer fresh")
    expect((await readTokens()).access_token).toBe("fresh")
  })

  test("expired token with a refresh_token uses grant_type=refresh_token", async () => {
    storeToken({ expires_at: Date.now() - 1, refresh_token: "rt", grant: "authorization_code" })
    reply({ body: { access_token: "renewed", expires_in: 3600 } }, { body: { kind: "Listing", data: { children: [] } } })
    await run("feed", "--json")
    expect(seen[0].path).toBe("/api/v1/access_token")
    expect(form(seen[0])).toEqual({ grant_type: "refresh_token", refresh_token: "rt" })
    expect(seen[1].headers.authorization).toBe("Bearer renewed")
    expect((await readTokens()).refresh_token).toBe("rt")
  })

  test("post --text sends kind=self to /api/submit with api_type=json", async () => {
    reply({ body: { json: { errors: [], data: { url: "https://www.reddit.com/r/test/comments/abc/t/", id: "abc", name: "t3_abc" } } } })
    await run("post", "r/test", "Hello", "--text", "body **md**")
    expect(seen[0].method).toBe("POST")
    expect(seen[0].path).toBe("/api/submit")
    expect(form(seen[0])).toEqual({ api_type: "json", sr: "test", title: "Hello", kind: "self", text: "body **md**" })
    expect(out.trim()).toBe("t3_abc  https://www.reddit.com/r/test/comments/abc/t/")
  })

  test("post --url sends kind=link and the flags", async () => {
    reply({ body: { json: { errors: [], data: { url: "u", id: "i", name: "t3_i" } } } })
    await run("post", "test", "T", "--url", "https://example.com", "--nsfw", "--resubmit", "--flair-id", "f1")
    expect(form(seen[0])).toEqual({ api_type: "json", sr: "test", title: "T", kind: "link", url: "https://example.com", nsfw: "true", flair_id: "f1", resubmit: "true" })
  })

  test("post refuses both or neither of --text/--url without a request", async () => {
    await expect(run("post", "test", "T")).rejects.toThrow("exactly one")
    await expect(run("post", "test", "T", "--text", "a", "--url", "b")).rejects.toThrow("exactly one")
    expect(seen).toHaveLength(0)
  })

  test("post surfaces api_type=json errors (HTTP 200 with json.errors)", async () => {
    reply({ body: { json: { errors: [["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there", "sr"]] } } })
    const err = await run("post", "test", "T", "--text", "x").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.body).toContain("SUBREDDIT_NOTALLOWED")
  })

  test("comment posts thing_id + text to /api/comment", async () => {
    reply({ body: { json: { errors: [], data: { things: [{ kind: "t1", data: { name: "t1_new", permalink: "/r/test/comments/abc/t/new/" } }] } } } })
    await run("comment", "t3_abc", "nice post")
    expect(seen[0].method).toBe("POST")
    expect(seen[0].path).toBe("/api/comment")
    expect(form(seen[0])).toEqual({ api_type: "json", thing_id: "t3_abc", text: "nice post" })
    expect(out.trim()).toBe("t1_new  https://www.reddit.com/r/test/comments/abc/t/new/")
  })

  test("delete posts id to /api/del", async () => {
    await run("delete", "t1_new")
    expect(seen[0].method).toBe("POST")
    expect(seen[0].path).toBe("/api/del")
    expect(form(seen[0])).toEqual({ id: "t1_new" })
    expect(out.trim()).toBe("deleted t1_new")
  })

  test("inbox reads /message/unread with limit and raw_json; --all reads /message/inbox", async () => {
    reply({ body: { kind: "Listing", data: { children: [{ kind: "t1", data: { name: "t1_m", new: true, author: "someone", subject: "comment reply", body: "hi\nthere" } }] } } })
    await run("inbox", "-n", "5")
    expect(seen[0].method).toBe("GET")
    expect(seen[0].path).toBe("/message/unread")
    expect(seen[0].query).toEqual({ limit: "5", raw_json: "1" })
    expect(out).toContain("* t1_m")
    expect(out).toContain("hi there")
    await run("inbox", "--all")
    expect(seen[1].path).toBe("/message/inbox")
    expect(seen[1].query).toEqual({ limit: "25", raw_json: "1" })
  })

  test("feed reads /hot", async () => {
    reply({ body: { kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_a", score: 42, subreddit: "test", title: "A post" } }] } } })
    await run("feed", "-n", "10")
    expect(seen[0].path).toBe("/hot")
    expect(seen[0].query).toEqual({ limit: "10", raw_json: "1" })
    expect(out.trim()).toBe("t3_a      42  r/test  A post")
  })

  test("subreddit reads /r/<name>/<sort>", async () => {
    reply({ body: { kind: "Listing", data: { children: [] } } })
    await run("subreddit", "r/programming", "-n", "2")
    expect(seen[0].path).toBe("/r/programming/hot")
    expect(seen[0].query).toEqual({ limit: "2", raw_json: "1" })
    expect(out.trim()).toBe("(no posts)")
    await run("subreddit", "programming", "--sort", "new", "--json")
    expect(seen[1].path).toBe("/r/programming/new")
    await expect(run("subreddit", "programming", "--sort", "weird")).rejects.toThrow("--sort must be")
  })

  test("--jq filters the JSON", async () => {
    reply({ body: { kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_z", score: 1, subreddit: "s", title: "T" } }] } } })
    await run("subreddit", "s", "--jq", ".data.children[0].data.name")
    expect(out.trim()).toBe("t3_z")
  })

  test("ApiError surfaces Reddit's error body and status", async () => {
    reply({ status: 403, body: { message: "Forbidden", error: 403 } })
    const err = await run("me").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.json).toEqual({ message: "Forbidden", error: 403 })
    expect(err.message).toContain("HTTP 403 GET")
  })

  test("a 401 refreshes once and retries", async () => {
    storeToken({ refresh_token: "rt", grant: "authorization_code" })
    reply({ status: 401, body: { message: "Unauthorized", error: 401 } }, { body: { access_token: "after401", expires_in: 3600 } }, { body: { name: "testuser", id: "x" } })
    await run("me", "--json")
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/me", "/api/v1/access_token", "/api/v1/me"])
    expect(form(seen[1])).toEqual({ grant_type: "refresh_token", refresh_token: "rt" })
    expect(seen[2].headers.authorization).toBe("Bearer after401")
    expect(JSON.parse(out).name).toBe("testuser")
  })

  test("whoami is one GET /api/v1/me", async () => {
    reply({ body: { name: "testuser", id: "abc", link_karma: 10, comment_karma: 20 } })
    expect(await reddit.whoami!()).toEqual({ name: "testuser", id: "abc", link_karma: 10, comment_karma: 20 })
    expect(seen.map((s) => s.path)).toEqual(["/api/v1/me"])
  })
})
