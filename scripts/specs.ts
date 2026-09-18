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
    sha256: "059f518553edae8d2ae38e86ff1d946bc45c91d5348d54952096a923b37e4f36",
    generate: (p, r) => openapiTypes(p, r, "x"),
  },
  {
    name: "mastodon",
    url: "https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json",
    sha256: "c736f4bd8e4048bfe272c571f9fc7ede67d781bfe142ec155a9ea44fa1d3a11a",
    generate: (p, r) => openapiTypes(p, r, "mastodon"),
  },
  {
    name: "bluesky",
    // Bluesky's own OpenAPI 3.1 rendering of the app.bsky + com.atproto lexicons (152 paths).
    // The typed client @atproto/api is generated upstream from the same lexicons, so no generate step.
    url: "https://endpoints.bsky.app/openapi.bluesky-app.json",
    sha256: "87b710e304c9daa3ed9eebd071958927ce1e2a0e735f5a0fd66d2a0efdf40f5c",
  },
  {
    name: "youtube",
    url: "https://youtube.googleapis.com/$discovery/rest?version=v3",
    sha256: "3e283b7129cf26d1019148cf2d932831a79e4724933c69bf613ffbe224e7ff33",
    // Google Discovery is not OpenAPI; the `googleapis` package is generated from it upstream,
    // so here we only pin the document and record its revision for the skill docs.
  },
]
