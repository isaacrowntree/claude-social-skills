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

## First-time eBay auth

eBay uses OAuth 2.0 with browser-based consent. The user must authenticate once:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" auth
```

This opens a browser, the user logs in to eBay, and the script captures the token automatically via a local callback server on port 8888. Tokens are saved to `~/.ebay_tokens.json` (access token: 2 hours, refresh token: ~18 months, auto-refreshes).

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

Saves processed images alongside originals with `_clean` suffix. Requires `Pillow`.

## Requirements

- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` env vars
- Set up at https://developer.ebay.com
- RuName redirect URL must be set to `http://localhost:8888/callback`
- Set `EBAY_SANDBOX=true` to use sandbox environment for testing
- Free to use, no API fees

## Token refresh

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" refresh
```

Tokens auto-refresh when expired, but you can manually refresh if needed.

## Error handling

If credentials are missing, tell the user which env vars to set and point them to the setup URL above. Always confirm the listing details with the user before publishing.
