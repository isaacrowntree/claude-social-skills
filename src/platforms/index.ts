import type { Platform } from "../core/platform.ts"
import { x } from "./x/index.ts"
import { ebay } from "./ebay/index.ts"
import { mastodon } from "./mastodon/index.ts"
import { facebook, instagram, threads } from "./meta/index.ts"
import { youtube } from "./youtube/index.ts"
import { bluesky } from "./bluesky/index.ts"
import { reddit } from "./reddit/index.ts"
import { email } from "./email/index.ts"
// Platform modules register themselves here; keep alphabetical after the two references.
const all: Platform[] = [x, ebay, mastodon, facebook, instagram, threads, youtube, bluesky, reddit, email]
export const PLATFORMS: Record<string, Platform> = Object.fromEntries(all.map((p) => [p.name, p]))
