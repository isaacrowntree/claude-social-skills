/**
 * The contract every platform module implements. Keeping it tiny is the point:
 * a platform is an authenticated HTTP base plus a list of curated commands.
 * Everything else reaches the API through `social api <platform> …`.
 */
import type { Command } from "commander"
import type { Http } from "./http.ts"

export interface Platform {
  /** CLI name, e.g. "x", "ebay". */
  name: string
  /** One-line description shown in `social --help`. */
  summary: string
  /** Where the spec came from (URL or "lexicons" or "none"), for the skill docs. */
  spec: { kind: "openapi" | "discovery" | "lexicon" | "none"; source: string }
  /** Env/keyring keys this platform needs and how to get them. */
  /** `keys`: what a full setup needs. `optionalKeys`: also accepted by `auth set`. `minimal`: any one
   *  of these sets being present means the platform is usable (defaults to all of `keys`). */
  credentials: { keys: string[]; optionalKeys?: string[]; minimal?: string[][]; hint: string; docsUrl: string }
  /** Build an authenticated HTTP client. Throws a helpful error when credentials are missing. */
  http(): Promise<Http>
  /** Register curated commands under `social <platform> …`. */
  register(cmd: Command): void
  /** Interactive auth flow (`social auth <platform>`), if the platform has one. */
  auth?(): Promise<void>
  /** A cheap authenticated read used by `social doctor` and live tests. */
  whoami?(): Promise<unknown>
  /** Generated-platform additions to SKILL.md: `body` is appended; `description` and `escapeHatch` replace the generic ones. */
  skill?(): Promise<{ body: string; description?: string; escapeHatch?: string }>
}
