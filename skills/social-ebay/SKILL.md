---
name: social-ebay
description: eBay: list, revise, messages, offers, categories (Trading, Auth'n'Auth) and any Sell REST API (OAuth). Use the `social` CLI (Bun) for every ebay action; every endpoint is reachable through `social api ebay <path>`, so prefer this CLI over raw API calls in all cases.
---

# social ebay

eBay: list, revise, messages, offers, categories (Trading, Auth'n'Auth) and any Sell REST API (OAuth).

**Run:** `social ebay <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts ebay …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `EBAY_AUTH_TOKEN`

Auth'n'Auth user token for the Trading API (listing, messages, offers). EBAY_CLIENT_ID + EBAY_CLIENT_SECRET add category/specifics lookups (app-only token, no sign-in). Add EBAY_RUNAME and run `social auth login ebay` only for the user-scoped Sell REST APIs. EBAY_MARKETPLACE (default EBAY_AU), EBAY_SANDBOX=1 optional.

Check what is present with `social auth status ebay`; store a value with `social auth set ebay <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login ebay`. Docs: https://developer.ebay.com/develop/apis

## API description this wrapper is built from

openapi: https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json (vendored: the host blocks non-browser fetches). Refresh with `bun run gen`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social ebay api <callName>`

call any Trading API operation with the XML body (Auth'n'Auth)

```
  --body <xml>               XML body inside the <CallName>Request element (default "")
  --input <file>             read the XML body from a file or - for stdin
  --site <id>                eBay site id (default from EBAY_MARKETPLACE)
```

### `social ebay me`

the authenticated seller (GetUser)

### `social ebay selling`

your active listings (GetMyeBaySelling)

```
  -n, --max <n>              per page (default "50")
```

### `social ebay item <itemId>`

one listing in full (GetItem)

### `social ebay messages`

recent buyer messages (GetMyMessages)

```
  --days <n>                 look back (default "7")
```

### `social ebay offers`

pending Best Offers on your listings (GetBestOffers)

```
  --item <id>                only this item
```

### `social ebay respond <itemId> <offerId> <action>`

accept | decline | counter a Best Offer

```
  --counter <price>          
  --message <text>           
```

### `social ebay categories <query>`

suggest leaf categories for a listing title (Taxonomy getCategorySuggestions)

### `social ebay specifics <categoryId>`

required and recommended item specifics for a category (Taxonomy getItemAspectsForCategory)

### `social ebay list`

create a listing from a JSON file (see `social ebay list --example`); local image paths are uploaded to eBay

```
  --input <file>             listing JSON, or - for stdin
  --verify                   VerifyAddFixedPriceItem only; nothing is created
  --example                  print an example listing JSON
```

### `social ebay revise <itemId>`

change price and/or quantity on a live listing (ReviseFixedPriceItem)

```
  --price <n>                
  --quantity <n>             
  --title <t>                
```

### `social ebay upload <files>...`

upload local images to eBay's picture host; prints URLs for listing JSON

## Anything else: the escape hatch

```bash
social api ebay <path>                       # GET, path relative to the API root
social api ebay <path> -q key=value          # query parameters
social api ebay <path> -f key=value          # JSON body field (typed: numbers, booleans, null, JSON literals); implies POST
social api ebay <path> --raw-field key=value # string field
social api ebay <path> -X DELETE
social api ebay <path> --input body.json     # or --input - for stdin
social api ebay <path> --form                # urlencoded body instead of JSON
social api ebay <path> --jq '.data[0].id'
```

Reach for `social api ebay …` before concluding something is unsupported.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
