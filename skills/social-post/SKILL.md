# Social Post

Post to Twitter/X, Reddit, Instagram, or Facebook from Claude Code.

## Triggers

social media, tweet, post to twitter, post to reddit, reddit post, post to instagram, post to facebook, share on social, social post

## Instructions

You help the user compose and publish social media posts. Always confirm the final text and target platform with the user before posting.

### Setup

Scripts live in this skill's repo. Find the repo root:

```bash
SKILL_DIR="$(dirname "$(readlink -f ~/.claude/skills/social-post/SKILL.md)")"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
```

Credentials are loaded from `$REPO_ROOT/.env` automatically by each script.

### Twitter/X

**Script:** `$REPO_ROOT/scripts/tweet.py`

```bash
python3 "$REPO_ROOT/scripts/tweet.py" "Your tweet text here"
python3 "$REPO_ROOT/scripts/tweet.py" "Reply text" --reply-to 1234567890
```

- Max 280 characters
- Requires: `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`
- Get credentials at https://developer.x.com/en/portal/dashboard
- Free tier: ~50 posts/month

### Reddit

**Script:** `$REPO_ROOT/scripts/reddit_post.py`

```bash
# Self post
python3 "$REPO_ROOT/scripts/reddit_post.py" post <subreddit> "Post title" --text "Post body"

# Link post
python3 "$REPO_ROOT/scripts/reddit_post.py" post <subreddit> "Post title" --url "https://example.com"

# Comment on a post (thing_id = t3_xxxxx for posts, t1_xxxxx for comments)
python3 "$REPO_ROOT/scripts/reddit_post.py" comment <thing_id> "Comment text"
```

- Requires: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`
- Create a "script" type app at https://www.reddit.com/prefs/apps
- Note: Reddit restricted new API key creation in Nov 2025. Existing keys still work.

### Facebook

**Script:** `$REPO_ROOT/scripts/fb_post.py`

```bash
python3 "$REPO_ROOT/scripts/fb_post.py" "Your post message"
python3 "$REPO_ROOT/scripts/fb_post.py" "Check this out" --link "https://example.com"
```

- Posts to a Facebook Page (personal profile posting is not supported by the API)
- Requires: `FB_PAGE_ID`, `FB_ACCESS_TOKEN`
- Get a Page Access Token at https://developers.facebook.com/tools/explorer/
- Rate limit: 200 calls/hour

### Instagram

**Script:** `$REPO_ROOT/scripts/ig_post.py`

```bash
# Post an image (must be a publicly accessible JPEG URL)
python3 "$REPO_ROOT/scripts/ig_post.py" image "https://example.com/photo.jpg" --caption "My caption"

# Post a reel
python3 "$REPO_ROOT/scripts/ig_post.py" reel "https://example.com/video.mp4" --caption "My reel"
```

- **Business/Creator Instagram accounts only** (must be linked to a Facebook Page)
- Images must be publicly accessible URLs (JPEG)
- Requires: `IG_USER_ID`, `IG_ACCESS_TOKEN`
- Rate limit: 25 posts/day

### Cross-posting

When the user asks to post to multiple platforms, run the scripts sequentially. Adapt the content for each platform:
- Twitter: concise, max 280 chars, hashtags
- Reddit: descriptive title, body text with context
- Facebook: conversational tone, can be longer
- Instagram: needs an image URL, caption with hashtags

### Error Handling

If credentials are missing, tell the user which env vars to set in `$REPO_ROOT/.env` and point them to the setup URLs listed above. Do not attempt to post without valid credentials.
