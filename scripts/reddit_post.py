#!/usr/bin/env python3
"""Post or comment on Reddit via OAuth2 password grant."""
import argparse
import json
import os
import sys

import requests

USER_AGENT = "claude-social-skills/1.0"


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip())


def get_token() -> str:
    resp = requests.post(
        "https://www.reddit.com/api/v1/access_token",
        auth=(os.environ["REDDIT_CLIENT_ID"], os.environ["REDDIT_CLIENT_SECRET"]),
        data={
            "grant_type": "password",
            "username": os.environ["REDDIT_USERNAME"],
            "password": os.environ["REDDIT_PASSWORD"],
        },
        headers={"User-Agent": USER_AGENT},
    )
    resp.raise_for_status()
    data = resp.json()
    if "access_token" not in data:
        print(f"Auth failed: {json.dumps(data)}", file=sys.stderr)
        sys.exit(1)
    return data["access_token"]


def submit_post(subreddit: str, title: str, text: str = "", url: str = "") -> dict:
    load_env()

    required = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}

    data = {"sr": subreddit, "title": title, "resubmit": True}
    if url:
        data["kind"] = "link"
        data["url"] = url
    else:
        data["kind"] = "self"
        data["text"] = text

    resp = requests.post(
        "https://oauth.reddit.com/api/submit",
        headers=headers,
        data=data,
    )
    resp.raise_for_status()
    result = resp.json()

    if result.get("success") or (result.get("json", {}).get("data", {}).get("url")):
        post_url = result.get("json", {}).get("data", {}).get("url", "")
        print(json.dumps(result, indent=2))
        if post_url:
            print(f"\n{post_url}")
        return result
    else:
        errors = result.get("json", {}).get("errors", [])
        print(f"Error: {errors or result}", file=sys.stderr)
        sys.exit(1)


def submit_comment(thing_id: str, text: str) -> dict:
    """Comment on a post or reply to a comment. thing_id is t3_xxx (post) or t1_xxx (comment)."""
    load_env()

    required = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}

    resp = requests.post(
        "https://oauth.reddit.com/api/comment",
        headers=headers,
        data={"thing_id": thing_id, "text": text},
    )
    resp.raise_for_status()
    result = resp.json()
    print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="Post to Reddit")
    sub = parser.add_subparsers(dest="command", required=True)

    post_p = sub.add_parser("post", help="Submit a new post")
    post_p.add_argument("subreddit", help="Subreddit name (without r/)")
    post_p.add_argument("title", help="Post title")
    post_p.add_argument("--text", default="", help="Post body (for self posts)")
    post_p.add_argument("--url", default="", help="URL (for link posts)")

    comment_p = sub.add_parser("comment", help="Comment on a post")
    comment_p.add_argument("thing_id", help="Post/comment fullname (t3_xxx or t1_xxx)")
    comment_p.add_argument("text", help="Comment text")

    args = parser.parse_args()

    if args.command == "post":
        submit_post(args.subreddit, args.title, text=args.text, url=args.url)
    elif args.command == "comment":
        submit_comment(args.thing_id, args.text)


if __name__ == "__main__":
    main()
