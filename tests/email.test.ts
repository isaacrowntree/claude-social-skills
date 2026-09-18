/**
 * email: every curated command spawns `himalaya`; these tests put a fake `himalaya` shell
 * script first on PATH that records its argv (NUL-separated) and stdin, and answers with
 * canned JSON shaped like v2.1.0's real output. No network, no real himalaya.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Command } from "commander"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { email, HimalayaError, parseHeaders, traceSummary, normaliseMessage } from "../src/platforms/email/index.ts"
import { dryRun } from "../src/core/http.ts"

const dir = mkdtempSync(join(tmpdir(), "social-email-"))
const LOG = join(dir, "argv.log")
const STDIN = join(dir, "stdin.log")
const origPath = process.env.PATH

const RAW = [
  "Delivered-To: me@example.com",
  "Received: by 2002:a05:6a11::1 with SMTP id abc;",
  "        Thu, 17 Sep 2026 20:17:47 -0700 (PDT)",
  "Received: from mta.sender.example ([203.0.113.9]) by mx.example.com with ESMTPS id xyz;",
  "        Thu, 17 Sep 2026 20:17:46 -0700 (PDT)",
  "Return-Path: <bounce@sender.example>",
  "Authentication-Results: mx.example.com;",
  "       dkim=pass header.i=@sender.example;",
  "       spf=pass (example.com: domain of bounce@sender.example designates 203.0.113.9 as permitted sender) smtp.mailfrom=bounce@sender.example;",
  "       dmarc=pass (p=REJECT) header.from=sender.example",
  "DKIM-Signature: v=1; a=rsa-sha256; d=sender.example; s=k1;",
  "\tbh=abc=; b=def==",
  "X-Mailer: TestMailer 1.0",
  "From: Sender <news@sender.example>",
  "To: me@example.com",
  "Subject: Hello",
  "Message-ID: <m1@sender.example>",
  "",
  "body text",
].join("\r\n")

const canned: Record<string, unknown> = {
  "account list": { accounts: [{ name: "one", default: true, backends: ["imap", "smtp"] }, { name: "two", default: false, backends: ["imap"] }] },
  "account check": { account: "one", backends: [{ backend: "imap", ok: true, error: null }, { backend: "smtp", ok: true, error: null }] },
  "mailbox list": { mailboxes: [{ id: "Inbox", name: "Inbox", total: null, unread: null }, { id: "[Gmail]/Sent Mail", name: "[Gmail]/Sent Mail", total: null, unread: null }] },
  "envelope list": { envelopes: [{ id: "42", "message-id": "m1@sender.example", "in-reply-to": [], flags: [], subject: "Hello", from: [{ name: "Sender", email: "news@sender.example" }], to: [{ name: null, email: "me@example.com" }], date: "2026-09-18T03:17:46Z", size: 100, "has-attachment": null }] },
  "envelope search": { envelopes: [{ id: "7", "message-id": "m7@x", "in-reply-to": [], flags: ["seen", "flagged"], subject: "Found", from: [{ name: null, email: "a@x" }], to: [], date: "2026-09-01T00:00:00Z", size: 1, "has-attachment": true }] },
  "message read --raw": { message: RAW },
  "message read": {
    text_body: [1], html_body: [2], attachments: [3],
    parts: [
      { headers: [{ name: "from", value: { Address: { List: [{ name: "Sender", address: "news@sender.example" }] } } }, { name: "to", value: { Address: { List: [{ name: null, address: "me@example.com" }] } } }, { name: "subject", value: { Text: "Hello" } }, { name: "date", value: { DateTime: { year: 2026, month: 9, day: 18, hour: 3, minute: 7, second: 6, tz_before_gmt: false, tz_hour: 10, tz_minute: 0 } } }, { name: "message_id", value: { Text: "m1@sender.example" } }, { name: { other: "X-Mailer" }, value: { Text: "TestMailer" } }], body: { Multipart: [1, 2, 3] } },
      { headers: [{ name: "content_type", value: { ContentType: { c_type: "text", c_subtype: "plain", attributes: [] } } }], body: { Text: "body text" } },
      { headers: [{ name: "content_type", value: { ContentType: { c_type: "text", c_subtype: "html", attributes: [] } } }], body: { Html: "<p>body text</p>" } },
      { headers: [{ name: "content_type", value: { ContentType: { c_type: "application", c_subtype: "pdf", attributes: [{ name: "name", value: "a.pdf" }] } } }, { name: "content_disposition", value: { ContentType: { c_type: "attachment", c_subtype: null, attributes: [{ name: "filename", value: "a.pdf" }] } } }], body: { Binary: [] } },
    ],
  },
  "attachment list": { attachments: [{ id: "4", filename: "a.pdf", mime: "application/pdf", size: 10, inline: false }] },
  "flag add": { flags: ["flagged"] },
  "flag remove": { flags: ["seen"] },
  "message delete": { action: "moved-to-trash", count: 1 },
}

beforeAll(() => {
  for (const [k, v] of Object.entries(canned)) writeFileSync(join(dir, k.replace(/[^a-z]+/g, "-") + ".json"), JSON.stringify(v))
  // Order matters: the first matching pattern wins, so `message read --raw` sits above `message read`.
  const cases = Object.keys(canned).map((k) => `  *"${k}"*) cat "${join(dir, k.replace(/[^a-z]+/g, "-") + ".json")}" ;;`).join("\n")
  writeFileSync(join(dir, "himalaya"), `#!/bin/sh
printf '%s\\0' "$@" > "${LOG}"
cat > "${STDIN}"
case "$*" in
  *"-a nope"*) printf '%s' '{"error":"Account \`nope\` not found, the configuration holds: one, two","sources":[],"backtrace":null}' >&2; exit 1 ;;
  *"message compose"*|*"message reply"*|*"message forward"*) printf 'From: me@example.com\\r\\nSubject: composed\\r\\n\\r\\nbody\\r\\n' ;;
  *"message move"*) printf '' ;;
${cases}
  *) echo "fake himalaya: unhandled $*" >&2; exit 2 ;;
esac
`)
  chmodSync(join(dir, "himalaya"), 0o755)
  process.env.PATH = `${dir}:${origPath}`
})
afterAll(() => { process.env.PATH = origPath; rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { dryRun.enabled = false; if (existsSync(LOG)) rmSync(LOG) })

const argv = () => readFileSync(LOG, "utf8").replace(/\0$/, "").split("\0")

/** Run `social email …` in-process and capture stdout. */
async function social(...args: string[]): Promise<string> {
  const cmd = new Command("email").exitOverride()
  email.register(cmd)
  let out = ""
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: any) => { out += String(s); return true }) as any
  try { await cmd.parseAsync(args, { from: "user" }) } finally { process.stdout.write = orig }
  return out
}

test("platform shape: no HTTP, no credentials, spec is the CLI help", async () => {
  expect(email.name).toBe("email")
  expect(email.spec).toEqual({ kind: "none", source: "himalaya --help (v2.1.0)" })
  expect(email.credentials.keys).toEqual([])
  expect(email.credentials.hint).toContain("himalaya account configure")
  await expect(email.http()).rejects.toThrow(/wraps the himalaya CLI.*social email/)
})

test("whoami runs account list + account check", async () => {
  const who = await email.whoami!()
  expect(who).toEqual({ account: "one", backends: ["imap", "smtp"], accounts: ["one", "two"] })
  expect(argv()).toEqual(["--json", "account", "check"])
})

test("accounts", async () => {
  const out = await social("accounts")
  expect(argv()).toEqual(["--json", "account", "list"])
  expect(out).toBe("* one          imap,smtp\n  two          imap\n")
})

test("folders --counts -a two", async () => {
  const out = await social("folders", "--counts", "-a", "two", "--json")
  expect(argv()).toEqual(["--json", "-a", "two", "mailbox", "list", "--counts"])
  expect(JSON.parse(out).mailboxes).toHaveLength(2)
})

test("list --folder --page-size --page", async () => {
  const out = await social("list", "--folder", "[Gmail]/Sent Mail", "--page-size", "3", "--page", "2", "--has-attachment")
  expect(argv()).toEqual(["--json", "envelope", "list", "-m", "[Gmail]/Sent Mail", "-s", "3", "-p", "2", "--has-attachment"])
  expect(out).toContain("42      2026-09-18T03:17 *   Sender <news@sender.example>       Hello")
})

test("search passes the query words through, and --jq works", async () => {
  const out = await social("search", "-s", "5", "from", "a@x", "and", "not", "flag", "seen", "--jq", ".envelopes[0].id")
  expect(argv()).toEqual(["--json", "envelope", "search", "-s", "5", "from", "a@x", "and", "not", "flag", "seen"])
  expect(out.trim()).toBe("7")
})

test("read normalises the mail-parser dump; never passes --seen unless asked", async () => {
  const out = JSON.parse(await social("read", "42", "--json"))
  expect(argv()).toEqual(["--json", "message", "read", "42"])
  expect(out).toMatchObject({ id: "42", from: "Sender <news@sender.example>", to: "me@example.com", subject: "Hello", date: "2026-09-18T03:07:06+10:00", messageId: "m1@sender.example", text: "body text", attachments: [{ id: "4", filename: "a.pdf", mime: "application/pdf", inline: false }] })
  expect(out.html).toBeUndefined()
  await social("read", "42", "--seen", "-f", "Archive")
  expect(argv()).toEqual(["--json", "message", "read", "-m", "Archive", "--seen", "42"])
})

test("read --preview is a no-op alias (v2 default), --headers reads the raw message", async () => {
  const out = await social("read", "42", "--preview", "-H", "from", "Message-ID", "X-Nope")
  expect(argv()).toEqual(["--json", "message", "read", "--raw", "42"])
  expect(out).toBe("From: Sender <news@sender.example>\nMessage-ID: <m1@sender.example>\n")
})

test("read --raw prints the RFC 5322 bytes verbatim", async () => {
  const out = await social("read", "42", "--raw")
  expect(argv()).toEqual(["--json", "message", "read", "--raw", "42"])
  expect(out).toBe(RAW)
})

test("trace: authentication headers in order plus a verdict summary", async () => {
  const out = JSON.parse(await social("trace", "42", "--json"))
  expect(argv()).toEqual(["--json", "message", "read", "--raw", "42"])
  expect(out.summary).toEqual({ from: "Sender <news@sender.example>", returnPath: "<bounce@sender.example>", spf: "pass", dkim: "pass", dmarc: "pass", dkimDomain: "sender.example", senderIp: "203.0.113.9", mailer: "TestMailer 1.0", hops: 2, firstHop: "from mta.sender.example ([203.0.113.9]) by mx.example.com with ESMTPS id xyz" })
  expect(out.headers.map((h: any) => h.name)).toEqual(["From", "Return-Path", "Message-ID", "Received", "Received", "Authentication-Results", "DKIM-Signature", "X-Mailer"])
  const human = await social("trace", "42")
  expect(human.split("\n")[0]).toBe("spf=pass dkim=pass dmarc=pass  dkim d=sender.example  sender ip 203.0.113.9  2 hops")
})

test("parseHeaders unfolds continuation lines and stops at the body", () => {
  const h = parseHeaders(RAW)
  expect(h.find((x) => x.name === "Authentication-Results")!.value).toBe("mx.example.com; dkim=pass header.i=@sender.example; spf=pass (example.com: domain of bounce@sender.example designates 203.0.113.9 as permitted sender) smtp.mailfrom=bounce@sender.example; dmarc=pass (p=REJECT) header.from=sender.example")
  expect(h.find((x) => x.name === "DKIM-Signature")!.value).toBe("v=1; a=rsa-sha256; d=sender.example; s=k1; bh=abc=; b=def==")
  expect(h.some((x) => x.name === "body text")).toBe(false)
  expect(traceSummary([{ name: "X-Originating-IP", value: "[198.51.100.7]" }]).senderIp).toBe("198.51.100.7")
  expect(normaliseMessage("1", { text_body: [], html_body: [1], attachments: [], parts: [{ headers: [], body: { Multipart: [1] } }, { headers: [], body: { Html: "<b>x</b>" } }] })).toMatchObject({ text: undefined, html: "<b>x</b>" })
})

test("attachments list and download", async () => {
  const out = await social("attachments", "42")
  expect(argv()).toEqual(["--json", "attachment", "list", "42"])
  expect(out).toBe("[4] a.pdf  application/pdf  10 bytes\n")
  await social("attachments", "42", "--download", "/tmp/x", "--json").catch(() => {})
  expect(argv()).toEqual(["--json", "attachment", "download", "-d", "/tmp/x", "42"])
})

test("send from a JSON spec composes with --send; arrays repeat the flag", async () => {
  const spec = join(dir, "spec.json")
  writeFileSync(spec, JSON.stringify({ from: "me@example.com", to: ["a@x", "b@x"], cc: "c@x", subject: "Hi", body: "line one\nline two", attachments: ["/tmp/a.pdf"] }))
  const out = await social("send", spec, "-a", "two")
  expect(argv()).toEqual(["-a", "two", "message", "compose", "--from", "me@example.com", "--to", "a@x", "--to", "b@x", "--cc", "c@x", "--subject", "Hi", "--body", "line one\nline two", "--attach", "/tmp/a.pdf", "--send"])
  expect(out).toBe("sent to a@x, b@x\n")
  await expect(social("send", '{"subject":"no recipient"}')).rejects.toThrow(/needs at least `to`/)
})

test("send --dry-run omits --send and prints the composed MIME", async () => {
  dryRun.enabled = true
  const out = await social("send", '{"to":"a@x","subject":"s","body":"b"}')
  expect(argv()).toEqual(["message", "compose", "--to", "a@x", "--subject", "s", "--body", "b"])
  expect(out).toContain("Subject: composed")
})

test("reply and forward", async () => {
  await social("reply", "42", "--body", "thanks", "--cc", "c@x", "--bottom", "-f", "Archive")
  expect(argv()).toEqual(["message", "reply", "-m", "Archive", "--cc", "c@x", "-P", "bottom", "--body", "thanks", "42", "--send"])
  const out = await social("forward", "42", "--to", "a@x", "b@x", "--body", "fyi")
  expect(argv()).toEqual(["message", "forward", "--to", "a@x", "--to", "b@x", "--body", "fyi", "42", "--send"])
  expect(out).toBe("sent forward of 42 to a@x, b@x\n")
  await expect(social("forward", "42")).rejects.toThrow(/--to/)
})

test("move, flag, delete", async () => {
  await social("move", "42", "Archive", "-f", "Inbox")
  expect(argv()).toEqual(["--json", "message", "move", "-f", "Inbox", "-t", "Archive", "42"])
  const out = JSON.parse(await social("flag", "42", "--add", "flagged", "seen", "--json"))
  expect(argv()).toEqual(["--json", "flag", "add", "-f", "flagged", "-f", "seen", "42"])
  expect(out).toEqual({ add: { flags: ["flagged"] } })
  await social("flag", "42", "--remove", "seen")
  expect(argv()).toEqual(["--json", "flag", "remove", "-f", "seen", "42"])
  await expect(social("flag", "42")).rejects.toThrow(/--add/)
  const del = await social("delete", "42", "-f", "Spam")
  expect(argv()).toEqual(["--json", "message", "delete", "-m", "Spam", "42"])
  expect(del).toBe("moved-to-trash 1\n")
})

test("mutations under --dry-run never spawn himalaya", async () => {
  dryRun.enabled = true
  const out = JSON.parse(await social("delete", "42", "--json"))
  expect(existsSync(LOG)).toBe(false)
  expect(out).toEqual({ dry_run: true, argv: ["--json", "message", "delete", "42"] })
})

test("himalaya's JSON error surfaces as HimalayaError with the message and argv", async () => {
  const err = await social("list", "-a", "nope").catch((e) => e)
  expect(err).toBeInstanceOf(HimalayaError)
  expect(err.exitCode).toBe(1)
  expect(err.message).toContain("Account `nope` not found")
  expect(err.message).toContain("himalaya --json -a nope envelope list")
  expect(err.detail).toEqual({ error: "Account `nope` not found, the configuration holds: one, two", sources: [], backtrace: null })
})
