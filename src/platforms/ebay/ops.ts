/**
 * The generic eBay runtime: every REST operation and GraphQL root field in the pulled
 * specs, found by id and called with the right host, token and headers. Nothing here
 * knows about a particular API; build-index.ts builds the index it reads.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildSchema, getNamedType, getVariableValues, isEnumType, isInputObjectType, isInterfaceType, isLeafType, isNonNullType,
  isObjectType, isUnionType, Kind, parse, validate,
  type GraphQLInputType, type GraphQLNamedType, type GraphQLObjectType, type GraphQLOutputType, type GraphQLSchema, type OperationDefinitionNode,
} from "graphql"
import { INDEX_FILE, authorizeScopes, brief, clean, type GqlOp, type Op, type OpsIndex, type RestOp } from "./build-index.ts"
import { SPEC_DIR } from "../../core/specs.ts"
import { makeHttp } from "../../core/http.ts"
import { note } from "../../core/output.ts"
import { Generated, buildRest as buildRequest, type RequestDefaults, type RestArgs } from "../../core/openapi.ts"

export type { GqlOp, Op, OpsIndex, RestOp }
/** Tokens only ever go to eBay, whatever a downloaded spec or a full URL says. */
export const isEbayHost = (host: string) => host === "ebay.com" || host.endsWith(".ebay.com")
/** Where requests may go. Tests point these at a local fake; nothing else changes them. */
export const endpoints = {
  graphql: { production: "https://graphqlapi.ebay.com/graphql", sandbox: "https://graphqlapi.sandbox.ebay.com/graphql" },
  allowHost: isEbayHost,
}

let schemaCache: GraphQLSchema | undefined
/** Index, search and describe; calls build a runtime() with the caller's tokens. */
const generated = new Generated<Op>({ name: "ebay", indexFile: INDEX_FILE, client: () => { throw new Error("eBay calls go through runtime(ctx)") } })
/** Tests supply a small index and schema instead of the pulled specs. */
export function useForTests(o: { index?: OpsIndex; schema?: GraphQLSchema }) { generated.useIndex(o.index); schemaCache = o.schema }

export const index = () => generated.index()
/** Find an op by `api.operationId`, or by a bare operationId when it is unique. Case-insensitive. */
export const find = (id: string) => generated.find(id)
/** Ops where every word appears in the id, summary, path or keywords (descriptions, field names); best matches first. */
export const search = (filter?: string, api?: string) => generated.search(filter, api)

// ---------- REST ----------

export interface TokenSource { user: (force?: boolean) => Promise<string>; app: (scopes: string[]) => Promise<string> }
export interface CallContext { tokens: TokenSource; marketplace: string; sandbox: boolean; contentLanguage: string; granted: string[] }

export function sandboxUrl(url: string): string { return url.replace(/:\/\/(api|apiz|apim|graphqlapi)\.ebay\.com/, "://$1.sandbox.ebay.com") }

export type { RestArgs }

/** eBay's request defaults: marketplace header and path param, Content-Language, sandbox hosts. */
export function defaults(ctx: Pick<CallContext, "marketplace" | "sandbox" | "contentLanguage">): RequestDefaults {
  return {
    params: { marketplace_id: ctx.marketplace, "Content-Language": ctx.contentLanguage },
    headers: (op, hasBody) => ({ "X-EBAY-C-MARKETPLACE-ID": ctx.marketplace, ...(hasBody && op.api === "inventory" ? { "Content-Language": ctx.contentLanguage } : {}) }),
    server: (op) => (ctx.sandbox ? sandboxUrl(op.server) : op.server),
  }
}

/** Turn an op plus CLI arguments into a concrete request. Pure, so it is unit-tested without the network. */
export function buildRest(op: RestOp, a: RestArgs, ctx: Pick<CallContext, "marketplace" | "sandbox" | "contentLanguage">) { return buildRequest(op, a, defaults(ctx)) }

/** A client for one eBay op: user or app token per the spec, sent as Bearer or IAF, refreshed once on a 401. */
export function client(ctx: CallContext) {
  return async (op: RestOp, baseUrl: string) => {
    let force = false
    return makeHttp({
      baseUrl, allowHost: (h) => endpoints.allowHost(h),
      // */* last so label PDFs and feed files can answer in their own type.
      headers: async () => ({ authorization: `${op.scheme} ${op.auth === "app" ? await ctx.tokens.app(op.scopes) : await ctx.tokens.user(force)}`, accept: "application/json, */*;q=0.5" }),
      onUnauthorized: async () => (op.auth === "user" && !force ? (force = true) : false),
    })
  }
}

/** The runtime for real calls: the shared index plus this context's auth and defaults. */
export async function runtime(ctx: CallContext): Promise<Generated<Op>> {
  return new Generated<Op>({ name: "ebay", indexFile: INDEX_FILE, client: client(ctx), defaults: async () => defaults(ctx), index: await index() })
}

export async function callRest(op: RestOp, a: RestArgs, ctx: CallContext, opts: { output?: string } = {}): Promise<unknown> {
  return (await runtime(ctx)).call(op, a, opts)
}

// ---------- GraphQL ----------

export async function schema(): Promise<GraphQLSchema> {
  if (schemaCache) return schemaCache
  await index()
  return (schemaCache = buildSchema(readFileSync(join(SPEC_DIR, "ebay-graphql.graphqls"), "utf8")))
}

interface Sel { text: string; sig: string }
/** More implementations than this and an interface is selected by its own fields only (BusinessError has 116). */
const MAX_FRAGMENTS = 20

/**
 * A default selection set for a type: every leaf field, objects expanded to `depth`, unions
 * and interfaces as `__typename` plus one inline fragment per member (members don't spend
 * depth). Fields needing arguments are skipped, and so are fields whose @authorize scopes the
 * token lacks, since one forbidden field nulls its whole parent. Same-named fields of
 * different shapes in sibling fragments are aliased `<field>_<Type>`, which GraphQL requires.
 */
export function selection(s: GraphQLSchema, t: GraphQLOutputType | GraphQLNamedType, depth: number, granted?: Set<string>): string {
  return sel(s, t, depth, granted)?.text ?? ""
}
function sel(s: GraphQLSchema, t: GraphQLOutputType | GraphQLNamedType, depth: number, granted?: Set<string>): Sel | null {
  const named = getNamedType(t)
  if (isLeafType(named)) return null
  if (isObjectType(named)) {
    const fs = fieldsOf(s, named, depth, granted)
    return fs.length ? { text: `{ ${fs.map((f) => f.text).join(" ")} }`, sig: `{${fs.map((f) => f.sig).join(",")}}` } : null
  }
  if (!isUnionType(named) && !isInterfaceType(named)) return null
  const own = isInterfaceType(named) ? fieldsOf(s, named, depth, granted) : []
  const ownNames = new Set(own.map((f) => f.name))
  const members = s.getPossibleTypes(named)
  const frags: Sel[] = []
  const shapes = new Map<string, string>()
  if (members.length <= MAX_FRAGMENTS) for (const m of members) {
    const fs = fieldsOf(s, m, depth, granted).filter((f) => !ownNames.has(f.name))
    if (!fs.length) continue
    const parts = fs.map((f) => {
      const seen = shapes.get(f.name)
      if (seen === undefined) { shapes.set(f.name, f.sig); return f.text }
      return seen === f.sig ? f.text : `${f.name}_${m.name}: ${f.text}`
    })
    frags.push({ text: `... on ${m.name} { ${parts.join(" ")} }`, sig: `${m.name}{${fs.map((f) => f.sig).join(",")}}` })
  }
  return { text: `{ __typename${own.map((f) => " " + f.text).join("")}${frags.map((f) => " " + f.text).join("")} }`, sig: `{${own.map((f) => f.sig).join(",")}|${frags.map((f) => f.sig).join(",")}}` }
}
function fieldsOf(s: GraphQLSchema, type: GraphQLNamedType, depth: number, granted?: Set<string>): (Sel & { name: string })[] {
  const out: (Sel & { name: string })[] = []
  for (const f of Object.values((type as GraphQLObjectType).getFields())) {
    if (f.args.some((a) => isNonNullType(a.type))) continue
    if (granted && !allowed(s, type, f.name, granted)) continue
    if (isLeafType(getNamedType(f.type))) out.push({ name: f.name, text: f.name, sig: `${f.name}:${f.type}` })
    else if (depth > 0) { const c = sel(s, f.type, depth - 1, granted); if (c) out.push({ name: f.name, text: `${f.name} ${c.text}`, sig: `${f.name}:${f.type}${c.sig}` }) }
  }
  return out
}

/**
 * Whether the token may read a field. An interface field counts as restricted when any
 * implementation restricts it: ListingV2.unansweredQuestions carries no @authorize, but
 * SingleSkuListing's (needing sell.listing.read) does, and eBay enforces that one.
 */
function allowed(s: GraphQLSchema, type: GraphQLNamedType, name: string, granted: Set<string>): boolean {
  const decls = [type, ...(isInterfaceType(type) ? s.getPossibleTypes(type) : [])].map((t) => (t as GraphQLObjectType).getFields()[name]).filter(Boolean)
  return decls.every((f) => { const sc = authorizeScopes(f); return !sc.length || sc.some((x) => granted.has(x)) })
}

function rootField(s: GraphQLSchema, op: GqlOp) { return (op.kind === "query" ? s.getQueryType()! : s.getMutationType()!).getFields()[op.operationId] }

/** Field names of a type, for "did you mean" on a bad --select. */
function withFieldHints(s: GraphQLSchema, msg: string): string {
  const m = msg.match(/Cannot query field "\w+" on type "(\w+)"/)
  const t = m && s.getType(m[1])
  return t && "getFields" in t ? `${msg} Fields on ${m[1]}: ${Object.keys((t as GraphQLObjectType).getFields()).join(", ")}` : msg
}

/** Validate a document and its variables against the schema; returns the operation to run. */
function check(s: GraphQLSchema, query: string, variables: Record<string, unknown>, operationName?: string): OperationDefinitionNode {
  const doc = parse(query)
  const errors = validate(s, doc)
  if (errors.length) throw new Error(`GraphQL validation failed:\n${errors.map((e) => withFieldHints(s, e.message)).join("\n")}`)
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  const op = operationName ? ops.find((o) => o.name?.value === operationName) : ops[0]
  if (!op) throw new Error(operationName ? `no operation named "${operationName}" in the document` : "the document has no operation")
  if (!operationName && ops.length > 1) throw new Error(`the document has ${ops.length} operations; pass --operation <name>`)
  const coerced = getVariableValues(s, op.variableDefinitions ?? [], variables, { maxErrors: 20 })
  if ("errors" in coerced && coerced.errors?.length) throw new Error(`invalid arguments:\n${coerced.errors.map((e) => e.message).join("\n")}`)
  return op
}

/** Build `query|mutation Op($a: T!) { field(a: $a) { … } }` for one root field from the provided args. */
export async function buildGql(op: GqlOp, args: Record<string, unknown>, opts: { select?: string; depth?: number; granted?: string[] } = {}) {
  const s = await schema()
  const field = rootField(s, op)
  for (const k of Object.keys(args)) if (!field.args.some((a) => a.name === k)) throw new Error(`${op.id} has no argument "${k}". Arguments: ${field.args.map((a) => `${a.name}: ${a.type}`).join(", ") || "none"}`)
  const missing = field.args.filter((a) => isNonNullType(a.type) && args[a.name] === undefined)
  if (missing.length) throw new Error(`${op.id} needs ${missing.map((a) => `${a.name}: ${a.type}`).join(", ")} (-a ${missing[0].name}='{…}'); see \`social ebay describe ${op.id}\``)
  const used = field.args.filter((a) => args[a.name] !== undefined)
  let sl = ""
  if (opts.select) sl = opts.select.trim().startsWith("{") ? opts.select : `{ ${opts.select} }`
  else if (!isLeafType(getNamedType(field.type))) {
    sl = selection(s, field.type, opts.depth ?? 3, opts.granted ? new Set(opts.granted) : undefined)
    const named = getNamedType(field.type)
    if (!sl && isObjectType(named) && Object.values(named.getFields()).every((f) => f.args.some((a) => isNonNullType(a.type)))) {
      // orders / itemCommitments / purchaseQuotes: every child needs its own input, which -a can't reach.
      const kids = Object.values(named.getFields())
      throw new Error(`${op.id} has no default selection: each of its fields needs its own arguments. Choose one with --select, e.g. --select '${kids[0].name}(${kids[0].args[0].name}: {…}) { … }'. Fields: ${kids.map((f) => `${f.name}(${f.args.map((a) => `${a.name}: ${a.type}`).join(", ")})`).join(", ")}`)
    }
    if (!sl) sl = "{ __typename }"
  }
  const name = op.operationId[0].toUpperCase() + op.operationId.slice(1)
  const query = `${op.kind} ${name}${used.length ? `(${used.map((a) => `$${a.name}: ${a.type}`).join(", ")})` : ""} { ${op.operationId}${used.length ? `(${used.map((a) => `${a.name}: $${a.name}`).join(", ")})` : ""}${sl ? " " + sl : ""} }`
  const variables = Object.fromEntries(used.map((a) => [a.name, args[a.name]]))
  check(s, query, variables)
  return { query, variables, operationName: name }
}

export async function callGql(query: string, variables: Record<string, unknown>, ctx: CallContext, operationName?: string): Promise<unknown> {
  const s = await schema()
  const op = check(s, query, variables, operationName)
  let force = false
  const url = new URL(ctx.sandbox ? endpoints.graphql.sandbox : endpoints.graphql.production)
  const http = makeHttp({
    baseUrl: url.origin, allowHost: (h) => endpoints.allowHost(h),
    headers: async () => ({ authorization: `Bearer ${await ctx.tokens.user(force)}`, "X-EBAY-C-MARKETPLACE-ID": ctx.marketplace }),
    onUnauthorized: async () => (!force ? (force = true) : false),
  })
  // Every GraphQL request is a POST, so --dry-run prints queries as well as mutations.
  const r = await http.request<any>({ method: "POST", path: url.pathname, body: { query, variables, operationName: op.name?.value } })
  if (r?.errors?.length) {
    const lines = r.errors.map((e: any) => `${e.message}${e.path ? ` (at ${e.path.join(".")})` : ""}`)
    const empty = !r.data || Object.values(r.data).every((v) => v === null)
    if (empty) throw new Error(`GraphQL errors:\n${lines.join("\n")}`)
    // Partial data: print it, but say what failed and exit non-zero so scripts notice.
    for (const l of lines) note(`GraphQL error: ${l}`)
    process.exitCode = 1
  }
  return r
}

// ---------- describe ----------

function enumValues(t: GraphQLNamedType): string { return isEnumType(t) ? t.getValues().map((v) => v.name).join(", ") : "" }

function gqlType(t: GraphQLInputType, depth: number, indent = "  ", seen = new Set<string>()): string {
  const named = getNamedType(t)
  if (isEnumType(named)) return `${indent}one of: ${enumValues(named)}`
  if (!isInputObjectType(named) || depth < 0 || seen.has(named.name)) return ""
  const next = new Set(seen).add(named.name)
  return Object.values(named.getFields()).map((f) => {
    const inner = getNamedType(f.type)
    const kids = isInputObjectType(inner) ? gqlType(f.type, depth - 1, indent + "  ", next) : isEnumType(inner) && inner.getValues().length <= 12 ? `${indent}  one of: ${enumValues(inner)}` : ""
    const desc = brief(f.description ?? undefined, 140)
    return `${indent}${f.name}: ${f.type}${desc ? `  — ${desc}` : ""}${kids ? "\n" + kids : ""}`
  }).join("\n")
}

/** Dot paths of every required (non-null) input field, following only required objects. */
function requiredPaths(t: GraphQLInputType, prefix: string, seen = new Set<string>()): string[] {
  const named = getNamedType(t)
  if (!isInputObjectType(named) || seen.has(named.name)) return []
  const next = new Set(seen).add(named.name)
  return Object.values(named.getFields()).filter((f) => isNonNullType(f.type)).flatMap((f) => {
    const p = `${prefix}.${f.name}${String(f.type).includes("[") ? "[]" : ""}`
    const kids = requiredPaths(f.type, p, next)
    return kids.length ? kids : [p]
  })
}

export async function describe(op: Op, o: { depth?: number; path?: string; granted?: string[] } = {}): Promise<string> {
  const lines: string[] = []
  if (op.kind === "rest") return generated.describe(op, o.depth)
  const depth = o.depth ?? 1
  const s = await schema()
  const field = rootField(s, op)
  if (o.path) {
    // Drill into one input: --path input.listingTerms.fulfillmentTerms (the arg name may be left off).
    const parts = o.path.split(".")
    const arg = field.args.find((a) => a.name === parts[0]) ?? field.args.find((a) => a.name === "input")
    if (!arg) throw new Error(`${op.id} has no argument "${parts[0]}"`)
    let t: GraphQLInputType = arg.type
    for (const p of parts[0] === arg.name ? parts.slice(1) : parts) {
      const named = getNamedType(t)
      const f = isInputObjectType(named) ? named.getFields()[p] : undefined
      if (!f) throw new Error(`no field "${p}" on ${named}; fields: ${isInputObjectType(named) ? Object.keys(named.getFields()).join(", ") : "none"}`)
      t = f.type
    }
    return `${op.id} ${o.path}: ${t}\n${gqlType(t, depth, "  ")}`
  }
  lines.push(`${op.id}  GraphQL ${op.kind} ${op.operationId} → ${field.type}`, "", clean(field.description ?? "").slice(0, 1200), "")
  if (op.scopes.length) lines.push(`token: user (OAuth); scopes: ${op.scopes.map((x) => x.split("/").pop()).join(", ")}`)
  const req = field.args.flatMap((a) => (isNonNullType(a.type) ? requiredPaths(a.type, a.name) : []))
  if (req.length) lines.push("", "required fields:", ...req.map((p) => `  ${p}`))
  lines.push("", "arguments (-a name=JSON or --input args.json; --depth N to expand, --path input.x.y to drill in):", ...field.args.map((a) => `  ${a.name}: ${a.type}\n${gqlType(a.type, depth, "    ")}`))
  if (!isLeafType(getNamedType(field.type))) {
    const preview = selection(s, field.type, 3, o.granted ? new Set(o.granted) : undefined) || "(none: choose fields with --select)"
    lines.push("", "default selection (what `call` returns; override with --select):", "  " + (preview.length > 1500 ? preview.slice(0, 1500) + "…  (--print-query shows it all)" : preview))
  }
  return lines.join("\n")
}
