#!/usr/bin/env python3
"""List items on eBay via the Inventory API (OAuth 2.0 authorization code grant).

Setup:
  1. Create account at https://developer.ebay.com
  2. Create an application to get client_id and client_secret
  3. Create a RuName (redirect URL) pointing to http://localhost:8888/callback
  4. Export EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME
  5. Run: python3 ebay_list.py auth   (opens browser, saves tokens)
  6. Run: python3 ebay_list.py list ... (creates a listing)

Listing flow:
  PUT  /sell/inventory/v1/inventory_item/{sku}     — create inventory item
  POST /sell/inventory/v1/offer                     — create offer
  POST /sell/inventory/v1/offer/{offerId}/publish   — publish to eBay
"""
import argparse
import base64
import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser

import requests

PRODUCTION_API = "https://api.ebay.com"
SANDBOX_API = "https://api.sandbox.ebay.com"
PRODUCTION_AUTH = "https://auth.ebay.com"
SANDBOX_AUTH = "https://auth.sandbox.ebay.com"

TOKEN_FILE = os.path.expanduser("~/.ebay_tokens.json")

SELL_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inventory"

# Common eBay marketplace IDs
MARKETPLACES = {
    "US": "EBAY_US",
    "UK": "EBAY_GB",
    "AU": "EBAY_AU",
    "CA": "EBAY_CA",
    "DE": "EBAY_DE",
    "FR": "EBAY_FR",
    "IT": "EBAY_IT",
    "ES": "EBAY_ES",
}

# Common condition values
CONDITIONS = [
    "NEW",
    "LIKE_NEW",
    "NEW_OTHER",
    "NEW_WITH_DEFECTS",
    "CERTIFIED_REFURBISHED",
    "SELLER_REFURBISHED",
    "USED_EXCELLENT",
    "USED_VERY_GOOD",
    "USED_GOOD",
    "USED_ACCEPTABLE",
    "FOR_PARTS_OR_NOT_WORKING",
]


def get_env():
    required = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("Set up at https://developer.ebay.com", file=sys.stderr)
        sys.exit(1)
    return {
        "client_id": os.environ["EBAY_CLIENT_ID"],
        "client_secret": os.environ["EBAY_CLIENT_SECRET"],
        "runame": os.environ["EBAY_RUNAME"],
        "sandbox": os.environ.get("EBAY_SANDBOX", "").lower() in ("1", "true", "yes"),
    }


def api_base(sandbox: bool) -> str:
    return SANDBOX_API if sandbox else PRODUCTION_API


def auth_base(sandbox: bool) -> str:
    return SANDBOX_AUTH if sandbox else PRODUCTION_AUTH


def basic_auth_header(client_id: str, client_secret: str) -> str:
    creds = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return f"Basic {creds}"


# --- Token management ---


def save_tokens(data: dict):
    data["saved_at"] = time.time()
    with open(TOKEN_FILE, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(TOKEN_FILE, 0o600)
    print(f"Tokens saved to {TOKEN_FILE}")


def load_tokens() -> dict:
    if not os.path.exists(TOKEN_FILE):
        print(f"No tokens found. Run 'ebay_list.py auth' first.", file=sys.stderr)
        sys.exit(1)
    with open(TOKEN_FILE) as f:
        return json.load(f)


def get_access_token() -> str:
    """Load tokens, refresh if expired, return access token."""
    tokens = load_tokens()
    saved_at = tokens.get("saved_at", 0)
    expires_in = tokens.get("expires_in", 7200)

    if time.time() - saved_at > expires_in - 300:
        print("Access token expired, refreshing...")
        tokens = refresh_token(tokens)

    return tokens["access_token"]


def refresh_token(tokens: dict) -> dict:
    env = get_env()
    resp = requests.post(
        f"{api_base(env['sandbox'])}/identity/v1/oauth2/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": basic_auth_header(env["client_id"], env["client_secret"]),
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
            "scope": SELL_SCOPE,
        },
    )
    if resp.status_code != 200:
        print(f"Token refresh failed: {resp.status_code} {resp.text}", file=sys.stderr)
        print("Run 'ebay_list.py auth' to re-authenticate.", file=sys.stderr)
        sys.exit(1)

    new_tokens = resp.json()
    # Preserve refresh token if not returned in response
    if "refresh_token" not in new_tokens:
        new_tokens["refresh_token"] = tokens["refresh_token"]
        new_tokens["refresh_token_expires_in"] = tokens.get("refresh_token_expires_in")
    save_tokens(new_tokens)
    return new_tokens


# --- OAuth authorization flow ---


def do_auth():
    """Interactive OAuth flow: opens browser, captures authorization code via local server."""
    env = get_env()
    sandbox = env["sandbox"]
    auth_code_holder = {"code": None}

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            if "code" in params:
                auth_code_holder["code"] = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Authorization successful!</h1><p>You can close this tab.</p>")
            else:
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                error = params.get("error", ["unknown"])[0]
                self.wfile.write(f"<h1>Authorization failed: {error}</h1>".encode())

        def log_message(self, format, *args):
            pass  # Suppress server logs

    server = http.server.HTTPServer(("localhost", 8888), CallbackHandler)
    server_thread = threading.Thread(target=server.handle_request, daemon=True)
    server_thread.start()

    authorize_url = (
        f"{auth_base(sandbox)}/oauth2/authorize?"
        f"client_id={env['client_id']}"
        f"&redirect_uri={env['runame']}"
        f"&response_type=code"
        f"&scope={urllib.parse.quote(SELL_SCOPE)}"
    )

    print(f"Opening browser for eBay authorization...")
    print(f"If browser doesn't open, visit:\n{authorize_url}\n")
    webbrowser.open(authorize_url)

    server_thread.join(timeout=120)
    server.server_close()

    if not auth_code_holder["code"]:
        print("Authorization timed out or failed.", file=sys.stderr)
        sys.exit(1)

    # Exchange code for tokens
    resp = requests.post(
        f"{api_base(sandbox)}/identity/v1/oauth2/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": basic_auth_header(env["client_id"], env["client_secret"]),
        },
        data={
            "grant_type": "authorization_code",
            "code": auth_code_holder["code"],
            "redirect_uri": env["runame"],
        },
    )

    if resp.status_code != 200:
        print(f"Token exchange failed: {resp.status_code} {resp.text}", file=sys.stderr)
        sys.exit(1)

    tokens = resp.json()
    save_tokens(tokens)
    print("Authentication successful!")
    print(f"  Access token expires in: {tokens.get('expires_in', '?')} seconds")
    print(f"  Refresh token expires in: {tokens.get('refresh_token_expires_in', '?')} seconds (~18 months)")


# --- Inventory API ---


def create_inventory_item(
    sku: str,
    title: str,
    description: str,
    condition: str,
    image_urls: list[str],
    quantity: int = 1,
    aspects: dict | None = None,
    brand: str = "",
    sandbox: bool = False,
) -> dict:
    token = get_access_token()
    url = f"{api_base(sandbox)}/sell/inventory/v1/inventory_item/{urllib.parse.quote(sku)}"

    product = {
        "title": title,
        "description": description,
        "imageUrls": image_urls,
    }
    if aspects:
        product["aspects"] = aspects
    if brand:
        product["brand"] = brand

    body = {
        "availability": {"shipToLocationAvailability": {"quantity": quantity}},
        "condition": condition,
        "product": product,
    }

    resp = requests.put(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Content-Language": "en-US",
        },
        json=body,
    )

    if resp.status_code in (200, 201, 204):
        print(f"Inventory item created/updated: {sku}")
        return resp.json() if resp.content else {}
    else:
        print(f"Failed to create inventory item: {resp.status_code}", file=sys.stderr)
        print(resp.text, file=sys.stderr)
        sys.exit(1)


def create_offer(
    sku: str,
    marketplace: str,
    price: float,
    currency: str = "USD",
    category_id: str = "",
    listing_format: str = "FIXED_PRICE",
    sandbox: bool = False,
) -> str:
    token = get_access_token()
    url = f"{api_base(sandbox)}/sell/inventory/v1/offer"

    body = {
        "sku": sku,
        "marketplaceId": marketplace,
        "format": listing_format,
        "pricingSummary": {
            "price": {"value": str(price), "currency": currency},
        },
        "listingDuration": "GTC",  # Good 'Til Cancelled
    }
    if category_id:
        body["categoryId"] = category_id

    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Content-Language": "en-US",
        },
        json=body,
    )

    if resp.status_code in (200, 201):
        offer_id = resp.json().get("offerId", "")
        print(f"Offer created: {offer_id}")
        return offer_id
    else:
        print(f"Failed to create offer: {resp.status_code}", file=sys.stderr)
        print(resp.text, file=sys.stderr)
        sys.exit(1)


def publish_offer(offer_id: str, sandbox: bool = False) -> str:
    token = get_access_token()
    url = f"{api_base(sandbox)}/sell/inventory/v1/offer/{offer_id}/publish"

    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )

    if resp.status_code == 200:
        listing_id = resp.json().get("listingId", "")
        print(f"Published! Listing ID: {listing_id}")
        print(f"https://www.ebay.com/itm/{listing_id}")
        return listing_id
    else:
        print(f"Failed to publish: {resp.status_code}", file=sys.stderr)
        print(resp.text, file=sys.stderr)
        sys.exit(1)


# --- CLI ---


def main():
    parser = argparse.ArgumentParser(
        description="List items on eBay via Inventory API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
conditions: NEW, LIKE_NEW, NEW_OTHER, USED_EXCELLENT, USED_VERY_GOOD,
  USED_GOOD, USED_ACCEPTABLE, CERTIFIED_REFURBISHED, SELLER_REFURBISHED,
  FOR_PARTS_OR_NOT_WORKING

marketplaces: US, UK, AU, CA, DE, FR, IT, ES

examples:
  ebay_list.py auth
  ebay_list.py list --title "GoPro Hero 12" --price 299.99 --condition NEW \\
    --image "https://example.com/photo.jpg" --category 31388
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("auth", help="Authenticate with eBay (opens browser)")
    sub.add_parser("refresh", help="Refresh access token")

    list_p = sub.add_parser("list", help="Create and publish a listing")
    list_p.add_argument("--title", required=True, help="Item title (max 80 chars)")
    list_p.add_argument("--description", required=True, help="Item description (max 4000 chars)")
    list_p.add_argument("--price", required=True, type=float, help="Listing price")
    list_p.add_argument("--condition", required=True, choices=CONDITIONS, help="Item condition")
    list_p.add_argument("--image", required=True, action="append", dest="images", help="Image URL (HTTPS, repeatable)")
    list_p.add_argument("--quantity", type=int, default=1, help="Quantity available (default: 1)")
    list_p.add_argument("--category", default="", help="eBay category ID")
    list_p.add_argument("--marketplace", default="US", choices=MARKETPLACES.keys(), help="Marketplace (default: US)")
    list_p.add_argument("--currency", default="USD", help="Currency code (default: USD)")
    list_p.add_argument("--sku", default="", help="Unique SKU (auto-generated if omitted)")
    list_p.add_argument("--brand", default="", help="Brand name")
    list_p.add_argument("--format", default="FIXED_PRICE", choices=["FIXED_PRICE", "AUCTION"], help="Listing format")
    list_p.add_argument("--draft", action="store_true", help="Create offer without publishing")

    args = parser.parse_args()
    env = get_env()
    sandbox = env["sandbox"]

    if args.command == "auth":
        do_auth()

    elif args.command == "refresh":
        tokens = load_tokens()
        refresh_token(tokens)
        print("Token refreshed successfully.")

    elif args.command == "list":
        sku = args.sku or f"CLAUDE-{uuid.uuid4().hex[:8].upper()}"
        marketplace = MARKETPLACES[args.marketplace]

        print(f"Creating inventory item (SKU: {sku})...")
        create_inventory_item(
            sku=sku,
            title=args.title,
            description=args.description,
            condition=args.condition,
            image_urls=args.images,
            quantity=args.quantity,
            brand=args.brand,
            sandbox=sandbox,
        )

        print(f"Creating offer on {marketplace}...")
        offer_id = create_offer(
            sku=sku,
            marketplace=marketplace,
            price=args.price,
            currency=args.currency,
            category_id=args.category,
            listing_format=args.format,
            sandbox=sandbox,
        )

        if args.draft:
            print(f"Draft offer created (not published). Offer ID: {offer_id}")
        else:
            print("Publishing listing...")
            publish_offer(offer_id, sandbox=sandbox)


if __name__ == "__main__":
    main()
