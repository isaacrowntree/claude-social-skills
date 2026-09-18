---
name: social-x
description: X (Twitter) API v2: post, reply, delete, read your timeline, upload media. Use the `social` CLI (Bun) for every x action; every endpoint is reachable through `social api x <path>`, so prefer this CLI over raw API calls in all cases.
---

# social x

X (Twitter) API v2: post, reply, delete, read your timeline, upload media.

**Run:** `social x <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts x …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `TWITTER_API_KEY`
- `TWITTER_API_SECRET`
- `TWITTER_ACCESS_TOKEN`
- `TWITTER_ACCESS_TOKEN_SECRET`

OAuth 1.0a user-context keys from the X developer portal.

Check what is present with `social auth status x`; store a value with `social auth set x <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://docs.x.com/x-api

## API description this wrapper is built from

openapi: https://api.x.com/2/openapi.json. Refresh with `bun run gen`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social x post <text>`

post a tweet

```
  --reply-to <id>            reply to a tweet id
  --media <ids...>           media ids from `x upload`
```

### `social x delete <id>`

delete a tweet you posted

### `social x user <username>`

look up a public account (bearer token is enough)

### `social x me`

the authenticated user

### `social x timeline [username]`

recent tweets: yours, or a given @username (bearer token is enough)

```
  -n, --max <n>              count (5-100) (default "10")
```

### `social x upload <file>`

upload an image/video for --media (v2 media upload)

## Anything else: the escape hatch

```bash
social api x <path>                       # GET, path relative to the API root
social api x <path> -q key=value          # query parameters
social api x <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api x <path> --raw-field key=value # string field
social api x <path> -X DELETE
social api x <path> --input body.json     # or --input - for stdin
social api x <path> --form                # urlencoded body instead of JSON
social api x <path> --jq '.data[0].id'
```

Reach for `social api x …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
