---
name: social-bluesky
description: Bluesky (AT Protocol): post, reply, delete, timeline, profiles; any XRPC method via `social api bluesky`. Use the `social` CLI (Bun) for every bluesky action; every endpoint is reachable through `social api bluesky <path>`, so prefer this CLI over raw API calls in all cases.
---

# social bluesky

Bluesky (AT Protocol): post, reply, delete, timeline, profiles; any XRPC method via `social api bluesky`.

**Run:** `social bluesky <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts bluesky …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `BLUESKY_HANDLE`
- `BLUESKY_APP_PASSWORD`

Your handle (e.g. alice.bsky.social) and an app password from https://bsky.app/settings/app-passwords (never your main password). BLUESKY_SERVICE overrides the PDS for self-hosted accounts (default https://bsky.social).

Check what is present with `social auth status bluesky`; store a value with `social auth set bluesky <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login bluesky`. Docs: https://bsky.network/docs/get-started

## API description this wrapper is built from

lexicon: https://github.com/bluesky-social/atproto/tree/main/lexicons/app/bsky (typed client: @atproto/api). Refresh with `bun run gen`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social bluesky post <text>`

post to Bluesky (links, @mentions and #tags become facets)

```
  --reply-to <uri>           reply to a post at:// uri
  --image <files...>         attach up to 4 images (≤1 MB each)
  --alt <texts...>           alt text per image, in order
```

### `social bluesky delete <uri>`

delete one of your posts by at:// uri (or rkey)

### `social bluesky timeline [handle]`

your home timeline, or a given account's posts (no login needed for the latter)

```
  -n, --max <n>              count (1-100) (default "20")
```

### `social bluesky profile <handle>`

look up an account by handle or did (no login needed)

### `social bluesky me`

the authenticated account

## Anything else: the escape hatch

```bash
social api bluesky <path>                       # GET, path relative to the API root
social api bluesky <path> -q key=value          # query parameters
social api bluesky <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api bluesky <path> --raw-field key=value # string field
social api bluesky <path> -X DELETE
social api bluesky <path> --input body.json     # or --input - for stdin
social api bluesky <path> --form                # urlencoded body instead of JSON
social api bluesky <path> --jq '.data[0].id'
```

Reach for `social api bluesky …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
