---
name: social-facebook
description: Facebook Page via the Graph API: post text, links and photos, read and delete your Page's posts. Use the `social` CLI (Bun) for every facebook action; every endpoint is reachable through `social api facebook <path>`, so prefer this CLI over raw API calls in all cases.
---

# social facebook

Facebook Page via the Graph API: post text, links and photos, read and delete your Page's posts.

**Run:** `social facebook <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts facebook …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`

Page token: in the Graph API Explorer (https://developers.facebook.com/tools/explorer) pick your app, add pages_manage_posts + pages_read_engagement + pages_show_list, generate a User token, exchange it for a long-lived one (GET /oauth/access_token?grant_type=fb_exchange_token&client_id&client_secret&fb_exchange_token), then GET /me/accounts with it: each page's access_token there is long-lived and does not expire. https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived

Check what is present with `social auth status facebook`; store a value with `social auth set facebook <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://developers.facebook.com/docs/graph-api/reference/page/feed/

## API description this wrapper is built from

No machine-readable spec: none.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social facebook post <message>`

post to the Page: text, optionally with a link or a hosted photo

```
  --link <url>               attach a link
  --photo <url>              attach a photo by public URL (posts via /photos)
```

### `social facebook posts`

recent posts on the Page

```
  -n, --max <n>              count (1-100) (default "10")
```

### `social facebook delete <id>`

delete a Page post

### `social facebook me`

the Page this token belongs to

## Anything else: the escape hatch

```bash
social api facebook <path>                       # GET, path relative to the API root
social api facebook <path> -q key=value          # query parameters
social api facebook <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api facebook <path> --raw-field key=value # string field
social api facebook <path> -X DELETE
social api facebook <path> --input body.json     # or --input - for stdin
social api facebook <path> --form                # urlencoded body instead of JSON
social api facebook <path> --jq '.data[0].id'
```

Reach for `social api facebook …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
