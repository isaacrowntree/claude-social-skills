---
name: social-pinterest
description: Pinterest API v5: every operation (pins, boards, sections, media, analytics, ads…), generated from Pinterest's OpenAPI description. Use the `social` CLI (Bun) for every pinterest action; every endpoint is reachable through `social api pinterest <path>`, so prefer this CLI over raw API calls in all cases.
---

# social pinterest

Pinterest API v5: every operation (pins, boards, sections, media, analytics, ads…), generated from Pinterest's OpenAPI description.

**Run:** `social pinterest <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts pinterest …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `PINTEREST_CLIENT_ID`
- `PINTEREST_CLIENT_SECRET`

App id and secret from https://developers.pinterest.com/apps/ (a business account is needed). Register https://localhost:8085/callback (or PINTEREST_REDIRECT_URI) as a redirect URI, then `social auth login pinterest`. PINTEREST_SCOPES overrides the default boards:read,boards:write,pins:read,pins:write,user_accounts:read. PINTEREST_SANDBOX=1 sends calls to api-sandbox.pinterest.com, which trial-access apps need for writes.

Check what is present with `social auth status pinterest`; store a value with `social auth set pinterest <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login pinterest`. Docs: https://developers.pinterest.com/docs/api/v5/

## API description this wrapper is built from

openapi: github.com/pinterest/api-description v5/openapi.json; pinned in spec-pins.json. Refresh with `social specs pull pinterest`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social pinterest apis`

the pinterest API groups and how many operations each has

### `social pinterest ops [filter]...`

search operations: every word must appear in the id, summary, path, description or field names; best matches first

```
  --api <name>               only this API group (see `social pinterest apis`)
```

### `social pinterest describe <op>`

parameters, body, scopes and response shape of one operation

```
  --depth <n>                how deep to expand nested fields (default 2)
```

### `social pinterest call <op>`

call any operation by id; --dry-run prints the request instead

```
  -p, --param <k=v>          path/query/header parameter (default [])
  -f, --field <k=v>          body field, typed (numbers, booleans, null, JSON literals) (default [])
  --raw-field <k=v>          body field, always a string (default [])
  --file <field=path>        file for a multipart part (image=./photo.jpg) or a binary body (default [])
  --output <file>            save a binary response (PDF, image, feed file) here
  --input <file>             request body from a JSON file (- for stdin)
```

### `social pinterest me`

the signed-in account (user_account/get)

## Anything else: the escape hatch

```bash
social api pinterest <path>                       # GET, path relative to the API root
social api pinterest <path> -q key=value          # query parameters
social api pinterest <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api pinterest <path> --raw-field key=value # string field
social api pinterest <path> -X DELETE
social api pinterest <path> --input body.json     # or --input - for stdin
social api pinterest <path> --form                # urlencoded body instead of JSON
social api pinterest <path> --jq '.data[0].id'
```

Reach for `social api pinterest …` before concluding something is unsupported.

## Recipes

- Who am I: `social pinterest me`
- Boards: `social pinterest call boards/list --jq '.items[] | {id, name}'`
- Create a pin from an image URL (`--dry-run` first):
  ```bash
  social pinterest call pins/create --input pin.json
  # pin.json: {"board_id": "<id>", "title": "…", "description": "…", "link": "https://…",
  #            "media_source": {"source_type": "image_url", "url": "https://…/photo.jpg"}}
  ```
- Your pins: `social pinterest call pins/list --jq '.items[] | {id, title, link}'`
- Video pins: register the upload with `media/create`, upload to the URL it returns, then create the pin with `source_type: video_id`.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
