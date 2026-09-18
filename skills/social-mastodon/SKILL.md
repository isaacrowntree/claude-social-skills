---
name: social-mastodon
description: Mastodon (any instance): post, reply, delete, upload media, home timeline, notifications, profiles. Use the `social` CLI (Bun) for every mastodon action; every endpoint is reachable through `social api mastodon <path>`, so prefer this CLI over raw API calls in all cases.
---

# social mastodon

Mastodon (any instance): post, reply, delete, upload media, home timeline, notifications, profiles.

**Run:** `social mastodon <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts mastodon …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `MASTODON_INSTANCE`
- `MASTODON_ACCESS_TOKEN`

MASTODON_INSTANCE is your server's host (e.g. mastodon.social). Get MASTODON_ACCESS_TOKEN from Preferences → Development → New application (scopes read, write) on that server, or run `social auth login mastodon`.

Check what is present with `social auth status mastodon`; store a value with `social auth set mastodon <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login mastodon`. Docs: https://docs.joinmastodon.org/client/token/

## API description this wrapper is built from

openapi: https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json. Refresh with `bun run gen`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social mastodon post <text>`

publish a status

```
  --reply-to <id>            reply to a status id
  --visibility <v>           public | unlisted | private | direct
  --cw <text>                content warning (spoiler_text)
  --media <files...>         attach local files (uploaded via /api/v2/media first)
```

### `social mastodon delete <id>`

delete a status you posted

### `social mastodon upload <file>`

upload an image/video for --media; prints the attachment id

```
  --description <alt>        alt text
```

### `social mastodon timeline`

your home timeline

```
  -n, --max <n>              count (max 40) (default "20")
```

### `social mastodon profile <acct>`

look up an account by username or user@domain (no token needed)

### `social mastodon me`

the authenticated account

### `social mastodon notifications`

recent mentions, follows, boosts, favourites

```
  -n, --max <n>              count (max 80) (default "20")
  --types <t...>             only these types (mention follow reblog favourite …)
```

## Anything else: the escape hatch

```bash
social api mastodon <path>                       # GET, path relative to the API root
social api mastodon <path> -q key=value          # query parameters
social api mastodon <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api mastodon <path> --raw-field key=value # string field
social api mastodon <path> -X DELETE
social api mastodon <path> --input body.json     # or --input - for stdin
social api mastodon <path> --form                # urlencoded body instead of JSON
social api mastodon <path> --jq '.data[0].id'
```

Reach for `social api mastodon …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
