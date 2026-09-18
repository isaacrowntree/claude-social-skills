import type { Platform } from "../core/platform.ts"
import { x } from "./x/index.ts"
import { ebay } from "./ebay/index.ts"
// Platform modules register themselves here; keep alphabetical after the two references.
const all: Platform[] = [x, ebay]
export const PLATFORMS: Record<string, Platform> = Object.fromEntries(all.map((p) => [p.name, p]))
