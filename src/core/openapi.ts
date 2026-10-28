/**
 * Generated platforms. Any API that publishes an OpenAPI document (or a Google Discovery
 * document) becomes a list of operations here: indexed once from the pulled spec into
 * `src/platforms/<name>/ops.gen.json`, then found, described and called by id through the
 * platform's own authenticated client. A platform supplies only auth (a client per
 * operation) and any defaults; `social <platform> ops | describe | call` come from here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Command } from "commander"
import { SPEC_DIR, pullSpecs, writeAtomic } from "./specs.ts"
import type { Http } from "./http.ts"
import { emit, note } from "./output.ts"
import { bodyFrom, kv } from "../commands/api.ts"

export interface RestParam { name: string; in: "path" | "query" | "header"; required: boolean; type: string; description: string }
export interface RestOp {
  kind: "rest"; id: string; api: string; operationId: string; method: string; server: string; path: string
  summary: string; params: RestParam[]; body?: { contentTypes: string[]; required: boolean }
  /** OAuth scopes the spec lists; `schemes` are the security scheme names it accepts (api_key, oauth2…). */
  scopes: string[]; schemes: string[]
  /** "app" when every security option is client-credentials only; platforms read `scheme` as their auth prefix. */
  auth: "user" | "app"; scheme: string; keywords: string
}
/** Other operation kinds (eBay's GraphQL) share the index; the generic runtime only calls `rest`. */
export interface OtherOp { kind: string; id: string; api: string; operationId: string; summary: string; keywords: string }
export type AnyOp = RestOp | OtherOp
export interface OpsIndex<O = AnyOp> { apis: Record<string, { title: string; version: string; spec: string }>; ops: O[] }
export const isRest = (o: AnyOp): o is RestOp => o.kind === "rest"

// ---------- indexing ----------

const METHODS = ["get", "put", "post", "delete", "patch"]

/** Markdown/HTML description → one line of plain text. Tags become spaces so "a.<br>Note" keeps its sentence break. */
export function clean(text: string | undefined): string {
  return (text ?? "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim()
}

/** Lead-ins that aren't the description: "Important!", "Note:", eBay Marketing's rename notice, Etsy's release badge. */
const LEAD_IN = /^(important|note|tip)\b|documentation has been updated|report bug|ready for production use/i

/** The first real sentence of a description. */
export function brief(text: string | undefined, max = 160): string {
  const sentences = clean(text).split(/(?<=[.!?])\s+/).filter(Boolean)
  const s = sentences.find((x) => x.length > 20 && !LEAD_IN.test(x)) ?? sentences.find((x) => !LEAD_IN.test(x)) ?? ""
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Follow local JSON-pointer $refs (with ~1/~0 escapes) inside one spec. */
export function deref(spec: any, x: any): any {
  let v = x
  for (let i = 0; v?.$ref && i < 10; i++) v = v.$ref.replace(/^#\//, "").split("/").reduce((o: any, k: string) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec)
  return v
}

/** `fulfillment_api` → `fulfillment`, `account_api_v1` → `account_v1`; tags → snake_case. */
export function apiName(name: string): string {
  return name.replace(/_api(_|$)/, "$1").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_|_$/g, "").toLowerCase()
}

function resolveServer(servers: any[] | undefined): string {
  const prod = (servers ?? []).find((s) => !/sandbox/.test(s.url)) ?? servers?.[0]
  if (!prod) return ""
  return prod.url.replace(/\{(\w+)\}/g, (_: string, v: string) => prod.variables?.[v]?.default ?? "")
}

function typeOf(spec: any, schema: any): string {
  const s = deref(spec, schema)
  if (!s) return "string"
  if (s.enum) return s.enum.join("|")
  if (s.type === "array") return `${typeOf(spec, s.items)}[]`
  return Array.isArray(s.type) ? s.type.join("|") : s.type ?? "string"
}

/** Where a published spec is wrong about reaching its API; `host` replaces the API-wide server only. */
export interface OpFix { host?: string; scheme?: string; auth?: "user" }

/**
 * Every operation in one OpenAPI document. `api` names the group; when it is omitted each
 * operation is grouped by its first tag (or first path segment) and its id is the bare
 * operationId, which suits single-spec platforms (Pinterest's `pins/create`).
 */
export function restOps(spec: any, o: { api?: string; fix?: OpFix; scheme?: string } = {}): RestOp[] {
  const schemes = spec.components?.securitySchemes ?? {}
  const fix = o.fix ?? {}
  const out: RestOp[] = []
  const seen = new Set<string>()
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      // Finances declares /payout/{payout_Id} and /payout/{payout_id}: the same endpoint twice.
      const key = `${method} ${path.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      // Operation-level parameters override path-level ones with the same name and location.
      const byKey = new Map<string, RestParam>()
      for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = deref(spec, raw)
        if (!p || !["path", "query", "header"].includes(p.in)) continue
        byKey.set(`${p.in}:${p.name.toLowerCase()}`, { name: p.name, in: p.in, required: !!p.required || p.in === "path", type: typeOf(spec, p.schema), description: brief(p.description, 200) })
      }
      const params = [...byKey.values()]
      // Some specs (eBay Metadata) leave {placeholders} in the path undeclared.
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) if (!params.some((p) => p.in === "path" && p.name === name)) params.unshift({ name, in: "path", required: true, type: "string", description: "" })
      const rb = deref(spec, op.requestBody)
      const security: any[] = op.security ?? spec.security ?? []
      const scopes = [...new Set(security.flatMap((req) => Object.values<string[]>(req).flat()).filter((s) => /^https:\/\/|^[\w.-]+:[\w.-]+$|^[a-z]+_[rwd]$/.test(s)))]
      // App token only when every security option is a client-credentials-only scheme (eBay Taxonomy, Browse…).
      const appOnly = security.length > 0 && security.every((req) => Object.keys(req).length > 0 && Object.keys(req).every((name) => {
        const flows = Object.keys(schemes[name]?.flows ?? {})
        return flows.length > 0 && flows.every((f) => f === "clientCredentials")
      }))
      let server = resolveServer(op.servers ?? item.servers ?? spec.servers)
      if (fix.host && !op.servers && !item.servers) server = fix.host + new URL(server).pathname.replace(/\/$/, "")
      const base = server ? new URL(server).pathname.replace(/\/$/, "") : ""
      // eBay Post-Order's paths repeat the server's base path, and Finances' billing_activity server
      // already ends in /billing_activity; drop the copy on the server side.
      if (base && path.startsWith(base + "/")) server = server.slice(0, server.length - base.length)
      else if (base && path !== "/" && base.endsWith(path)) server = server.slice(0, server.length - path.length)
      const operationId = op.operationId ?? `${method} ${path}`
      // Discord's operations have no summary or description; its ids read well enough ("create_message").
      const words = operationId.replace(/[_/]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
      const api = o.api ?? apiName(op.tags?.[0] ?? path.split("/").find((s: string) => s && !s.startsWith("{") && !/^v\d+$/.test(s)) ?? "root")
      out.push({
        kind: "rest", id: o.api ? `${o.api}.${operationId}` : operationId, api, operationId,
        method: method.toUpperCase(), server, path, summary: brief(op.summary || op.description) || words, params,
        ...(rb?.content ? { body: { contentTypes: Object.keys(rb.content), required: !!rb.required } } : {}),
        scopes, schemes: [...new Set(security.flatMap((req) => Object.keys(req)))],
        auth: fix.auth ?? (appOnly ? "app" : "user"), scheme: fix.scheme ?? o.scheme ?? "Bearer",
        keywords: `${words} ${clean(op.description).slice(0, 400)} ${params.map((p) => p.name).join(" ")}`.toLowerCase(),
      })
    }
  }
  return out
}

/** Every method in a Google Discovery document (YouTube), as REST ops: `videos.list`, `liveChatMessages.insert`. */
export function discoveryOps(doc: any): RestOp[] {
  const out: RestOp[] = []
  const server = `${doc.rootUrl}${doc.servicePath}`.replace(/\/$/, "")
  const walk = (resources: any, prefix: string[]) => {
    for (const [rname, r] of Object.entries<any>(resources ?? {})) {
      for (const [mname, m] of Object.entries<any>(r.methods ?? {})) {
        const params: RestParam[] = Object.entries<any>(m.parameters ?? {}).filter(([, p]) => p.location === "path" || p.location === "query")
          .map(([name, p]) => ({ name, in: p.location, required: !!p.required, type: p.enum ? p.enum.join("|") : `${p.type ?? "string"}${p.repeated ? "[]" : ""}`, description: brief(p.description, 200) }))
        const id = [...prefix, rname, mname].join(".")
        out.push({
          kind: "rest", id, api: prefix[0] ?? rname, operationId: id, method: m.httpMethod, server, path: "/" + m.path.replace(/\{\+/g, "{"),
          summary: brief(m.description), params, ...(m.request ? { body: { contentTypes: m.supportsMediaUpload ? ["application/json", "application/octet-stream"] : ["application/json"], required: true } } : {}),
          scopes: m.scopes ?? [], schemes: ["oauth2"], auth: "user", scheme: "Bearer",
          keywords: `${clean(m.description).slice(0, 400)} ${params.map((p) => p.name).join(" ")}`.toLowerCase(),
        })
      }
      walk(r.resources, [...prefix, rname])
    }
  }
  walk(doc.resources, [])
  return out
}

/** Index one spec file (OpenAPI or Discovery) for a single-spec platform and write it. */
export function buildIndex(o: { spec: string; out: string; specDir?: string; fix?: OpFix; scheme?: string }): OpsIndex<RestOp> {
  const file = join(o.specDir ?? SPEC_DIR, `${o.spec}.json`)
  if (!existsSync(file)) throw new Error(`${file} is missing; run \`social specs pull ${o.spec}\``)
  const doc = JSON.parse(readFileSync(file, "utf8"))
  const ops = doc.discoveryVersion ? discoveryOps(doc) : restOps(doc, { fix: o.fix, scheme: o.scheme })
  const apis: OpsIndex["apis"] = {}
  for (const op of ops) apis[op.api] ??= { title: doc.info?.title ?? doc.title ?? o.spec, version: doc.info?.version ?? doc.version ?? "", spec: o.spec }
  const index = { apis, ops }
  writeAtomic(o.out, JSON.stringify(index) + "\n")
  return index
}

// ---------- runtime ----------

export interface RestArgs { params: Record<string, string>; body?: unknown; files?: Record<string, string> }

/** What a platform adds to a request: defaults for missing params, and extra headers. */
export interface RequestDefaults {
  /** Values for missing path/header params, matched case-insensitively (eBay: marketplace_id, Content-Language). */
  params?: Record<string, string>
  headers?: (op: RestOp, hasBody: boolean) => Record<string, string>
  /** Rewrite an op's server (sandbox hosts, the configured Mastodon instance). */
  server?: (op: RestOp) => string
}

/** Turn an op plus CLI arguments into a concrete request. Pure, so it is unit-tested without the network. */
export function buildRest(op: RestOp, a: RestArgs, d: RequestDefaults = {}) {
  const known = new Map(op.params.map((p) => [p.name.toLowerCase(), p]))
  for (const k of Object.keys(a.params)) if (!known.has(k.toLowerCase())) throw new Error(`${op.id} has no parameter "${k}". Parameters: ${op.params.map((p) => p.name).join(", ") || "none"}`)
  const get = (name: string) => Object.entries(a.params).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  const fallback = (name: string) => Object.entries(d.params ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
  const types = op.body?.contentTypes ?? []
  const multipart = types.some((t) => t.startsWith("multipart/"))
  // A body that is the file itself (eBay media.uploadVideo: application/octet-stream), not JSON or form parts.
  const fileType = types.find((t) => !/json|multipart|xml|x-www-form/.test(t))
  const fileBody = !multipart && !!fileType && (!!a.files || !types.some((t) => t.includes("json")))
  let path = op.path
  const query: Record<string, string> = {}
  const headers: Record<string, string> = {}
  for (const p of op.params) {
    const v = get(p.name) ?? (p.in === "query" ? undefined : fallback(p.name))
    if (v === undefined) {
      if (p.in === "path") throw new Error(`${op.id} needs path parameter "${p.name}" (-p ${p.name}=…)`)
      if (p.required && p.in === "query") throw new Error(`${op.id} needs query parameter "${p.name}" (-p ${p.name}=…)`)
      continue
    }
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(v))
    else if (p.in === "query") query[p.name] = v
    // The multipart boundary and a file's type are set when the body is built; a hand-set Content-Type would break them.
    else if (!((multipart || fileBody) && /^content-type$/i.test(p.name))) headers[p.name] = v
  }
  const files = Object.entries(a.files ?? {})
  if (files.length && !multipart && !fileBody) throw new Error(`${op.id} takes ${types.join(", ") || "no body"}, not a file; --file is for multipart or binary bodies`)
  let body: unknown = a.body
  if (multipart) {
    const form = new FormData()
    for (const [k, v] of Object.entries((a.body as Record<string, unknown>) ?? {})) form.append(k, typeof v === "string" ? v : JSON.stringify(v))
    for (const [k, f] of files) form.append(k, Bun.file(f), f.split("/").pop())
    body = files.length || a.body !== undefined ? form : undefined
  } else if (fileBody) {
    if (files.length !== 1 || a.body !== undefined) throw new Error(`${op.id} uploads one file as its body (${fileType}): pass exactly one --file name=path`)
    body = Bun.file(files[0][1], { type: fileType })
  } else if (body !== undefined) headers["Content-Type"] ??= types.find((t) => t.includes("json")) ?? "application/json"
  if (op.body?.required && body === undefined) throw new Error(`${op.id} needs a request body (${multipart || fileBody ? "--file field=path" : "--input file.json or -f key=value"}); see \`describe ${op.id}\``)
  for (const [k, v] of Object.entries(d.headers?.(op, body !== undefined) ?? {})) if (!Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase())) headers[k] = v
  return { baseUrl: d.server ? d.server(op) : op.server, method: op.method, path, query, headers, body }
}

export interface GeneratedConfig<O extends AnyOp = AnyOp> {
  /** Platform name: the spec family to pull and the folder holding ops.gen.json. */
  name: string
  indexFile: string
  /** An authenticated client for one op; requests go to `baseUrl` + the op's path as an absolute URL. */
  client: (op: RestOp, baseUrl: string) => Promise<Http>
  defaults?: () => Promise<RequestDefaults>
  /** Tests supply an index directly. */
  index?: OpsIndex<O>
}

export class Generated<O extends AnyOp = AnyOp> {
  private cached?: OpsIndex<O>
  constructor(public cfg: GeneratedConfig<O>) { this.cached = cfg.index }
  useIndex(i?: OpsIndex<O>) { this.cached = i }

  async index(): Promise<OpsIndex<O>> {
    if (this.cached) return this.cached
    if (!existsSync(this.cfg.indexFile)) {
      note(`${this.cfg.name} specs not pulled yet; fetching them now (\`social specs pull ${this.cfg.name}\`)`)
      await pullSpecs({ only: this.cfg.name, lenient: true, log: note })
      if (!existsSync(this.cfg.indexFile)) throw new Error(`could not pull ${this.cfg.name}'s specs (see above); retry with \`social specs pull ${this.cfg.name}\``)
    }
    return (this.cached = JSON.parse(readFileSync(this.cfg.indexFile, "utf8")) as OpsIndex<O>)
  }

  /** An op by id, or by bare operationId when that is unique. Case-insensitive. */
  async find(id: string): Promise<O> {
    const { ops } = await this.index()
    const lc = id.toLowerCase()
    const exact = ops.find((o) => o.id.toLowerCase() === lc)
    if (exact) return exact
    const bare = ops.filter((o) => o.operationId.toLowerCase() === lc)
    if (bare.length === 1) return bare[0]
    if (bare.length > 1) throw new Error(`"${id}" is ambiguous: ${bare.map((o) => o.id).join(", ")}`)
    const near = ops.filter((o) => o.id.toLowerCase().includes(lc)).slice(0, 8).map((o) => o.id)
    throw new Error(`no ${this.cfg.name} operation "${id}"${near.length ? `; did you mean ${near.join(", ")}?` : `; list them with \`social ${this.cfg.name} ops <words>\``}`)
  }

  /** Ops where every word appears in the id, summary, path or keywords; id matches rank first. */
  async search(filter?: string, api?: string): Promise<O[]> {
    const idx = await this.index()
    if (api && !idx.apis[api]) throw new Error(`unknown API "${api}"; one of: ${Object.keys(idx.apis).join(", ")}`)
    const words = (filter ?? "").toLowerCase().split(/\s+/).filter(Boolean)
    const scored: [O, number][] = []
    for (const o of idx.ops) {
      if (api && o.api !== api) continue
      const id = o.id.toLowerCase(), summary = `${o.summary} ${isRest(o) ? `${o.method} ${o.path}` : o.kind}`.toLowerCase()
      let score = 0
      for (const w of words) {
        const s = id.includes(w) ? 3 : summary.includes(w) ? 2 : o.keywords.includes(w) ? 1 : 0
        if (!s) { score = -1; break }
        score += s
      }
      if (score >= 0) scored.push([o, score])
    }
    return scored.sort((a, b) => b[1] - a[1]).map(([o]) => o)
  }

  async call(op: RestOp, a: RestArgs, opts: { output?: string } = {}): Promise<unknown> {
    const r = buildRest(op, a, (await this.cfg.defaults?.()) ?? {})
    const http = await this.cfg.client(op, r.baseUrl)
    // An absolute URL, so a platform's existing client (X at api.x.com/2, Bluesky at <pds>/xrpc) adds only its auth.
    const res = await http.request<{ status: number; headers: Record<string, string>; body: unknown }>({ method: r.method, path: r.baseUrl.replace(/\/$/, "") + r.path, query: r.query, headers: r.headers, body: r.body, full: true })
    if (res.body instanceof Uint8Array) {
      const contentType = res.headers["content-type"] ?? "application/octet-stream"
      if (!opts.output) throw new Error(`${op.id} answered with ${res.body.byteLength} bytes of ${contentType}; rerun with --output <file> to save it`)
      writeFileSync(opts.output, res.body)
      return { status: res.status, contentType, bytes: res.body.byteLength, path: opts.output }
    }
    // Creates often answer 201/204 with no body and the new resource's URI in Location.
    return res.body !== undefined ? res.body : { status: res.status, ...(res.headers.location ? { location: res.headers.location } : {}) }
  }

  async describe(op: RestOp, depth = 2): Promise<string> {
    const doc = JSON.parse(readFileSync(join(SPEC_DIR, `${(await this.index()).apis[op.api].spec}.json`), "utf8"))
    const lines: string[] = [`${op.id}  ${op.method} ${op.server}${op.path}`, ""]
    const auth = `${op.auth === "app" ? "application token (client credentials)" : "user credentials"}${op.scheme !== "Bearer" ? `, sent as ${op.scheme}` : ""}${op.scopes.length ? `; scopes: ${op.scopes.map((s) => s.split("/").pop()).join(", ")}` : ""}`
    if (doc.discoveryVersion) {
      lines.push(clean(op.summary), "", auth)
    } else {
      const raw = doc.paths[op.path]?.[op.method.toLowerCase()] ?? {}
      lines.push(clean(raw.description ?? op.summary).slice(0, 1200), "", auth)
      if (op.body) {
        const content = deref(doc, raw.requestBody)?.content ?? {}
        const ct = op.body.contentTypes.find((t) => t.includes("json")) ?? op.body.contentTypes[0]
        const how = ct.startsWith("multipart") ? "--file field=path, -f key=value" : !/json|xml/.test(ct) ? "--file name=path" : "--input file.json, -f key=value"
        lines.push("", `body (${op.body.contentTypes.join(", ")}${op.body.required ? ", required" : ""}; ${how}):`, outline(doc, content[ct]?.schema, depth) || "  (see docs)")
      }
      const ok = raw.responses?.["200"] ?? raw.responses?.["201"]
      const okSchema = ok?.content && (Object.values<any>(ok.content)[0]?.schema)
      if (okSchema) lines.push("", "response:", outline(doc, okSchema, Math.min(depth, 1)) || "  (see docs)")
    }
    if (op.params.length) lines.splice(lines.findIndex((l) => l === auth) + 1, 0, "", "parameters (-p name=value):", ...op.params.map((p) => `  ${p.name} [${p.in}${p.required ? ", required" : ""}] ${p.type}${p.description ? `  — ${p.description}` : ""}`))
    return lines.join("\n")
  }
}

/** Render a JSON schema (resolving $refs) as an indented field outline, to `depth`. */
export function outline(spec: any, schema: any, depth: number, indent = "  ", seen = new Set<string>()): string {
  const refOf = (x: any) => (x?.$ref as string | undefined) ?? ""
  const v = deref(spec, schema), ref = refOf(schema)
  if (!v) return ""
  if (v.type === "array" || v.items) return outline(spec, v.items, depth, indent, seen)
  if (!v.properties || depth < 0 || (ref && seen.has(ref))) return ""
  const next = new Set(seen); if (ref) next.add(ref)
  return Object.entries<any>(v.properties).map(([k, p]) => {
    const pv = deref(spec, p)
    const isArr = pv?.type === "array"
    const inner = isArr ? pv.items : p
    const iv = deref(spec, inner), iref = refOf(inner)
    const type = iref ? iref.split("/").pop() : iv?.enum ? iv.enum.join("|") : iv?.type ?? "object"
    const req = (v.required ?? []).includes(k) ? " (required)" : ""
    const desc = brief(p.description ?? pv?.description, 140)
    const kids = iv?.properties ? outline(spec, inner, depth - 1, indent + "  ", next) : ""
    return `${indent}${k}: ${type}${isArr ? "[]" : ""}${req}${desc ? `  — ${desc}` : ""}${kids ? "\n" + kids : ""}`
  }).join("\n")
}

// ---------- commands ----------

const collect = (v: string, acc: string[] = []) => [...acc, v]
function line(o: AnyOp): string {
  return `${o.id.padEnd(48)} ${isRest(o) ? o.method.padEnd(6) : o.kind === "query" ? "query " : o.kind === "mutation" ? "mutate" : o.kind.padEnd(6)} ${o.summary}`
}

/** For platforms with more than REST (eBay's GraphQL): extra `call` options and how to run those ops. */
export interface OtherKinds {
  options: (c: Command) => Command
  flags: (o: any) => string[]
  call: (op: AnyOp, o: any) => Promise<void>
  describe: (op: AnyOp, o: { depth?: number; path?: string }) => Promise<string>
}

/** `apis`, `ops`, `describe` and `call` for a generated platform. */
export function registerGenerated(cmd: Command, g: Generated, other?: OtherKinds): void {
  const name = g.cfg.name
  cmd.command("apis").description(`the ${name} API groups and how many operations each has`).option("--json").option("--jq <e>").action(async (o) => {
    const { apis, ops } = await g.index()
    const rows = Object.entries(apis).map(([api, a]) => ({ api, title: a.title, version: a.version, operations: ops.filter((x) => x.api === api).length }))
    await emit(rows, o, (d) => d.map((r: any) => `${r.api.padEnd(34)} ${String(r.operations).padStart(3)}  ${r.title}`).join("\n"))
  })

  cmd.command("ops [filter...]").description("search operations: every word must appear in the id, summary, path, description or field names; best matches first")
    .option("--api <name>", `only this API group (see \`social ${name} apis\`)`).option("--json").option("--jq <e>")
    .action(async (filter: string[], o) => {
      const hits = await g.search(filter.join(" "), o.api)
      await emit(hits, o, (d) => d.map(line).join("\n") || "(no operations match)")
    })

  const describe = cmd.command("describe <op>").description("parameters, body, scopes and response shape of one operation")
    .option("--depth <n>", "how deep to expand nested fields (default 2)")
  if (other) describe.option("--path <input.x.y>", "GraphQL: show one nested input type, e.g. input.listingTerms")
  describe.action(async (id: string, o) => {
    const op = await g.find(id)
    const depth = o.depth === undefined ? undefined : Number(o.depth)
    process.stdout.write((isRest(op) ? await g.describe(op, depth) : await other!.describe(op, { depth, path: o.path })) + "\n")
  })

  let call = cmd.command("call <op>").description("call any operation by id; --dry-run prints the request instead")
    .option("-p, --param <k=v>", "path/query/header parameter", collect, [])
    .option("-f, --field <k=v>", "body field, typed (numbers, booleans, null, JSON literals)", collect, [])
    .option("--raw-field <k=v>", "body field, always a string", collect, [])
    .option("--file <field=path>", "file for a multipart part (image=./photo.jpg) or a binary body", collect, [])
    .option("--output <file>", "save a binary response (PDF, image, feed file) here")
    .option("--input <file>", "request body from a JSON file (- for stdin)")
  if (other) call = other.options(call)
  call.option("--json").option("--jq <e>").action(async (id: string, o) => {
    const op = await g.find(id)
    const restFlags = [o.param.length && "-p", o.field.length && "-f", o.rawField.length && "--raw-field", o.file.length && "--file", o.output && "--output"].filter(Boolean) as string[]
    if (isRest(op)) {
      const wrong = other?.flags(o) ?? []
      if (wrong.length) throw new Error(`${wrong.join(", ")} ${wrong.length > 1 ? "are" : "is"} for GraphQL operations; ${op.id} is REST (use -p for parameters, -f/--input for the body)`)
      const res = await g.call(op, { params: Object.fromEntries(kv(o.param)), body: bodyFrom(o), files: o.file.length ? Object.fromEntries(kv(o.file)) : undefined }, { output: o.output })
      await emit(res ?? { ok: true }, { json: true, jq: o.jq })
    } else {
      if (restFlags.length) throw new Error(`${restFlags.join(", ")} ${restFlags.length > 1 ? "are" : "is"} for REST operations; ${op.id} is GraphQL (use -a name='{…}' or --input args.json)`)
      await other!.call(op, o)
    }
  })
}
