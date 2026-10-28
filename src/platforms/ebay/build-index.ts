/**
 * Build ops.gen.json: one flat index of every operation in the pulled eBay specs
 * (REST OpenAPI documents + the GraphQL schema), which is all the eBay runtime needs to
 * list, search, describe and call them. Request/response schemas are not copied;
 * `social ebay describe` reads them from specs/ on demand.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildSchema, getNamedType, isInputObjectType, type GraphQLField, type GraphQLInputType } from "graphql"
import { EBAY_REST, SPEC_DIR, writeAtomic } from "../../core/specs.ts"
import { apiName, brief, clean, deref, restOps as genericRestOps, type OpFix, type OpsIndex as GenericIndex, type RestOp } from "../../core/openapi.ts"

export const INDEX_FILE = fileURLToPath(new URL("./ops.gen.json", import.meta.url))

export type { RestOp, RestParam } from "../../core/openapi.ts"
export { apiName, brief, clean, deref }
export interface GqlOp {
  kind: "query" | "mutation"; id: string; api: "gql"; operationId: string; summary: string
  args: { name: string; type: string }[]; scopes: string[]; auth: "user"; keywords: string
}
export type Op = RestOp | GqlOp
export type OpsIndex = GenericIndex<Op>

/**
 * Where a published spec is wrong about how to reach its API. `host` replaces the API-wide
 * server only; servers declared on a path or operation are kept. Each entry was verified
 * against production (2026-10-28) unless noted; drop it once eBay corrects the spec.
 */
const FIXES: Record<string, OpFix> = {
  // The spec says apiz.ebay.com, which answers errorId 2002 "Resource not found"; api.ebay.com serves it.
  fulfillment: { host: "https://api.ebay.com" },
  // Image and video methods live on apim.ebay.com (the spec's second server); document methods name their own host.
  media: { host: "https://apim.ebay.com" },
  // Post-Order rejects "Bearer" ("Bad scheme"); it takes the same OAuth user token as "IAF <token>".
  post_order: { scheme: "IAF" },
  // The spec offers only client credentials, but commerce.vero is a user-consent scope (granted under
  // Authorization Code on the app's keys page). Unverified: eBay answers 500 to either token today.
  vero_v2: { auth: "user" },
}

/** One eBay REST spec's operations, ids prefixed with the API name (`fulfillment.getOrders`). */
export function restOps(api: string, spec: any): RestOp[] { return genericRestOps(spec, { api, fix: FIXES[api] }) }

/** Names of every input field reachable from a type, to `depth`, so `ops price` finds updateListing. */
function inputNames(t: GraphQLInputType, depth: number, seen = new Set<string>()): string[] {
  const named = getNamedType(t)
  if (!isInputObjectType(named) || depth < 0 || seen.has(named.name)) return []
  seen.add(named.name)
  return Object.values(named.getFields()).flatMap((f) => [f.name, ...inputNames(f.type, depth - 1, seen)])
}

export function gqlOps(sdl: string): GqlOp[] {
  const schema = buildSchema(sdl)
  const out: GqlOp[] = []
  for (const [kind, type] of [["query", schema.getQueryType()], ["mutation", schema.getMutationType()]] as const) {
    for (const f of Object.values(type?.getFields() ?? {}) as GraphQLField<unknown, unknown>[]) {
      out.push({
        kind, id: `gql.${f.name}`, api: "gql", operationId: f.name, summary: brief(f.description ?? undefined),
        args: f.args.map((a) => ({ name: a.name, type: String(a.type) })), scopes: authorizeScopes(f), auth: "user",
        keywords: `${clean(f.description ?? "").slice(0, 400)} ${[...new Set(f.args.flatMap((a) => [a.name, ...inputNames(a.type, 4)]))].join(" ")}`.toLowerCase(),
      })
    }
  }
  return out
}

/** The scopes in a field's @authorize directive (empty when it has none). */
export function authorizeScopes(f: { astNode?: GraphQLField<unknown, unknown>["astNode"] | null }): string[] {
  const dir = f.astNode?.directives?.find((d) => d.name.value === "authorize")
  const v = dir?.arguments?.find((a) => a.name.value === "scopes")?.value
  return v?.kind === "ListValue" ? v.values.flatMap((x) => (x.kind === "StringValue" ? [x.value] : [])) : []
}

export async function buildEbayOps(specDir = SPEC_DIR, outFile = INDEX_FILE): Promise<OpsIndex> {
  const index: OpsIndex = { apis: {}, ops: [] }
  for (const name of EBAY_REST) {
    const file = join(specDir, `ebay-${name}.json`)
    if (!existsSync(file)) throw new Error(`${file} is missing; run \`social specs pull ebay\``)
    const spec = JSON.parse(readFileSync(file, "utf8"))
    const api = apiName(name)
    index.apis[api] = { title: spec.info?.title ?? api, version: spec.info?.version ?? "", spec: `ebay-${name}` }
    index.ops.push(...restOps(api, spec))
  }
  const gql = join(specDir, "ebay-graphql.graphqls")
  if (!existsSync(gql)) throw new Error(`${gql} is missing; run \`social specs pull ebay\``)
  index.apis.gql = { title: "eBay GraphQL (Listing, offers, orders, returns, inquiries…)", version: "", spec: "ebay-graphql" }
  index.ops.push(...gqlOps(readFileSync(gql, "utf8")))
  writeAtomic(outFile, JSON.stringify(index) + "\n")
  return index
}
