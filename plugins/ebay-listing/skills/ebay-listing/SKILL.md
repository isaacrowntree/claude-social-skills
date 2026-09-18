---
name: ebay-listing
description: List items for sale on eBay. Use when the user wants to create eBay listings, sell items, or manage eBay inventory.
---

# eBay Listing

List items for sale on eBay from Claude Code.

## First-time setup

Before first use, install the Python dependencies:

```bash
pip install -r "${CLAUDE_PLUGIN_ROOT}/requirements.txt"
```

Credentials must be set as environment variables. The user needs to create a `.env` file or export them in their shell (see Requirements below).

## Authentication

The script supports two auth methods and auto-detects based on which env vars are set:

### Auth'n'Auth (recommended)

Simpler for personal use. Get a token from the eBay Developer Portal:
User Tokens tab > Auth'n'Auth > Sign in to Production.

- Requires: `EBAY_AUTH_TOKEN` env var
- Token lasts ~18 months
- Uses the Trading API (XML)

### OAuth 2.0 (required for the Sell REST APIs)

Not an alternative — a second credential you need alongside Auth'n'Auth. Trading
(XML) cannot reach the Sell REST APIs, so anything under `/sell/...` needs this:

| Want to do | API | Auth |
|---|---|---|
| Create / revise / end listings | Trading | Auth'n'Auth |
| Messages, Best Offers | Trading | Auth'n'Auth |
| **Promoted Listings** | Marketing (REST) | **OAuth** |
| **Send offer to watchers** | Negotiation (REST) | **OAuth** |
| Sales/traffic analytics | Analytics (REST) | OAuth |

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" auth
```

- Requires: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` env vars
- RuName "auth accepted URL" must be `https://localhost:8888/callback` —
  **https, not http**. The callback server runs TLS with a self-signed cert;
  eBay rejects plain http. The browser will warn about the cert — proceed anyway.
- Refresh token lasts ~18 months; access tokens auto-refresh.
- `EBAY_AUTH_MODE=oauth|authnauth` forces a mode if auto-detection picks wrong.

## Calling the API directly (preferred)

**Do not add a new typed wrapper function for a new eBay field or endpoint.**
Use the passthroughs — they cover every endpoint with no code change:

```bash
# Trading API (XML). --body is the inner XML of the request element.
ebay_list.py api ReviseFixedPriceItem --body \
  '<Item><ItemID>287421661539</ItemID><StartPrice currencyID="AUD">525.00</StartPrice></Item>'

ebay_list.py api GetItem --body '<ItemID>287421661539</ItemID>' --raw

# Sell REST APIs (OAuth). Path is everything after https://api.ebay.com
ebay_list.py rest GET /sell/marketing/v1/ad_campaign
ebay_list.py rest POST /sell/negotiation/v1/send_offer_to_interested_buyers \
  --data '{"offeredItems":[{"itemId":"287421661539","discountPercentage":"12"}]}'
```

Flags: `api` takes `--site` (15 = AU, 0 = US) and `--raw` (full XML response);
`rest` takes `--marketplace` (default `EBAY_AU`) and `--data` (JSON body).

The typed helpers (`trading_add_fixed_price_item`, `revise_fixed_price_item`,
`get_best_offers`, ...) predate the passthrough and still back the `list` /
`verify` / `offers` commands. Leave them alone; build new things on `api`/`rest`.

### Common Trading calls

| Call | Inner XML |
|---|---|
| `ReviseFixedPriceItem` | `<Item><ItemID>…</ItemID><StartPrice currencyID="AUD">…</StartPrice><Title>…</Title></Item>` |
| `GetItem` | `<ItemID>…</ItemID><DetailLevel>ReturnAll</DetailLevel>` |
| `GetMyeBaySelling` | `<ActiveList><Include>true</Include></ActiveList>` |
| `EndFixedPriceItem` | `<ItemID>…</ItemID><EndingReason>NotAvailable</EndingReason>` |
| `AddFixedPriceItem` | full `<Item>` — easier via the `list` command |

Titles are max 80 chars. Price changes take effect immediately and are visible
to watchers, so confirm with the user before sending any revision.

## Creating a listing

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" list \
  --title "GoPro Hero 12 Black" \
  --description "Brand new, sealed in box. Includes all accessories." \
  --price 299.99 \
  --condition NEW \
  --image "https://example.com/photo1.jpg" \
  --image "https://example.com/photo2.jpg" \
  --category 31388 \
  --marketplace US \
  --currency USD
```

## Options

- `--title` (required): Item title, max 80 chars
- `--description` (required): Item description, max 4000 chars
- `--price` (required): Listing price
- `--condition` (required): One of: NEW, LIKE_NEW, NEW_OTHER, NEW_WITH_DEFECTS, CERTIFIED_REFURBISHED, SELLER_REFURBISHED, USED_EXCELLENT, USED_VERY_GOOD, USED_GOOD, USED_ACCEPTABLE, FOR_PARTS_OR_NOT_WORKING
- `--image` (required, repeatable): HTTPS image URLs, at least one
- `--category`: eBay category ID (look up at https://pages.ebay.com/sellerinformation/news/categorychanges.html)
- `--marketplace`: US (default), UK, AU, CA, DE, FR, IT, ES
- `--currency`: USD (default), GBP, AUD, CAD, EUR
- `--quantity`: Number available (default: 1)
- `--sku`: Custom SKU (auto-generated if omitted)
- `--brand`: Brand name
- `--format`: FIXED_PRICE (default) or AUCTION
- `--draft`: Create the offer without publishing (for review first)

## Photo cleanup

Clean up product photos before listing (auto white balance, contrast, brightness, sharpening):

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/photo_cleanup.py" <directory|file> [...]
```

Saves processed images alongside originals with a `_clean.jpg` suffix. Accepts
JPEG, PNG, and **HEIC/HEIF** input (iPhone-native format); output is always
JPEG because eBay's upload API rejects HEIC. Requires `Pillow` and `pillow-heif`.

## Tethered phone workflow (Shutterdrop)

If the user is using **Shutterdrop** (https://github.com/isaacrowntree/shutterdrop),
phone captures drop into `~/Pictures/Shutterdrop/` as HEIC (iOS) or JPEG (Android).
Recommended flow:

```bash
# 1. Clean + convert the new captures to JPEG
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/photo_cleanup.py" ~/Pictures/Shutterdrop/

# 2. List using the _clean.jpg outputs (pass one --image per photo)
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" list \
  --title "…" --price … --condition … \
  --image ~/Pictures/Shutterdrop/1745...heic_clean.jpg \
  --image ~/Pictures/Shutterdrop/1745...heic_clean.jpg
```

`ebay_list.py` auto-uploads local files via `UploadSiteHostedPictures` when
Auth'n'Auth is set (see `resolve_images`), so you don't need to host the
images yourself. After a successful listing, move the used files out of
`~/Pictures/Shutterdrop/` so the next shoot starts clean.

## Requirements

- Set up at https://developer.ebay.com (free, no API fees)
- `EBAY_AUTH_TOKEN` (Auth'n'Auth) for Trading, **and** `EBAY_CLIENT_ID` +
  `EBAY_CLIENT_SECRET` + `EBAY_RUNAME` (OAuth) for the Sell REST APIs
- Set `EBAY_SANDBOX=true` to use sandbox environment for testing
- `ebay_list.py` does NOT auto-load `.env` — source it first:
  `set -a; source plugins/ebay-listing/.env; set +a`

## Error handling

If credentials are missing, tell the user which env vars to set and point them to the setup URL above. Always confirm the listing details with the user before publishing.
