# social

One command-line tool for X, Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads, YouTube, Pinterest, Discord, eBay, Etsy and email, built from each platform's published API description and run directly by [Bun](https://bun.sh). No build step, no MCP server: a `social` binary on your PATH and one Claude Code skill per platform, generated from the binary so the docs cannot drift from what it does.

```bash
social x post "hello"                               # curated commands for what you do daily
social pinterest ops create pin                     # search a platform's generated operations
social pinterest describe pins/create               # parameters, body fields, scopes
social discord call create_message -p channel_id=1 -f content=hi   # call any of them by id
social ebay call fulfillment.getOrders -p limit=5   # eBay: every REST and GraphQL operation
social email trace <id>                             # SPF/DKIM/DMARC verdict and the Received chain
social specs pull                                   # fetch + regenerate from the live specs (never committed)
social --dry-run bluesky post "test"                # print the request, send nothing
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
| pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` (an app at developers.pinterest.com; business account), redirect URI `https://localhost:8085/callback`, then `auth login`; `PINTEREST_SANDBOX=1` while the app has trial access | OAuth in the browser, refreshed automatically |
| discord | `DISCORD_BOT_TOKEN` (developer portal → your app → Bot), and invite the bot to your server | bot token, no redirect |
| etsy | `ETSY_KEYSTRING`, `ETSY_SHARED_SECRET` (etsy.com/developers/your-apps) for public reads; callback URL `https://localhost:8086/callback` then `auth login` for your shop | OAuth with PKCE; access 1 h, refresh 90 days |
| ebay | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` (accept URL `https://localhost:8888/callback`, OAuth enabled), then `auth login` once; `EBAY_AUTH_TOKEN` only for the legacy `ebay trading` passthrough | OAuth in the browser, refresh token lasts ~18 months |
| email | none here; `himalaya account configure` | wraps the installed himalaya CLI (v2.1.0) |

`social doctor` makes one cheap authenticated read per configured platform.

## How it is built

- **Specs, pinned, never committed.** `src/core/specs.ts` lists every platform that publishes a machine-readable description: X (official OpenAPI 3), Bluesky (its OpenAPI rendering of the lexicons), Mastodon (community OpenAPI tracking 4.7), YouTube (Google Discovery), Pinterest (its v5 OpenAPI on GitHub), Discord (its official OpenAPI on GitHub), Etsy (Open API v3), and eBay (29 REST OpenAPI documents plus one GraphQL schema). `social specs pull [platform]` (or `bun run gen`) fetches them, checks each against its SHA-256 in `spec-pins.json`, and generates code. A spec that fails to download leaves the previous generated code in place rather than a partial one. `bun run verify-gen` fails in CI when upstream publishes something new; `bun run gen` pins new specs and `--update` re-pins changed ones (`social specs pull` never writes pins). Meta and Reddit publish no fetchable spec; those wrappers cite the doc page for each call in a comment.
- **Generated operations, every platform with a spec.** `src/core/openapi.ts` turns an OpenAPI or Google Discovery document into an operation index (`src/platforms/<name>/ops.gen.json`) and gives the platform `ops` (ranked search over ids, summaries, descriptions and field names), `describe` and `call`. Calls go through the platform's own authenticated client, so retries, token refresh and `--dry-run` all apply. X, Mastodon, Bluesky and YouTube get this on top of their curated commands; Pinterest, Discord and Etsy are nothing but this plus their auth. Tokens only go to the platform's own hosts.
- **eBay adds GraphQL.** `src/platforms/ebay/build-index.ts` indexes 29 REST specs and the GraphQL schema behind eBay's modernized APIs (Listing, offers, orders, returns). GraphQL documents and variables are checked against the schema before sending, and default selections leave out fields the sign-in can't read. The few places eBay's specs are wrong about hosts or auth are one documented table (`FIXES`).
- **Shared sign-in.** `src/core/oauth.ts` serves the OAuth redirect on localhost (https with a throwaway certificate when the redirect URI is https), checks `state`, and shuts down without cutting off the "Authorised" page; eBay, Pinterest and Etsy use it.
- **One HTTP layer** (`src/core/http.ts`): retries on 502/503/504 for idempotent methods, one wait on 429, typed `ApiError` with the response body, and `--dry-run`. Every platform is a thin config over it.
- **One contract** (`src/core/platform.ts`): a platform is an authenticated client plus its commands: generated ones where a spec exists, curated ones for what you do daily. `social api <platform> <path>` remains the escape hatch for anything outside a spec.
- **Docs from the binary.** `bun run gen-skills` writes `skills/social-<platform>/SKILL.md` from the registered commands and their flags; `--verify` fails CI on drift.
- **Tests without the network.** `bun test` runs every curated command, and the generated runtime, against a local fake that asserts the exact method, path, query, headers and body. `social doctor` and the smoke job in CI are the only things that touch real servers.

## Verified against the real servers

Generated operations (2026-10-28): Bluesky `app.bsky.actor.getProfile` and Mastodon `getInstanceV2` without credentials; Pinterest, Discord and Etsy answer their documented auth errors (Etsy wants `x-api-key: keystring:shared_secret` on every request, its token endpoint included). Pinterest, Discord and Etsy have not been called with real credentials yet.

eBay's generated APIs (2026-10-28): Identity, Fulfillment, Finances, Message, Taxonomy, Metadata, Post-Order and Account reads; GraphQL `sellerListingSearch`, `sellerListings`, `sellerNegotiationHistory`; `media.createImageFromFile` (a real upload); `gql.createListing` in VALIDATE mode through to `CreateListingValidationSuccess`; then, on the account owner's say-so, `gql.updateListing` (price, free postage, Best Offer thresholds, title), `gql.endListing`, `marketing.createCampaign` + `bulkCreateAdsByListingId`, and `negotiation.sendOfferToInterestedBuyers` (which needs no `sell.negotiation` scope, and refuses `allowCounterOffer: true`). Trading's `UploadSiteHostedPictures` now answers 404, so picture upload is the Media API.

What was exercised live with real credentials, read-only (2026-09-18): eBay `GetUser`, `GetMyeBaySelling`, `GetMyMessages`, `GetBestOffers`, `GetItem`, `VerifyAddFixedPriceItem`; himalaya `account list`, `mailbox list`, `envelope list`, `envelope search`, `message read`, `attachment list` on three accounts. What the servers said that the docs do not:

- eBay retired `GetCategories`, `GetCategorySpecifics`, `GetSuggestedCategories`, `GetCategoryFeatures` and `GeteBayOfficialTime` (HTTP 410). Category and item-specifics lookups now use the Commerce Taxonomy API with an app-only token.
- X returns `402 credits depleted` for an app with no API credits; the auth path is correct but nothing can be read or written until the account has credit.
- Mastodon: mastodon.social answers the public timeline with 422 without a token; other instances answer 200.
- Reddit: logged-out JSON is blocked by network security for some IPs regardless of User-Agent, and any API access now needs explicit approval.
- Meta: the Graph API is on v26.0 (the old scripts used v24.0); header-based auth failures are 401, query-string ones are 400.
- Bluesky: an expired access token is a 400 `ExpiredToken`, not a 401; bad credentials are `AuthenticationRequired`, which the OpenAPI does not list.
- himalaya v2.1.0 rejects eight flags the previous skill documented for v1.2.0, and reading no longer marks a message seen.

Not exercised live for lack of credentials on the build machine: any authenticated call on Bluesky, Mastodon, Reddit, Facebook, Instagram, Threads, YouTube, Pinterest, Discord and Etsy, and anything outside eBay that publishes, sends, moves or deletes. Each of those is covered by the local fake only.

## Commands

```
Commands:
  x                                X (Twitter) API v2: post, reply, delete, read
                                   your timeline, upload media
  ebay                             eBay: every REST and GraphQL operation eBay
                                   publishes (listings, orders, offers,
                                   messages, returns, media, finances…),
                                   generated from its specs
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
  pinterest                        Pinterest API v5: every operation (pins,
                                   boards, sections, media, analytics, ads…),
                                   generated from Pinterest's OpenAPI
                                   description
  discord                          Discord: every HTTP API operation (messages,
                                   channels, servers, threads, webhooks,
                                   members…) as a bot, generated from Discord's
                                   OpenAPI description
  etsy                             Etsy Open API v3: every operation (shop,
                                   listings, images, inventory, orders/receipts,
                                   shipping…), generated from Etsy's OpenAPI
                                   description
  api [options] <platform> <path>  Call any endpoint of a platform directly,
                                   with its auth applied
  auth                             Store credentials for a platform (keyring, or
                                   ~/.config/social/.env)
  doctor [options]                 make one cheap authenticated call per
                                   configured platform and report
  specs                            pull and regenerate the API specs the CLI is
                                   built from (not committed to git)
  help [command]                   display help for command
```

Each platform has its own `social <platform> --help` and a `skills/social-<platform>/SKILL.md` with every command and flag; generated platforms list their API groups and recipes there too.

## Licence

MIT.
