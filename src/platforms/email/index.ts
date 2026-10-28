/**
 * Email via the himalaya CLI (v2.1.0, https://github.com/pimalaya/himalaya). Not an HTTP
 * API: every command spawns `himalaya --json …` and parses what it prints, so IMAP/SMTP/JMAP
 * stay himalaya's problem. Accounts, servers and passwords live in himalaya's own TOML config
 * (`himalaya configure`), so this module keeps no credentials of its own.
 *
 * Built against `himalaya --help` on v2.1.0. Differences from the v1.2.0 surface the old
 * skill documented: `--output json` → global `--json`; `folder` → `mailbox` and
 * `--folder` → `-m/--mailbox`; `message read` lost `-p/--preview`, `-H/--header` and
 * `--no-headers` (reading no longer marks seen; `--seen` opts in; `--raw` dumps RFC 5322);
 * `template` is gone, replaced by `message compose|reply|forward` flag composers that print
 * MIME to stdout unless `--send`/`--save` is given. `--dry-run` uses exactly that: the
 * composed message is printed instead of sent.
 */
import type { Command } from "commander"
import { readFileSync } from "node:fs"
import type { Platform } from "../../core/platform.ts"
import { dryRun, type Http } from "../../core/http.ts"
import { emit, note } from "../../core/output.ts"

const BIN = process.env.HIMALAYA_BIN ?? "himalaya"

/** The headers that show where a message really came from, in the order they are worth reading. */
export const TRACE_HEADERS = ["From", "Reply-To", "Return-Path", "Message-ID", "Received", "Received-SPF", "Authentication-Results", "ARC-Authentication-Results", "DKIM-Signature", "X-Originating-IP", "X-Mailer", "X-Sender", "List-Unsubscribe"]

export class HimalayaError extends Error {
  constructor(public argv: string[], public exitCode: number, public stderr: string, public detail?: unknown) {
    super(`himalaya exited ${exitCode}: ${(detail as any)?.error ?? stderr.trim().split("\n").pop() ?? "unknown error"}\n$ ${BIN} ${argv.join(" ")}`)
  }
}

export interface RunOpts { account?: string; json?: boolean; stdin?: string }

/** Spawn himalaya once. Global flags go before the subcommand; `--json` makes data and errors JSON. */
export async function run<T = unknown>(args: string[], o: RunOpts = {}): Promise<{ argv: string[]; stdout: string; data: T }> {
  const argv = [...(o.json === false ? [] : ["--json"]), ...(o.account ? ["-a", o.account] : []), ...args]
  let p: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">
  try { p = Bun.spawn([BIN, ...argv], { stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore", stdout: "pipe", stderr: "pipe", env: process.env }) }
  catch (e: any) { throw new Error(`cannot run \`${BIN}\` (${e.message}). Install himalaya v2 (brew install himalaya) or set HIMALAYA_BIN.`) }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  const parse = (s: string) => { try { return JSON.parse(s) } catch { return undefined } }
  if (exitCode !== 0) throw new HimalayaError(argv, exitCode, stderr || stdout, parse(stdout.trim()) ?? parse(stderr.trim()))
  const data = o.json === false ? undefined : parse(stdout)
  return { argv, stdout, data: (data ?? { output: stdout.trim() }) as T }
}

// ---------- RFC 5322 header block (from `message read --raw`): unfold, keep order and case ----------

export function parseHeaders(raw: string): { name: string; value: string }[] {
  const end = raw.search(/\r?\n\r?\n/)
  const block = end < 0 ? raw : raw.slice(0, end)
  const out: { name: string; value: string }[] = []
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1]!.value += " " + line.trim(); continue }
    const i = line.indexOf(":")
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
  }
  return out
}

async function rawHeaders(id: string, o: { account?: string; folder?: string }) {
  const r = await run<{ message: string }>(["message", "read", "--raw", ...mbox(o.folder), id], { account: o.account })
  return parseHeaders(r.data.message)
}

function pick(headers: { name: string; value: string }[], names: string[]) {
  const want = names.map((n) => n.toLowerCase())
  return headers.filter((h) => want.includes(h.name.toLowerCase())).sort((a, b) => want.indexOf(a.name.toLowerCase()) - want.indexOf(b.name.toLowerCase()))
}

/** SPF/DKIM/DMARC verdicts, sender IP and mailer, pulled out of the trace headers. */
export function traceSummary(h: { name: string; value: string }[]) {
  const get = (n: string) => h.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value
  const auth = [get("Authentication-Results"), get("ARC-Authentication-Results"), get("Received-SPF")].filter(Boolean).join(" ")
  const verdict = (k: string) => auth.match(new RegExp(`\\b${k}=(\\w+)`))?.[1]
  const ip = get("X-Originating-IP")?.replace(/[\[\]]/g, "") ?? auth.match(/designates ([0-9a-f.:]+) as permitted sender/i)?.[1] ?? auth.match(/client-ip=([0-9a-f.:]+)/i)?.[1]
  const received = h.filter((x) => x.name.toLowerCase() === "received")
  return { from: get("From"), returnPath: get("Return-Path"), spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc"), dkimDomain: get("DKIM-Signature")?.match(/\bd=([^;\s]+)/)?.[1], senderIp: ip, mailer: get("X-Mailer"), hops: received.length, firstHop: received[received.length - 1]?.value.split(";")[0]?.trim() }
}

// ---------- `message read --json` normalisation (mail-parser dump → something a person can use) ----------

type Hdr = { name: string | { other: string }; value: any }
type Part = { headers: Hdr[]; body: Record<string, any> }
type Dump = { text_body: number[]; html_body: number[]; attachments: number[]; parts: Part[] }

const hname = (h: Hdr) => (typeof h.name === "string" ? h.name.replace(/_/g, "-") : h.name.other).toLowerCase()
function hval(v: any): string | undefined {
  if (v == null) return undefined
  if (typeof v === "string") return v
  if (v.Text !== undefined) return v.Text
  if (v.Address) { const list = v.Address.List ?? v.Address.Group?.flatMap((g: any) => g.addresses) ?? []; return list.map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") }
  if (v.DateTime) { const d = v.DateTime; const s = d.tz_before_gmt ? "-" : "+"; return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T${String(d.hour).padStart(2, "0")}:${String(d.minute).padStart(2, "0")}:${String(d.second).padStart(2, "0")}${s}${String(d.tz_hour).padStart(2, "0")}:${String(d.tz_minute).padStart(2, "0")}` }
  if (v.ContentType) { const c = v.ContentType; return c.c_subtype ? `${c.c_type}/${c.c_subtype}` : c.c_type }
  return JSON.stringify(v)
}
export function normaliseMessage(id: string, d: Dump) {
  const top = d.parts[0]?.headers ?? []
  const h = (n: string) => hval(top.find((x) => hname(x) === n)?.value)
  const partHeader = (p: Part, n: string) => hval(p.headers.find((x) => hname(x) === n)?.value)
  const text = d.text_body.map((i) => d.parts[i]?.body.Text ?? d.parts[i]?.body.Html ?? "").join("\n")
  const html = d.html_body.map((i) => d.parts[i]?.body.Html ?? "").join("\n")
  const attachments = d.attachments.map((i) => { const p = d.parts[i]!; const cd = p.headers.find((x) => hname(x) === "content-disposition")?.value?.ContentType; return { id: String(i + 1), filename: cd?.attributes?.find((a: any) => a.name === "filename")?.value ?? p.headers.find((x) => hname(x) === "content-type")?.value?.ContentType?.attributes?.find((a: any) => a.name === "name")?.value, mime: partHeader(p, "content-type"), inline: cd?.c_type === "inline" } })
  return { id, from: h("from"), to: h("to"), cc: h("cc"), replyTo: h("reply-to"), subject: h("subject"), date: h("date"), messageId: h("message-id"), inReplyTo: h("in-reply-to"), text: text || undefined, html: text ? undefined : html || undefined, attachments }
}

const mbox = (folder?: string) => (folder ? ["-m", folder] : [])
const fmtAddr = (a: { name?: string | null; email: string }[] = []) => a.map((x) => x.name ? `${x.name} <${x.email}>` : x.email).join(", ")
const envLine = (e: any) => `${String(e.id).padEnd(7)} ${(e.date ?? "").slice(0, 16).padEnd(16)} ${(e.flags?.includes("seen") ? " " : "*") + (e.flags?.includes("flagged") ? "!" : " ") + (e["has-attachment"] ? "@" : " ")} ${fmtAddr(e.from).slice(0, 34).padEnd(34)} ${e.subject ?? ""}`
const envelopes = (d: any) => (d.envelopes ?? []).map(envLine).join("\n") || "(no messages)"

/** Read a JSON message spec from a path, `-` (stdin) or an inline JSON string. */
function readSpec(spec: string): Record<string, any> {
  const text = spec === "-" ? readFileSync(0, "utf8") : spec.trim().startsWith("{") ? spec : readFileSync(spec, "utf8")
  const o = JSON.parse(text)
  if (!o.to) throw new Error("spec needs at least `to` (string or array), plus subject, body, cc, bcc, from, attachments")
  return o
}
const many = (flag: string, v: string | string[] | undefined) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => [flag, x]))

/** Compose/reply/forward share the composer flags; `--send` is omitted under --dry-run so himalaya prints the MIME instead. */
async function compose(args: string[], o: { account?: string; json?: boolean; jq?: string }, what: string) {
  const argv = dryRun.enabled ? args : [...args, "--send"]
  const r = await run<any>(argv, { account: o.account, json: false })
  if (dryRun.enabled) { note(`[dry-run] ${BIN} ${argv.join(" ")}  (nothing sent; composed message below)`); await emit({ dry_run: true, argv, message: r.stdout }, o, (d) => d.message); return }
  await emit({ sent: true, what, output: r.stdout.trim() || undefined }, o, () => `sent ${what}`)
}

async function mutate(args: string[], o: { account?: string; json?: boolean; jq?: string }, human: (d: any) => string) {
  if (dryRun.enabled) { const argv = ["--json", ...(o.account ? ["-a", o.account] : []), ...args]; note(`[dry-run] ${BIN} ${argv.join(" ")}`); await emit({ dry_run: true, argv }, o, () => "(dry run)"); return }
  const r = await run<any>(args, { account: o.account })
  await emit(r.data, o, human)
}

const acct = (c: Command) => c.option("-a, --account <name>", "himalaya account (default: the config's default account)")
const out = (c: Command) => c.option("--json", "print JSON").option("--jq <e>", "filter with jq")

export const email: Platform = {
  name: "email",
  summary: "Email through the himalaya CLI: list, read, search, trace headers, send, reply, move, flag, delete",
  spec: { kind: "none", source: "himalaya --help (v2.1.0)" },
  credentials: { keys: [], hint: "Nothing to store here: accounts, servers and passwords live in himalaya's TOML config. Run `himalaya account configure` (or bare `himalaya`) to add one, `himalaya account list` to see them.", docsUrl: "https://github.com/pimalaya/himalaya" },
  async http(): Promise<Http> {
    throw new Error("email wraps the himalaya CLI, not an HTTP API; use `social email …` (or `himalaya …` directly). `social api email` has nothing to call.")
  },
  /** `account check` opens every configured backend (IMAP/SMTP/JMAP) for the default account: the cheapest real auth probe himalaya offers. */
  available: () => !!Bun.which(BIN),
  async whoami() {
    const accounts = (await run<{ accounts: { name: string; default: boolean; backends: string[] }[] }>(["account", "list"])).data.accounts
    const check = (await run<{ account: string; backends: { backend: string; ok: boolean; error?: string | null }[] }>(["account", "check"])).data
    const bad = check.backends.filter((b) => !b.ok)
    if (bad.length) throw new Error(`${check.account}: ${bad.map((b) => `${b.backend} ${b.error}`).join("; ")}`)
    return { account: check.account, backends: check.backends.map((b) => b.backend), accounts: accounts.map((a) => a.name) }
  },
  register(cmd: Command) {
    out(cmd.command("accounts").description("accounts in himalaya's config")).action(async (o) => {
      const r = await run<any>(["account", "list"])
      await emit(r.data, o, (d) => d.accounts.map((a: any) => `${a.default ? "*" : " "} ${a.name.padEnd(12)} ${a.backends.join(",")}`).join("\n"))
    })
    out(acct(cmd.command("folders").description("mailboxes (folders) of an account").option("--counts", "also fetch total/unread per mailbox (one IMAP STATUS each)"))).action(async (o) => {
      const r = await run<any>(["mailbox", "list", ...(o.counts ? ["--counts"] : [])], { account: o.account })
      await emit(r.data, o, (d) => d.mailboxes.map((m: any) => `${m.name}${m.total != null ? `  ${m.total} total, ${m.unread} unread` : ""}`).join("\n"))
    })
    out(acct(cmd.command("list").description("newest envelopes first (* unread, ! flagged, @ attachment)").option("-f, --folder <name>", "mailbox name or alias (default: inbox)").option("-s, --page-size <n>", "envelopes per page (himalaya default 25)").option("-p, --page <n>", "page number from 1").option("--has-attachment", "populate the attachment marker (extra lookup per envelope)"))).action(async (o) => {
      const r = await run<any>(["envelope", "list", ...mbox(o.folder), ...(o.pageSize ? ["-s", o.pageSize] : []), ...(o.page ? ["-p", o.page] : []), ...(o.hasAttachment ? ["--has-attachment"] : [])], { account: o.account })
      await emit(r.data, o, envelopes)
    })
    out(acct(cmd.command("search <query...>").description("search envelopes: `from x and subject y`, `after 2026-01-01`, `flag seen`, `not …`, `order by date desc`").option("-f, --folder <name>", "mailbox name or alias (default: inbox)").option("-s, --page-size <n>", "envelopes per page").option("-p, --page <n>", "page number from 1"))).action(async (query: string[], o) => {
      const r = await run<any>(["envelope", "search", ...mbox(o.folder), ...(o.pageSize ? ["-s", o.pageSize] : []), ...(o.page ? ["-p", o.page] : []), ...query], { account: o.account })
      await emit(r.data, o, envelopes)
    })
    out(acct(cmd.command("read <id>").description("read a message (leaves it unread unless --seen)").option("-f, --folder <name>", "mailbox name or alias (default: inbox)").option("--preview", "accepted for compatibility: v2 reads never mark seen").option("--seen", "mark the message seen while reading").option("-H, --headers <names...>", "print only these headers, from the raw message").option("--raw", "the original RFC 5322 bytes"))).action(async (id: string, o) => {
      if (o.preview) note("--preview is the default in himalaya v2 (reads never mark seen); pass --seen to mark it")
      if (o.raw) { const r = await run<any>(["message", "read", "--raw", ...mbox(o.folder), id], { account: o.account }); await emit(o.json || o.jq ? r.data : r.data.message, { ...o, raw: !o.json && !o.jq }); return }
      if (o.headers) { const h = pick(await rawHeaders(id, o), o.headers); await emit({ id, headers: h }, o, (d) => d.headers.map((x: any) => `${x.name}: ${x.value}`).join("\n") || "(none of those headers present)"); return }
      const r = await run<Dump>(["message", "read", ...mbox(o.folder), ...(o.seen ? ["--seen"] : []), id], { account: o.account })
      await emit(normaliseMessage(id, r.data), o, (m) => [`From: ${m.from ?? ""}`, `To: ${m.to ?? ""}`, ...(m.cc ? [`Cc: ${m.cc}`] : []), `Date: ${m.date ?? ""}`, `Subject: ${m.subject ?? ""}`, ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a: any) => `[${a.id}] ${a.filename ?? a.mime}`).join(", ")}`] : []), "", m.text ?? m.html ?? "(no text body)"].join("\n"))
    })
    out(acct(cmd.command("trace <id>").description("where a message came from: Received chain, SPF/DKIM/DMARC results, Return-Path, originating IP, mailer").option("-f, --folder <name>", "mailbox name or alias (default: inbox)"))).action(async (id: string, o) => {
      const headers = pick(await rawHeaders(id, o), TRACE_HEADERS)
      const summary = traceSummary(headers)
      await emit({ id, summary, headers }, o, (d) => [`spf=${d.summary.spf ?? "?"} dkim=${d.summary.dkim ?? "?"} dmarc=${d.summary.dmarc ?? "?"}  dkim d=${d.summary.dkimDomain ?? "?"}  sender ip ${d.summary.senderIp ?? "?"}  ${d.summary.hops} hops`, `From: ${d.summary.from ?? ""}`, `Return-Path: ${d.summary.returnPath ?? ""}`, ...(d.summary.mailer ? [`X-Mailer: ${d.summary.mailer}`] : []), "", ...d.headers.map((x: any) => `${x.name}: ${x.value}`)].join("\n"))
    })
    out(acct(cmd.command("attachments <id>").description("list a message's attachments; ids feed `himalaya attachment download <msg> <id>`").option("-f, --folder <name>", "mailbox name or alias (default: inbox)").option("-d, --download [dir]", "download all to a directory (default: himalaya's downloads-dir)"))).action(async (id: string, o) => {
      if (o.download !== undefined) { await mutate(["attachment", "download", ...mbox(o.folder), ...(typeof o.download === "string" ? ["-d", o.download] : []), id], o, (d) => JSON.stringify(d)); return }
      const r = await run<any>(["attachment", "list", ...mbox(o.folder), id], { account: o.account })
      await emit(r.data, o, (d) => (d.attachments ?? []).map((a: any) => `[${a.id}] ${a.filename}  ${a.mime}  ${a.size} bytes${a.inline ? "  (inline)" : ""}`).join("\n") || "(no attachments)")
    })
    out(acct(cmd.command("send <spec>").description("send a message from a JSON spec {to, cc, bcc, subject, body, from, attachments}: a file path, - for stdin, or inline JSON"))).action(async (spec: string, o) => {
      const s = readSpec(spec)
      await compose(["message", "compose", ...many("--from", s.from), ...many("--to", s.to), ...many("--cc", s.cc), ...many("--bcc", s.bcc), ...(s.subject !== undefined ? ["--subject", s.subject] : []), ...(s.body !== undefined ? ["--body", s.body] : []), ...many("--attach", s.attachments)], o, `to ${[s.to].flat().join(", ")}`)
    })
    out(acct(cmd.command("reply <id>").description("reply to a message; recipients come from Reply-To/From unless --to is given").option("-f, --folder <name>", "mailbox of the source (default: inbox)").option("-b, --body <text>", "reply text (stdin if omitted)").option("-t, --to <addr...>", "override recipients").option("--cc <addr...>").option("--bcc <addr...>").option("--attach <file...>").option("--bottom", "quote the original above your text"))).action(async (id: string, o) => {
      const body = o.body ?? readFileSync(0, "utf8")
      await compose(["message", "reply", ...mbox(o.folder), ...many("--to", o.to), ...many("--cc", o.cc), ...many("--bcc", o.bcc), ...many("--attach", o.attach), ...(o.bottom ? ["-P", "bottom"] : []), "--body", body, id], o, `reply to ${id}`)
    })
    out(acct(cmd.command("forward <id>").description("forward a message (himalaya adds no recipient itself, so --to is required)").requiredOption("-t, --to <addr...>", "recipient(s)").option("-f, --folder <name>", "mailbox of the source (default: inbox)").option("-b, --body <text>", "note above the forwarded text", "").option("--cc <addr...>").option("--bcc <addr...>").option("--attach <file...>"))).action(async (id: string, o) => {
      await compose(["message", "forward", ...mbox(o.folder), ...many("--to", o.to), ...many("--cc", o.cc), ...many("--bcc", o.bcc), ...many("--attach", o.attach), "--body", o.body, id], o, `forward of ${id} to ${o.to.join(", ")}`)
    })
    out(acct(cmd.command("move <id> <folder>").description("move a message to another mailbox").option("-f, --folder <name>", "source mailbox (default: inbox)"))).action(async (id: string, folder: string, o) => {
      await mutate(["message", "move", ...(o.folder ? ["-f", o.folder] : []), "-t", folder, id], o, (d) => d.output || `moved ${id} to ${folder}`)
    })
    out(acct(cmd.command("flag <id>").description("add or remove flags: seen, answered, flagged, draft").option("--add <flags...>").option("--remove <flags...>").option("-f, --folder <name>", "mailbox name or alias (default: inbox)"))).action(async (id: string, o) => {
      if (!o.add && !o.remove) throw new Error("pass --add <flags...> and/or --remove <flags...> (seen, answered, flagged, draft)")
      const results: unknown[] = []
      for (const [verb, flags] of [["add", o.add], ["remove", o.remove]] as const) {
        if (!flags) continue
        if (dryRun.enabled) { const argv = ["--json", ...(o.account ? ["-a", o.account] : []), "flag", verb, ...mbox(o.folder), ...many("-f", flags), id]; note(`[dry-run] ${BIN} ${argv.join(" ")}`); results.push({ dry_run: true, argv }); continue }
        results.push({ [verb]: (await run<any>(["flag", verb, ...mbox(o.folder), ...many("-f", flags), id], { account: o.account })).data })
      }
      await emit(results.length === 1 ? results[0] : results, o, () => dryRun.enabled ? "(dry run)" : `flags updated on ${id}`)
    })
    out(acct(cmd.command("delete <id>").description("delete a message (moves to trash; permanent if already in trash)").option("-f, --folder <name>", "mailbox name or alias (default: inbox)"))).action(async (id: string, o) => {
      await mutate(["message", "delete", ...mbox(o.folder), id], o, (d) => `${d.action ?? "deleted"} ${d.count ?? 1}`)
    })
  },
}
