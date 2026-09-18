/** The spec registry: one entry per platform that publishes a machine-readable API description. */
import { join } from "node:path"

export interface SpecSource {
  name: string
  url: string
  sha256?: string
  /** Normalise the upstream text before generation (like clickup's patch-v2-spec.jq). Keep it tiny and documented. */
  patch?: (text: string) => string
  /** Generate types from the normalised spec. */
  generate?: (specPath: string, root: string) => Promise<void>
}

async function openapiTypes(specPath: string, root: string, platform: string) {
  const outDir = join(root, "src", "platforms", platform)
  const p = Bun.spawn(["bunx", "openapi-typescript", specPath, "-o", join(outDir, "types.gen.ts")], { stdout: "inherit", stderr: "inherit" })
  if ((await p.exited) !== 0) throw new Error(`openapi-typescript failed for ${platform}`)
}

export const SPECS: SpecSource[] = [
  {
    name: "x",
    url: "https://api.x.com/2/openapi.json",
    generate: (p, r) => openapiTypes(p, r, "x"),
  },
  {
    name: "mastodon",
    url: "https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json",
    generate: (p, r) => openapiTypes(p, r, "mastodon"),
  },
  {
    name: "youtube",
    url: "https://youtube.googleapis.com/$discovery/rest?version=v3",
    // Google Discovery is not OpenAPI; the `googleapis` package is generated from it upstream,
    // so here we only pin the document and record its revision for the skill docs.
  },
]
