---
name: social-threads
description: Threads API: post text or an image, read your posts and profile. Use the `social` CLI (Bun) for every threads action; every endpoint is reachable through `social api threads <path>`, so prefer this CLI over raw API calls in all cases.
---

# social threads

Threads API: post text or an image, read your posts and profile.

**Run:** `social threads <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts threads …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `THREADS_USER_ID`
- `THREADS_ACCESS_TOKEN`

Create an app with the Threads API use case, add yourself as a Threads Tester (accept in Threads > Settings > Account > Website permissions), authorise at https://threads.net/oauth/authorize?client_id=…&redirect_uri=…&scope=threads_basic,threads_content_publish&response_type=code, exchange the code (POST graph.threads.net/oauth/access_token; the reply carries user_id), then make it long-lived: GET graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=…&access_token=… (60 days; refresh with /refresh_access_token?grant_type=th_refresh_token). https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions

Check what is present with `social auth status threads`; store a value with `social auth set threads <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://developers.facebook.com/docs/threads

## API description this wrapper is built from

No machine-readable spec: none.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social threads post <text>`

post to Threads (500 chars), optionally with a public image URL

```
  --image <url>              attach an image (JPEG/PNG, 8 MB max)
```

### `social threads posts`

your recent threads

```
  -n, --max <n>              count (default "10")
```

### `social threads me`

the Threads profile this token belongs to

## Anything else: the escape hatch

```bash
social api threads <path>                       # GET, path relative to the API root
social api threads <path> -q key=value          # query parameters
social api threads <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api threads <path> --raw-field key=value # string field
social api threads <path> -X DELETE
social api threads <path> --input body.json     # or --input - for stdin
social api threads <path> --form                # urlencoded body instead of JSON
social api threads <path> --jq '.data[0].id'
```

Reach for `social api threads …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
