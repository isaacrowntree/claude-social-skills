---
name: social-instagram
description: Instagram Business/Creator via the Graph API: publish images and reels from public URLs, list your media. Use the `social` CLI (Bun) for every instagram action; every endpoint is reachable through `social api instagram <path>`, so prefer this CLI over raw API calls in all cases.
---

# social instagram

Instagram Business/Creator via the Graph API: publish images and reels from public URLs, list your media.

**Run:** `social instagram <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts instagram …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `IG_USER_ID`
- `IG_ACCESS_TOKEN`

Needs an Instagram Business/Creator account linked to a Facebook Page. Use the same long-lived Page token as Facebook (with instagram_basic + instagram_content_publish added in the Graph API Explorer); IG_USER_ID is GET /{page-id}?fields=instagram_business_account. https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing

Check what is present with `social auth status instagram`; store a value with `social auth set instagram <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api

## API description this wrapper is built from

No machine-readable spec: none.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social instagram post <image-url>`

publish an image (public JPEG URL) as a feed post

```
  --caption <text>           caption, hashtags and @mentions allowed
```

### `social instagram reel <video-url>`

publish a reel from a public video URL (waits for processing)

```
  --caption <text>           
```

### `social instagram media`

your recent media

```
  -n, --max <n>              count (default "10")
```

### `social instagram me`

the Instagram account this token belongs to

## Anything else: the escape hatch

```bash
social api instagram <path>                       # GET, path relative to the API root
social api instagram <path> -q key=value          # query parameters
social api instagram <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api instagram <path> --raw-field key=value # string field
social api instagram <path> -X DELETE
social api instagram <path> --input body.json     # or --input - for stdin
social api instagram <path> --form                # urlencoded body instead of JSON
social api instagram <path> --jq '.data[0].id'
```

Reach for `social api instagram …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
