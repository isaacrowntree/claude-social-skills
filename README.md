# social

One command-line tool for X, Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads, YouTube, eBay and email, built from each platform's published API description and run directly by [Bun](https://bun.sh). No build step, no MCP server: a `social` binary on your PATH and one Claude Code skill per platform, generated from the binary so the docs cannot drift from what it does.

```bash
social x post "hello"                          # curated commands for what you do daily
social ebay selling                            # your active listings, with prices
social email trace <id>                        # SPF/DKIM/DMARC verdict and the Received chain
social api mastodon api/v1/trends/tags         # any endpoint of any platform, auth applied
social api ebay sell/inventory/v1/offer --input offer.json
social --dry-run bluesky post "test"           # print the request, send nothing
```

## Install

```bash
git clone https://github.com/isaacrowntree/claude-social-skills && cd claude-social-skills
./scripts/setup.sh      # bun install, `social` on PATH, fetch + pin specs, link skills into ~/.claude/skills
social auth status      # what each platform still needs
```

Or as a Claude Code plugin: `/plugin marketplace add isaacrowntree/claude-social-skills`.

## Credentials

Every platform reads its keys from, in order: the environment, `~/.config/social/.env`, the OS keyring. `social auth set <platform> <KEY> <value>` writes to the keyring when one exists. Platforms with a browser flow use `social auth login <platform>`.

| platform | what you need | flow |
|---|---|---|
| x | `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`; `TWITTER_BEARER_TOKEN` alone for reads | paste from the developer portal |
| bluesky | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | app password, no redirect |
| mastodon | `MASTODON_INSTANCE`, `MASTODON_ACCESS_TOKEN` | paste, or `auth login` (paste-the-code flow, no redirect server) |
| reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, plus username/password (2FA off) or `auth login` | Reddit requires app approval since Nov 2025 |
| facebook | `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN` | long-lived page token from the Graph API Explorer |
| instagram | `IG_USER_ID`, `IG_ACCESS_TOKEN` | same |
| threads | `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN` | Threads tester + token exchange |
| youtube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` then `auth login` | OAuth with PKCE on a loopback port |
| ebay | `EBAY_AUTH_TOKEN` for everything day-to-day; `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` for category lookups; add `EBAY_RUNAME` + `auth login` only for user-scoped Sell REST | Auth'n'Auth is one pasted token, no server |
| email | none here; `himalaya account configure` | wraps the installed himalaya CLI (v2.1.0) |

`social doctor` makes one cheap authenticated read per configured platform.

## How it is built

- **Specs, pinned.** `scripts/specs.ts` lists every platform that publishes a machine-readable description: X (official OpenAPI 3), Bluesky (its OpenAPI rendering of the lexicons), Mastodon (community OpenAPI tracking 4.7), YouTube (Google Discovery). `bun run gen` fetches each, checks it against a pinned SHA-256, and generates TypeScript types. `bun run verify-gen` fails in CI when upstream publishes something new, so a changed API is a failing build, not a surprise. Meta, Reddit and eBay publish no fetchable spec; those wrappers cite the doc page for each call in a comment.
- **One HTTP layer** (`src/core/http.ts`): retries on 502/503/504 for idempotent methods, one wait on 429, typed `ApiError` with the response body, and `--dry-run`. Every platform is a thin config over it.
- **One contract** (`src/core/platform.ts`): a platform is an authenticated client plus a handful of curated commands. Everything else goes through `social api <platform> <path>`, which is the escape hatch and the reason there is no flag per API field.
- **Docs from the binary.** `bun run gen-skills` writes `skills/social-<platform>/SKILL.md` from the registered commands and their flags; `--verify` fails CI on drift.
- **Tests without the network.** `bun test` runs every curated command against a local fake that asserts the exact method, path, query, headers and body. `social doctor` and the smoke job in CI are the only things that touch real servers.

## Verified against the real servers (2026-09-18)

What was exercised live with real credentials, read-only: eBay `GetUser`, `GetMyeBaySelling`, `GetMyMessages`, `GetBestOffers`, `GetItem`, `VerifyAddFixedPriceItem`; himalaya `account list`, `mailbox list`, `envelope list`, `envelope search`, `message read`, `attachment list` on three accounts. What the servers said that the docs do not:

- eBay retired `GetCategories`, `GetCategorySpecifics`, `GetSuggestedCategories`, `GetCategoryFeatures` and `GeteBayOfficialTime` (HTTP 410). Category and item-specifics lookups now use the Commerce Taxonomy API with an app-only token.
- X returns `402 credits depleted` for an app with no API credits; the auth path is correct but nothing can be read or written until the account has credit.
- Mastodon: mastodon.social answers the public timeline with 422 without a token; other instances answer 200.
- Reddit: logged-out JSON is blocked by network security for some IPs regardless of User-Agent, and any API access now needs explicit approval.
- Meta: the Graph API is on v26.0 (the old scripts used v24.0); header-based auth failures are 401, query-string ones are 400.
- Bluesky: an expired access token is a 400 `ExpiredToken`, not a 401; bad credentials are `AuthenticationRequired`, which the OpenAPI does not list.
- himalaya v2.1.0 rejects eight flags the previous skill documented for v1.2.0, and reading no longer marks a message seen.

Not exercised live for lack of credentials on the build machine: any authenticated call on Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads and YouTube, and anything that publishes, sends, moves or deletes. Each of those is covered by the local fake only.

## Commands

```
Commands:
  x                                X (Twitter) API v2: post, reply, delete, read
                                   your timeline, upload media
  ebay                             eBay: list, revise, messages, offers,
                                   categories (Trading, Auth'n'Auth) and any
                                   Sell REST API (OAuth)
  mastodon                         Mastodon (any instance): post, reply, delete,
                                   upload media, home timeline, notifications,
                                   profiles
  facebook                         Facebook Page via the Graph API: post text,
                                   links and photos, read and delete your Page's
                                   posts
  instagram                        Instagram Business/Creator via the Graph API:
                                   publish images and reels from public URLs,
                                   list your media
  threads                          Threads API: post text or an image, read your
                                   posts and profile
  youtube                          YouTube Data API v3: your channel, uploads,
                                   video details, comments, upload and delete
                                   videos
  bluesky                          Bluesky (AT Protocol): post, reply, delete,
                                   timeline, profiles; any XRPC method via
                                   `social api bluesky`
  reddit                           Reddit: post, comment, delete, inbox, home
                                   feed and subreddit listings, plus any Data
                                   API path
  email                            Email through the himalaya CLI: list, read,
                                   search, trace headers, send, reply, move,
                                   flag, delete
  api [options] <platform> <path>  Call any endpoint of a platform directly,
                                   with its auth applied
  auth                             Store credentials for a platform (keyring, or
                                   ~/.config/social/.env)
  doctor [options]                 make one cheap authenticated call per
                                   configured platform and report
  help [command]                   display help for command
```

Each platform has its own `social <platform> --help` and a `skills/social-<platform>/SKILL.md` with every command and flag.

## Licence

MIT.
