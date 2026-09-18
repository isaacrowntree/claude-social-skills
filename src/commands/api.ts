/**
 * `social api <platform> <path>` — the escape hatch. Any endpoint of any
 * platform, with the platform's auth applied. Mirrors `clickup api`:
 *   -X/--method, -f key=value (typed), --raw-field key=value, --input FILE|-,
 *   -q/--query key=value, -H header:value, --form (send fields urlencoded),
 *   and the usual --json/--jq.
 */
import { Command } from "commander"
import { readFileSync } from "node:fs"

/** Replaceable in tests. */
export const io = { stdin: () => readFileSync(0, "utf8") }
import type { Platform } from "../core/platform.ts"
import { emit } from "../core/output.ts"

function coerce(v: string): unknown {
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  if (/^-?\d+$/.test(v)) return Number.isSafeInteger(Number(v)) ? Number(v) : v // ids above 2^53 stay strings
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) { try { return JSON.parse(v) } catch {} }
  return v
}
function kv(list: string[] | undefined, sep = "="): [string, string][] {
  return (list ?? []).map((s) => { const i = s.indexOf(sep); if (i < 0) throw new Error(`expected key${sep}value, got "${s}"`); return [s.slice(0, i), s.slice(i + 1)] })
}

export function apiCommand(platforms: Record<string, Platform>): Command {
  const c = new Command("api")
    .description("Call any endpoint of a platform directly, with its auth applied")
    .argument("<platform>", `one of: ${Object.keys(platforms).join(", ")}`)
    .argument("<path>", "path relative to the platform's API root (or a full URL)")
    .option("-X, --method <m>", "HTTP method (default GET, or POST when fields/input are given)")
    .option("-f, --field <k=v...>", "body field, typed (true/false/null/numbers/JSON literals)")
    .option("--raw-field <k=v...>", "body field, always a string")
    .option("-q, --query <k=v...>", "query-string parameter")
    .option("-H, --header <k:v...>", "extra request header")
    .option("--input <file>", "request body from a file, or - for stdin (JSON)")
    .option("--form", "send fields as application/x-www-form-urlencoded instead of JSON")
    .option("--json", "print JSON (default)")
    .option("--jq <expr>", "filter the JSON response with jq")
    .option("--raw", "print the response body verbatim")
    .action(async (platform: string, path: string, o) => {
      const p = platforms[platform]
      if (!p) throw new Error(`unknown platform "${platform}"; expected one of ${Object.keys(platforms).join(", ")}`)
      const http = await p.http()
      const fields: Record<string, unknown> = {}
      for (const [k, v] of kv(o.field)) fields[k] = coerce(v)
      for (const [k, v] of kv(o.rawField)) fields[k] = v
      let body: unknown = undefined
      if (o.input) {
        if (Object.keys(fields).length) throw new Error("--input cannot be combined with --field/--raw-field")
        const text = o.input === "-" ? io.stdin() : readFileSync(o.input, "utf8")
        body = JSON.parse(text)
      } else if (Object.keys(fields).length) body = fields
      const query: Record<string, string> = Object.fromEntries(kv(o.query))
      const headers: Record<string, string> = Object.fromEntries(kv(o.header, ":").map(([k, v]) => [k.trim(), v.trim()]))
      const method = (o.method ?? (body ? "POST" : "GET")).toUpperCase()
      const res = await http.request({ method, path, query, headers, ...(o.form ? { form: body as any } : { body }), raw: !!o.raw })
      await emit(res, { json: true, jq: o.jq, raw: o.raw })
    })
  return c
}
