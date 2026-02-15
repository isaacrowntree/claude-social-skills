#!/usr/bin/env python3
"""Post to a Facebook Page via Graph API."""
import argparse
import json
import os
import sys

import requests

GRAPH_API = "https://graph.facebook.com/v22.0"


def post_to_page(message: str, link: str = "") -> dict:
    required = ["FB_PAGE_ID", "FB_ACCESS_TOKEN"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    page_id = os.environ["FB_PAGE_ID"]
    token = os.environ["FB_ACCESS_TOKEN"]

    data = {"message": message, "access_token": token}
    if link:
        data["link"] = link

    resp = requests.post(f"{GRAPH_API}/{page_id}/feed", data=data)

    if resp.status_code == 200:
        result = resp.json()
        post_id = result.get("id", "")
        print(json.dumps(result, indent=2))
        if post_id:
            print(f"\nhttps://facebook.com/{post_id}")
        return result
    else:
        print(f"Error {resp.status_code}: {resp.text}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Post to Facebook Page")
    parser.add_argument("message", help="Post message text")
    parser.add_argument("--link", default="", help="Optional link to attach")
    args = parser.parse_args()

    post_to_page(args.message, link=args.link)


if __name__ == "__main__":
    main()
