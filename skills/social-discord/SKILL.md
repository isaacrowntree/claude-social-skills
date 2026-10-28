---
name: social-discord
description: Discord: every HTTP API operation (messages, channels, servers, threads, webhooks, members…) as a bot, generated from Discord's OpenAPI description. Use the `social` CLI (Bun) for every discord action; every endpoint is reachable through `social api discord <path>`, so prefer this CLI over raw API calls in all cases.
---

# social discord

Discord: every HTTP API operation (messages, channels, servers, threads, webhooks, members…) as a bot, generated from Discord's OpenAPI description.

**Run:** `social discord <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts discord …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `DISCORD_BOT_TOKEN`

A bot token from https://discord.com/developers/applications (your app → Bot → Reset Token). Invite the bot to a server with OAuth2 → URL Generator (scope `bot`) before it can read or post there.

Check what is present with `social auth status discord`; store a value with `social auth set discord <KEY> <value>` (OS keyring, else `~/.config/social/.env`). Docs: https://discord.com/developers/docs/reference

## API description this wrapper is built from

openapi: github.com/discord/discord-api-spec specs/openapi.json; pinned in spec-pins.json. Refresh with `social specs pull discord`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social discord apis`

the discord API groups and how many operations each has

### `social discord ops [filter]...`

search operations: every word must appear in the id, summary, path, description or field names; best matches first

```
  --api <name>               only this API group (see `social discord apis`)
```

### `social discord describe <op>`

parameters, body, scopes and response shape of one operation

```
  --depth <n>                how deep to expand nested fields (default 2)
```

### `social discord call <op>`

call any operation by id; --dry-run prints the request instead

```
  -p, --param <k=v>          path/query/header parameter (default [])
  -f, --field <k=v>          body field, typed (numbers, booleans, null, JSON literals) (default [])
  --raw-field <k=v>          body field, always a string (default [])
  --file <field=path>        file for a multipart part (image=./photo.jpg) or a binary body (default [])
  --output <file>            save a binary response (PDF, image, feed file) here
  --input <file>             request body from a JSON file (- for stdin)
```

### `social discord me`

the bot user (get_my_user)

## Anything else: the escape hatch

```bash
social api discord <path>                       # GET, path relative to the API root
social api discord <path> -q key=value          # query parameters
social api discord <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api discord <path> --raw-field key=value # string field
social api discord <path> -X DELETE
social api discord <path> --input body.json     # or --input - for stdin
social api discord <path> --form                # urlencoded body instead of JSON
social api discord <path> --jq '.data[0].id'
```

Reach for `social api discord …` before concluding something is unsupported.

## Recipes

- Who is the bot: `social discord me`
- Servers the bot is in: `social discord call list_my_guilds --jq '.[] | {id, name}'`
- Channels in a server: `social discord call list_guild_channels -p guild_id=<id> --jq '.[] | {id, name, type}'`
- Post a message: `social discord call create_message -p channel_id=<id> -f content='hello'` (add `--dry-run` first to see the request)
- Read recent messages: `social discord call list_messages -p channel_id=<id> -p limit=20 --jq '.[] | {author: .author.username, content}'` (needs the Message Content intent for other people's text)

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
