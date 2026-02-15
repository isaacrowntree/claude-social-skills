---
name: social-post
description: Post to Twitter/X, Reddit, Facebook, or Instagram. Use when the user wants to publish social media content, tweet something, post to a subreddit, or share on social platforms.
---

# Social Post

Post to Twitter/X, Reddit, Instagram, or Facebook from Claude Code.

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

## Cross-posting

When the user asks to post to multiple platforms, run the scripts sequentially. Adapt the content for each platform:
- Twitter: concise, max 280 chars, hashtags
- Reddit: descriptive title, body text with context
- Facebook: conversational tone, can be longer
- Instagram: needs an image URL, caption with hashtags

## Error handling

If credentials are missing, tell the user which env vars to set and point them to the setup URLs listed above. Always confirm the final text and target platform with the user before posting.
