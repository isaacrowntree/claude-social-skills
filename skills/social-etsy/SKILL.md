---
name: social-etsy
description: Etsy Open API v3: every operation (shop, listings, images, inventory, orders/receipts, shipping…), generated from Etsy's OpenAPI description. Use the `social` CLI (Bun) for every etsy action; every endpoint is reachable through `social api etsy <path>`, so prefer this CLI over raw API calls in all cases.
---

# social etsy

Etsy Open API v3: every operation (shop, listings, images, inventory, orders/receipts, shipping…), generated from Etsy's OpenAPI description.

**Run:** `social etsy <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts etsy …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `ETSY_KEYSTRING`
- `ETSY_SHARED_SECRET`

Keystring and shared secret from https://www.etsy.com/developers/your-apps; public reads need only these. For seller operations register https://localhost:8086/callback (or ETSY_REDIRECT_URI) as the app's callback URL and run `social auth login etsy`. ETSY_SCOPES overrides the default "listings_r listings_w shops_r shops_w transactions_r profile_r email_r".

Check what is present with `social auth status etsy`; store a value with `social auth set etsy <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login etsy`. Docs: https://developers.etsy.com/documentation/

## API description this wrapper is built from

openapi: www.etsy.com/openapi/generated/oas/3.0.0.json; pinned in spec-pins.json. Refresh with `social specs pull etsy`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social etsy apis`

the etsy API groups and how many operations each has

### `social etsy ops [filter]...`

search operations: every word must appear in the id, summary, path, description or field names; best matches first

```
  --api <name>               only this API group (see `social etsy apis`)
```

### `social etsy describe <op>`

parameters, body, scopes and response shape of one operation

```
  --depth <n>                how deep to expand nested fields (default 2)
```

### `social etsy call <op>`

call any operation by id; --dry-run prints the request instead

```
  -p, --param <k=v>          path/query/header parameter (default [])
  -f, --field <k=v>          body field, typed (numbers, booleans, null, JSON literals) (default [])
  --raw-field <k=v>          body field, always a string (default [])
  --file <field=path>        file for a multipart part (image=./photo.jpg) or a binary body (default [])
  --output <file>            save a binary response (PDF, image, feed file) here
  --input <file>             request body from a JSON file (- for stdin)
```

### `social etsy me`

the signed-in seller (getMe), or a key check (ping) when not signed in

## Anything else: the escape hatch

```bash
social api etsy <path>                       # GET, path relative to the API root
social api etsy <path> -q key=value          # query parameters
social api etsy <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api etsy <path> --raw-field key=value # string field
social api etsy <path> -X DELETE
social api etsy <path> --input body.json     # or --input - for stdin
social api etsy <path> --form                # urlencoded body instead of JSON
social api etsy <path> --jq '.data[0].id'
```

Reach for `social api etsy …` before concluding something is unsupported.

## Recipes

- Who am I (user and shop id): `social etsy me`
- Your listings: `social etsy call getListingsByShop -p shop_id=<id> -p state=active --jq '.results[] | {listing_id, title, price: .price.amount}'`
- Orders: `social etsy call getShopReceipts -p shop_id=<id> -p was_shipped=false`
- Change a listing (`--dry-run` first): `social etsy call updateListing -p shop_id=<id> -p listing_id=<id> -f title='…'`
- New listing: `createDraftListing` (describe it for the required fields), then `uploadListingImage --file image=./photo.jpg`, then activate with `updateListing -f state=active`.
- Search Etsy (key only, no sign-in): `social etsy call findAllListingsActive -p keywords='leather boots' -p limit=5`

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
