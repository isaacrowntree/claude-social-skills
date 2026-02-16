---
name: social-post
description: Post to Twitter/X, Reddit, Facebook, Instagram, or eBay. Use when the user wants to publish social media content, tweet something, post to a subreddit, share on social platforms, or list items for sale on eBay.
---

# Social Post

Post to Twitter/X, Reddit, Instagram, Facebook, or eBay from Claude Code.

## First-time setup

Before first use, install the Python dependencies:

```bash
pip install -r "${CLAUDE_PLUGIN_ROOT}/requirements.txt"
```

Credentials must be set as environment variables. The user needs to create a `.env` file or export them in their shell. Show them which vars are needed for their target platform (see sections below).

## Twitter/X

**Script:** `${CLAUDE_PLUGIN_ROOT}/scripts/tweet.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tweet.py" "Your tweet text here"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tweet.py" "Reply text" --reply-to 1234567890
```

- Max 280 characters
- Requires: `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`
- Get credentials at https://developer.x.com/en/portal/dashboard
- Free tier: ~50 posts/month

## Reddit

**Script:** `${CLAUDE_PLUGIN_ROOT}/scripts/reddit_post.py`

```bash
# Self post
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/reddit_post.py" post <subreddit> "Post title" --text "Post body"

# Link post
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/reddit_post.py" post <subreddit> "Post title" --url "https://example.com"

# Comment on a post (thing_id = t3_xxxxx for posts, t1_xxxxx for comments)
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/reddit_post.py" comment <thing_id> "Comment text"
```

- Requires: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`
- Create a "script" type app at https://www.reddit.com/prefs/apps
- **2FA must be disabled** on the Reddit account — password grant does not support 2FA
- Note: Reddit restricted new API key creation in Nov 2025. Existing keys still work.

## Facebook

**Script:** `${CLAUDE_PLUGIN_ROOT}/scripts/fb_post.py`

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fb_post.py" "Your post message"
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fb_post.py" "Check this out" --link "https://example.com"
```

- Posts to a Facebook Page (personal profile posting not supported by the API)
- Requires: `FB_PAGE_ID`, `FB_ACCESS_TOKEN`
- Get a Page Access Token at https://developers.facebook.com/tools/explorer/
- Rate limit: 200 calls/hour

## Instagram

**Script:** `${CLAUDE_PLUGIN_ROOT}/scripts/ig_post.py`

```bash
# Post an image (must be a publicly accessible JPEG URL)
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ig_post.py" image "https://example.com/photo.jpg" --caption "My caption"

# Post a reel
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ig_post.py" reel "https://example.com/video.mp4" --caption "My reel"
```

- **Business/Creator Instagram accounts only** (must be linked to a Facebook Page)
- Images must be publicly accessible URLs (JPEG)
- Requires: `IG_USER_ID`, `IG_ACCESS_TOKEN`
- Rate limit: 25 posts/day

## eBay

**Script:** `${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py`

### First-time eBay auth

eBay uses OAuth 2.0 with browser-based consent. The user must authenticate once:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" auth
```

This opens a browser, the user logs in to eBay, and the script captures the token automatically via a local callback server on port 8888. Tokens are saved to `~/.ebay_tokens.json` (access token: 2 hours, refresh token: ~18 months, auto-refreshes).

### Creating a listing

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

### Options

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

### Requirements

- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` env vars
- Set up at https://developer.ebay.com
- RuName redirect URL must be set to `http://localhost:8888/callback`
- Set `EBAY_SANDBOX=true` to use sandbox environment for testing
- Free to use, no API fees

### Token refresh

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/ebay_list.py" refresh
```

Tokens auto-refresh when expired, but you can manually refresh if needed.

## Cross-posting

When the user asks to post to multiple platforms, run the scripts sequentially. Adapt the content for each platform:
- Twitter: concise, max 280 chars, hashtags
- Reddit: descriptive title, body text with context
- Facebook: conversational tone, can be longer
- Instagram: needs an image URL, caption with hashtags

## Error handling

If credentials are missing, tell the user which env vars to set and point them to the setup URLs listed above. Always confirm the final text and target platform with the user before posting.
