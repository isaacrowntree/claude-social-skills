#!/usr/bin/env python3
"""List items on eBay via the Inventory API (OAuth) or Trading API (Auth'n'Auth).

Auth methods (auto-detected from env vars):
  A) Auth'n'Auth (simpler): Set EBAY_AUTH_TOKEN from developer.ebay.com User Tokens page
  B) OAuth: Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME and run 'auth' command

Setup (Auth'n'Auth — recommended for personal use):
  1. Create account at https://developer.ebay.com
  2. Go to User Tokens tab, use Auth'n'Auth, sign in, copy the token
  3. Export EBAY_AUTH_TOKEN=<your token>
  4. Run: python3 ebay_list.py list ...

Setup (OAuth):
  1. Create account at https://developer.ebay.com
  2. Create an application to get client_id and client_secret
  3. Create a RuName (redirect URL) pointing to https://localhost:8888/callback
  4. Export EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME
  5. Run: python3 ebay_list.py auth   (opens browser, saves tokens)
  6. Run: python3 ebay_list.py list ...
"""
import argparse
import base64
import http.server
import json
import mimetypes
import os
import re
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser

import requests
import requests.packages.urllib3.util.connection as urllib3_cn

# Force IPv4 — workaround for Python 3.14 + local DNS proxy failing IPv6 lookups
urllib3_cn.HAS_IPV6 = False

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

# --- Exception for testability ---


class EbayApiError(Exception):
    """Raised by API functions instead of sys.exit, so callers (and tests) can catch them."""
    pass


# --- Presets for common listing configurations ---

LISTING_PRESETS = {
    "mascot-pickup": {
        "marketplace": "AU",
        "currency": "AUD",
        "postcode": "2020",
        "location": "Mascot, NSW",
        "domestic_services": [
            {"service": "AU_Regular", "cost": 15.0},
            {"service": "AU_Pickup"},
        ],
        "no_returns": True,
        "best_offer": True,
    },
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


def get_auth_mode() -> str:
    """Detect auth mode: 'authnauth' if EBAY_AUTH_TOKEN is set, else 'oauth'."""
    if os.environ.get("EBAY_AUTH_TOKEN"):
        return "authnauth"
    return "oauth"


def get_env():
    mode = get_auth_mode()
    sandbox = os.environ.get("EBAY_SANDBOX", "").lower() in ("1", "true", "yes")

    if mode == "authnauth":
        return {
            "mode": "authnauth",
            "auth_token": os.environ["EBAY_AUTH_TOKEN"],
            "sandbox": sandbox,
        }

    required = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}", file=sys.stderr)
        print("Either set EBAY_AUTH_TOKEN (Auth'n'Auth) or all of: {', '.join(required)} (OAuth)", file=sys.stderr)
        sys.exit(1)
    return {
        "mode": "oauth",
        "client_id": os.environ["EBAY_CLIENT_ID"],
        "client_secret": os.environ["EBAY_CLIENT_SECRET"],
        "runame": os.environ["EBAY_RUNAME"],
        "sandbox": sandbox,
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

    # Wrap with SSL using a self-signed cert so eBay accepts the https:// redirect URL
    cert_dir = tempfile.mkdtemp()
    cert_file = os.path.join(cert_dir, "cert.pem")
    key_file = os.path.join(cert_dir, "key.pem")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", key_file, "-out", cert_file,
            "-days", "1", "-nodes",
            "-subj", "/CN=localhost",
        ],
        capture_output=True,
        check=True,
    )
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_file, key_file)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)

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
        raise EbayApiError(f"Failed to create inventory item: {resp.status_code}\n{resp.text}")


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
        raise EbayApiError(f"Failed to create offer: {resp.status_code}\n{resp.text}")


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
        raise EbayApiError(f"Failed to publish: {resp.status_code}\n{resp.text}")


# --- Trading API (Auth'n'Auth) ---

TRADING_API_PRODUCTION = "https://api.ebay.com/ws/api.dll"
TRADING_API_SANDBOX = "https://api.sandbox.ebay.com/ws/api.dll"
TRADING_API_VERSION = "1349"

CONDITION_ID_MAP = {
    "NEW": "1000",
    "LIKE_NEW": "3000",
    "NEW_OTHER": "1500",
    "NEW_WITH_DEFECTS": "1750",
    "CERTIFIED_REFURBISHED": "2000",
    "SELLER_REFURBISHED": "2500",
    "USED_EXCELLENT": "3000",
    "USED_VERY_GOOD": "4000",
    "USED_GOOD": "5000",
    "USED_ACCEPTABLE": "6000",
    "FOR_PARTS_OR_NOT_WORKING": "7000",
}

SITE_ID_MAP = {
    "US": "0", "CA": "2", "UK": "3", "AU": "15",
    "DE": "77", "FR": "71", "IT": "101", "ES": "186",
}


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def trading_api_call(
    call_name: str,
    xml_body: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> str:
    url = TRADING_API_SANDBOX if sandbox else TRADING_API_PRODUCTION
    headers = {
        "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_API_VERSION,
        "X-EBAY-API-CALL-NAME": call_name,
        "X-EBAY-API-SITEID": site_id,
        "Content-Type": "text/xml",
    }

    xml_request = f"""<?xml version="1.0" encoding="utf-8"?>
<{call_name}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>{auth_token}</eBayAuthToken>
  </RequesterCredentials>
  {xml_body}
</{call_name}Request>"""

    resp = requests.post(url, headers=headers, data=xml_request.encode("utf-8"))
    if resp.status_code != 200:
        raise EbayApiError(f"Trading API error: {resp.status_code}\n{resp.text}")
    return resp.text


def _extract_xml_value(xml_text: str, tag: str) -> str:
    match = re.search(f"<{tag}>(.*?)</{tag}>", xml_text, re.DOTALL)
    return match.group(1) if match else ""


def upload_picture(
    file_path: str,
    auth_token: str,
    sandbox: bool = False,
) -> str:
    """Upload a local image to eBay via UploadSiteHostedPictures. Returns the hosted URL."""
    url = TRADING_API_SANDBOX if sandbox else TRADING_API_PRODUCTION
    mime_type = mimetypes.guess_type(file_path)[0] or "image/jpeg"

    xml_payload = f"""<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>{auth_token}</eBayAuthToken>
  </RequesterCredentials>
  <PictureName>{_escape_xml(os.path.basename(file_path))}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>"""

    # eBay expects multipart/form-data with the XML as one part and the image as another
    boundary = f"BOUNDARY_{uuid.uuid4().hex}"
    body_parts = []

    # XML part
    body_parts.append(f"--{boundary}\r\n".encode())
    body_parts.append(b'Content-Disposition: form-data; name="XML Payload"\r\n')
    body_parts.append(b"Content-Type: text/xml\r\n\r\n")
    body_parts.append(xml_payload.encode("utf-8"))
    body_parts.append(b"\r\n")

    # Image part
    with open(file_path, "rb") as f:
        image_data = f.read()

    body_parts.append(f"--{boundary}\r\n".encode())
    body_parts.append(
        f'Content-Disposition: form-data; name="image"; filename="{os.path.basename(file_path)}"\r\n'.encode()
    )
    body_parts.append(f"Content-Type: {mime_type}\r\n".encode())
    body_parts.append(f"Content-Transfer-Encoding: binary\r\n\r\n".encode())
    body_parts.append(image_data)
    body_parts.append(f"\r\n--{boundary}--\r\n".encode())

    body = b"".join(body_parts)

    upload_headers = {
        "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_API_VERSION,
        "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
        "X-EBAY-API-SITEID": "0",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }

    # Retry up to 3 times — eBay sometimes resets connections on large uploads
    last_err = None
    for attempt in range(3):
        try:
            resp = requests.post(url, headers=upload_headers, data=body, timeout=60)
            break
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
            if attempt < 2:
                wait = 2 ** attempt
                print(f"  Upload attempt {attempt + 1} failed, retrying in {wait}s...")
                time.sleep(wait)
    else:
        raise EbayApiError(f"Image upload failed after 3 attempts: {last_err}")

    if resp.status_code != 200:
        raise EbayApiError(f"Image upload HTTP error: {resp.status_code}\n{resp.text}")

    ack = _extract_xml_value(resp.text, "Ack")
    if ack not in ("Success", "Warning"):
        error = _extract_xml_value(resp.text, "LongMessage") or _extract_xml_value(resp.text, "ShortMessage")
        raise EbayApiError(f"Image upload failed: {error}")

    hosted_url = _extract_xml_value(resp.text, "FullURL")
    print(f"Uploaded: {os.path.basename(file_path)} -> {hosted_url}")
    return hosted_url


def resolve_images(
    image_args: list[str],
    auth_token: str = "",
    sandbox: bool = False,
) -> list[str]:
    """Resolve image arguments: upload local files, pass through URLs."""
    urls = []
    for img in image_args:
        if img.startswith("http://") or img.startswith("https://"):
            urls.append(img)
        elif os.path.isfile(img):
            if not auth_token:
                raise EbayApiError("Local image upload requires Auth'n'Auth (EBAY_AUTH_TOKEN).")
            hosted_url = upload_picture(img, auth_token, sandbox)
            urls.append(hosted_url)
        else:
            raise EbayApiError(f"Image not found: {img}")
    return urls


def _trading_api_call_safe(
    call_name: str,
    xml_body: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> str | None:
    """Like trading_api_call but returns None on failure instead of sys.exit."""
    url = TRADING_API_SANDBOX if sandbox else TRADING_API_PRODUCTION
    headers = {
        "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_API_VERSION,
        "X-EBAY-API-CALL-NAME": call_name,
        "X-EBAY-API-SITEID": site_id,
        "Content-Type": "text/xml",
    }
    xml_request = f"""<?xml version="1.0" encoding="utf-8"?>
<{call_name}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>{auth_token}</eBayAuthToken>
  </RequesterCredentials>
  {xml_body}
</{call_name}Request>"""

    try:
        resp = requests.post(url, headers=headers, data=xml_request.encode("utf-8"), timeout=30)
        if resp.status_code != 200:
            return None
        return resp.text
    except Exception:
        return None


# Common eBay category lookup (AU site — covers most consumer electronics & gear)
CATEGORY_KEYWORDS = {
    # Cameras & Photo
    "31388": "Digital Cameras",
    "48515": "Camera Flashes & Flash Accessories > Flashes",
    "3323": "Camera Lenses",
    "30090": "Camera Lens Filters",
    "64345": "Camera Tripods & Monopods",
    "30093": "Camera Lens Caps",
    "78997": "Camera Memory Card Cases",
    "15200": "Camera Bags & Cases",
    "29964": "Camera Batteries",
    "29993": "Camera Battery Chargers",
    "11724": "Camera Memory Cards",
    "179697": "Camera Drones",
    "182970": "Drone Parts & Accessories",
    # Gimbals & Stabilisers
    "183505": "Cameras > Tripods & Supports > Stabilisers & Gimbals",
    "171959": "Camera Rigs & Cages",
    # Video
    "11724": "Video Production Equipment",
    "21163": "Video Camera Accessories",
    # Mobile / Smartphones
    "9394": "Cell Phones & Smartphones",
    "20349": "Cell Phone Cases, Covers & Skins",
    "67280": "Cell Phone Chargers & Holders",
    "80077": "Cell Phone Cables & Adapters",
    "182064": "Cell Phone Gimbals & Stabilizers",
    # Computers & Networking
    "51168": "Enterprise Firewalls & VPN Devices",
    "44994": "Wireless Routers",
    "44995": "Modems",
    "11175": "Network Switches",
    "175709": "Wired Routers",
    "101270": "Servers",
    "175698": "Network Attached Storage (NAS)",
    "41505": "PC Laptops & Netbooks",
    "171957": "PC Desktops & All-In-Ones",
    "175673": "Monitors, Projectors & Accessories",
    "56083": "Keyboards & Mice",
    "44980": "USB Flash Drives",
    "56101": "External Hard Disk Drives",
    "56090": "Graphics Cards",
    "175712": "Computer Components & Parts",
    "131090": "Tablets & eReaders",
    # Gaming
    "139971": "Video Game Consoles",
    "139973": "Video Game Controllers & Attachments",
    "139969": "Video Games",
    # Audio
    "112529": "Headphones",
    "14969": "Portable Audio & Headphones",
    "48647": "Amplifiers & Preamps",
    "3287": "Turntables & Record Players",
    "48620": "Receivers & Amplifiers",
    "14990": "Portable Speakers & Docks",
    "171814": "Smart Speakers",
    # Home Electronics
    "11071": "Home Theatre Projectors",
    "11072": "TVs",
    "48654": "Streaming Media Players",
    "73839": "Home Security Cameras",
    "184435": "Robot Vacuums",
    # Sporting Goods
    "16264": "Skateboards-Complete",
    "36114": "Electric Scooters",
    "7294": "Cycling",
    "159043": "Fitness Technology",
    # Other Electronics
    "4673": "GPS Units",
    "48446": "3D Printers & Supplies",
    "116680": "Smartwatches",
    "15032": "Power Tools",
    "12576": "Test, Measurement & Inspection Equipment",
}


def search_categories(query: str) -> list[dict]:
    """Search built-in category lookup by keyword(s). Returns matching categories."""
    terms = query.lower().split()
    results = []
    for cat_id, name in CATEGORY_KEYWORDS.items():
        name_lower = name.lower()
        # Score by how many query terms match
        score = sum(1 for t in terms if t in name_lower or t in cat_id)
        if score > 0:
            results.append({"id": cat_id, "name": name, "score": score})
    results.sort(key=lambda x: -x["score"])
    return results


def suggest_category(title: str) -> list[dict]:
    """Suggest categories based on item title using keyword matching."""
    # Try matching against known categories
    results = search_categories(title)
    if results:
        return results

    # Try individual words from the title
    words = title.lower().split()
    all_results = {}
    for word in words:
        if len(word) < 3:
            continue
        for cat_id, name in CATEGORY_KEYWORDS.items():
            if word in name.lower():
                if cat_id not in all_results:
                    all_results[cat_id] = {"id": cat_id, "name": name, "score": 1}
                else:
                    all_results[cat_id]["score"] += 1
    results = sorted(all_results.values(), key=lambda x: -x["score"])
    return results


def get_valid_conditions(
    category_id: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> list[dict]:
    """Get valid condition IDs for a category via GetCategoryFeatures."""
    body = f"""
  <CategoryID>{_escape_xml(category_id)}</CategoryID>
  <FeatureID>ConditionValues</FeatureID>
  <DetailLevel>ReturnAll</DetailLevel>"""
    result = _trading_api_call_safe("GetCategoryFeatures", body, auth_token, sandbox, site_id)
    if result is None:
        return []

    conditions = []
    for match in re.finditer(
        r"<Condition>.*?<ID>(\d+)</ID>.*?<DisplayName>(.*?)</DisplayName>.*?</Condition>",
        result,
        re.DOTALL,
    ):
        conditions.append({"id": match.group(1), "name": match.group(2)})
    return conditions


def resolve_condition(
    condition: str,
    category_id: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> str:
    """Resolve a condition name to a valid condition ID for the given category.

    First tries the static CONDITION_ID_MAP. If the ID isn't valid for the category,
    falls back to the best matching valid condition from GetCategoryFeatures.
    """
    desired_id = CONDITION_ID_MAP.get(condition, "3000")
    valid = get_valid_conditions(category_id, auth_token, sandbox, site_id)

    if not valid:
        # API didn't return conditions — use static map
        return desired_id

    valid_ids = {c["id"] for c in valid}
    if desired_id in valid_ids:
        return desired_id

    # Map our condition names to a rough quality order (lower = better)
    quality_order = {
        "NEW": 0, "NEW_OTHER": 1, "NEW_WITH_DEFECTS": 2,
        "CERTIFIED_REFURBISHED": 3, "SELLER_REFURBISHED": 4,
        "LIKE_NEW": 5, "USED_EXCELLENT": 5,
        "USED_VERY_GOOD": 6, "USED_GOOD": 7,
        "USED_ACCEPTABLE": 8, "FOR_PARTS_OR_NOT_WORKING": 9,
    }
    desired_quality = quality_order.get(condition, 5)

    # Find the closest valid condition by quality
    best = None
    best_dist = 999
    for vc in valid:
        # Map eBay display names back to quality levels
        name_lower = vc["name"].lower()
        if "new" == name_lower:
            q = 0
        elif "new other" in name_lower or "new without tags" in name_lower:
            q = 1
        elif "new with defects" in name_lower:
            q = 2
        elif "refurbished" in name_lower and "certified" in name_lower:
            q = 3
        elif "refurbished" in name_lower:
            q = 4
        elif "excellent" in name_lower:
            q = 5
        elif "very good" in name_lower:
            q = 6
        elif "good" in name_lower:
            q = 7
        elif "acceptable" in name_lower:
            q = 8
        elif "parts" in name_lower or "not working" in name_lower:
            q = 9
        elif "used" == name_lower or "pre-owned" in name_lower:
            # Generic "Used" — map to middle quality
            q = 6
        else:
            q = 5

        dist = abs(q - desired_quality)
        if dist < best_dist:
            best_dist = dist
            best = vc

    if best:
        print(f"Condition '{condition}' (ID {desired_id}) not valid for category {category_id}.")
        print(f"  Using '{best['name']}' (ID {best['id']}) instead.")
        return best["id"]

    return desired_id


def _build_listing_xml(
    title: str,
    description: str,
    price: float,
    condition_id: str,
    image_urls: list[str],
    quantity: int = 1,
    category_id: str = "",
    currency: str = "USD",
    marketplace: str = "US",
    # Shipping
    shipping_type: str = "Flat",
    domestic_services: list[dict] | None = None,
    international_services: list[dict] | None = None,
    dispatch_days: int = 3,
    ship_to_locations: str = "",
    # Calculated shipping dimensions
    package_type: str = "",
    package_length: float | None = None,
    package_width: float | None = None,
    package_depth: float | None = None,
    weight_kg: float | None = None,
    # Returns
    returns_accepted: bool = True,
    return_days: int = 30,
    return_shipping_paid_by: str = "Buyer",
    # Item details
    item_specifics: dict | None = None,
    condition_description: str = "",
    postcode: str = "",
    location: str = "",
    # Best offer
    best_offer: bool = False,
    best_offer_min: float | None = None,
    best_offer_auto_accept: float | None = None,
    # Display
    gallery_type: str = "",
) -> str:
    """Build the XML body for an AddFixedPriceItem / VerifyAddFixedPriceItem call.

    Takes a resolved condition_id (not a condition name). Returns the XML <Item> body string.
    """
    pictures_xml = "\n".join(
        f"      <PictureURL>{_escape_xml(url)}</PictureURL>" for url in image_urls
    )

    category_xml = ""
    if category_id:
        category_xml = f"""
    <PrimaryCategory>
      <CategoryID>{_escape_xml(category_id)}</CategoryID>
    </PrimaryCategory>"""

    # Shipping
    shipping_xml = f"""
    <ShippingDetails>
      <ShippingType>{_escape_xml(shipping_type)}</ShippingType>"""

    # Calculated shipping rate (package dimensions)
    if package_type or weight_kg is not None:
        shipping_xml += """
      <CalculatedShippingRate>"""
        if package_type:
            shipping_xml += f"""
        <ShippingPackage>{_escape_xml(package_type)}</ShippingPackage>"""
        if package_length is not None:
            shipping_xml += f"""
        <PackageLength measurementSystem="Metric" unit="cm">{package_length}</PackageLength>"""
        if package_width is not None:
            shipping_xml += f"""
        <PackageWidth measurementSystem="Metric" unit="cm">{package_width}</PackageWidth>"""
        if package_depth is not None:
            shipping_xml += f"""
        <PackageDepth measurementSystem="Metric" unit="cm">{package_depth}</PackageDepth>"""
        if weight_kg is not None:
            kg = int(weight_kg)
            gm = int((weight_kg - kg) * 1000)
            shipping_xml += f"""
        <WeightMajor measurementSystem="Metric" unit="kg">{kg}</WeightMajor>
        <WeightMinor measurementSystem="Metric" unit="gm">{gm}</WeightMinor>"""
        shipping_xml += """
      </CalculatedShippingRate>"""

    # Domestic shipping services
    if domestic_services:
        for i, svc in enumerate(domestic_services, 1):
            is_free = svc.get("free", False)
            is_calculated = shipping_type.startswith("Calculated")
            shipping_xml += f"""
      <ShippingServiceOptions>
        <ShippingService>{_escape_xml(svc["service"])}</ShippingService>
        <ShippingServicePriority>{i}</ShippingServicePriority>"""
            if is_free:
                shipping_xml += """
        <FreeShipping>true</FreeShipping>"""
            elif not is_calculated:
                # Only include cost for flat-rate shipping; calculated uses package dimensions
                cost = svc.get("cost", 0.0)
                shipping_xml += f"""
        <ShippingServiceCost currencyID="{_escape_xml(currency)}">{cost}</ShippingServiceCost>"""
            shipping_xml += """
      </ShippingServiceOptions>"""

    # International shipping services
    if international_services:
        for i, svc in enumerate(international_services, 1):
            cost = svc.get("cost", 0.0)
            ship_to = svc.get("ship_to", "Worldwide")
            shipping_xml += f"""
      <InternationalShippingServiceOption>
        <ShippingService>{_escape_xml(svc["service"])}</ShippingService>
        <ShippingServiceCost currencyID="{_escape_xml(currency)}">{cost}</ShippingServiceCost>
        <ShippingServicePriority>{i}</ShippingServicePriority>
        <ShipToLocation>{_escape_xml(ship_to)}</ShipToLocation>
      </InternationalShippingServiceOption>"""

    shipping_xml += """
    </ShippingDetails>"""

    # Ship to locations
    ship_to_xml = ""
    if ship_to_locations:
        ship_to_xml = f"\n    <ShipToLocations>{_escape_xml(ship_to_locations)}</ShipToLocations>"

    # Returns
    returns_xml = f"""
    <ReturnPolicy>
      <ReturnsAcceptedOption>{"ReturnsAccepted" if returns_accepted else "ReturnsNotAccepted"}</ReturnsAcceptedOption>"""
    if returns_accepted:
        returns_xml += f"""
      <ReturnsWithinOption>Days_{return_days}</ReturnsWithinOption>
      <ShippingCostPaidByOption>{_escape_xml(return_shipping_paid_by)}</ShippingCostPaidByOption>"""
    returns_xml += """
    </ReturnPolicy>"""

    # Item specifics
    specifics_xml = ""
    if item_specifics:
        specifics_xml = "\n    <ItemSpecifics>"
        for name, value in item_specifics.items():
            specifics_xml += f"""
      <NameValueList>
        <Name>{_escape_xml(name)}</Name>
        <Value>{_escape_xml(str(value))}</Value>
      </NameValueList>"""
        specifics_xml += "\n    </ItemSpecifics>"

    condition_desc_xml = ""
    if condition_description:
        condition_desc_xml = f"\n    <ConditionDescription>{_escape_xml(condition_description)}</ConditionDescription>"

    postcode_xml = ""
    if postcode:
        postcode_xml = f"\n    <PostalCode>{_escape_xml(postcode)}</PostalCode>"

    location_xml = ""
    if location:
        location_xml = f"\n    <Location>{_escape_xml(location)}</Location>"

    best_offer_xml = ""
    if best_offer:
        best_offer_xml = "\n    <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>"

    # ListingBestOfferDetails for auto-accept/min thresholds
    best_offer_details_xml = ""
    if best_offer_auto_accept is not None or best_offer_min is not None:
        best_offer_details_xml = "\n    <ListingDetails>"
        if best_offer_auto_accept is not None:
            best_offer_details_xml += f"""
      <BestOfferAutoAcceptPrice currencyID="{_escape_xml(currency)}">{best_offer_auto_accept}</BestOfferAutoAcceptPrice>"""
        if best_offer_min is not None:
            best_offer_details_xml += f"""
      <MinimumBestOfferPrice currencyID="{_escape_xml(currency)}">{best_offer_min}</MinimumBestOfferPrice>"""
        best_offer_details_xml += "\n    </ListingDetails>"

    gallery_xml = ""
    if gallery_type:
        gallery_xml = f"\n      <GalleryType>{_escape_xml(gallery_type)}</GalleryType>"

    return f"""
  <Item>
    <Title>{_escape_xml(title)}</Title>
    <Description><![CDATA[{description}]]></Description>
    <StartPrice currencyID="{_escape_xml(currency)}">{price}</StartPrice>
    <ConditionID>{condition_id}</ConditionID>{condition_desc_xml}
    <Country>{_escape_xml(marketplace)}</Country>
    <Currency>{_escape_xml(currency)}</Currency>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>{quantity}</Quantity>
    <DispatchTimeMax>{dispatch_days}</DispatchTimeMax>{category_xml}{postcode_xml}{location_xml}{best_offer_xml}{best_offer_details_xml}{ship_to_xml}
    <PictureDetails>{gallery_xml}
{pictures_xml}
    </PictureDetails>{shipping_xml}{returns_xml}{specifics_xml}
  </Item>"""


def trading_add_fixed_price_item(
    title: str,
    description: str,
    price: float,
    condition: str,
    image_urls: list[str],
    quantity: int = 1,
    category_id: str = "",
    currency: str = "USD",
    marketplace: str = "US",
    auth_token: str = "",
    sandbox: bool = False,
    draft: bool = False,
    # Shipping
    shipping_type: str = "Flat",
    domestic_services: list[dict] | None = None,
    international_services: list[dict] | None = None,
    dispatch_days: int = 3,
    ship_to_locations: str = "",
    # Calculated shipping dimensions
    package_type: str = "",
    package_length: float | None = None,
    package_width: float | None = None,
    package_depth: float | None = None,
    weight_kg: float | None = None,
    # Returns
    returns_accepted: bool = True,
    return_days: int = 30,
    return_shipping_paid_by: str = "Buyer",
    # Item details
    item_specifics: dict | None = None,
    condition_description: str = "",
    postcode: str = "",
    location: str = "",
    # Best offer
    best_offer: bool = False,
    best_offer_min: float | None = None,
    best_offer_auto_accept: float | None = None,
    # Display
    gallery_type: str = "",
) -> str:
    """Create a fixed-price listing via Trading API.

    domestic_services: list of dicts with keys: service, cost, free (bool)
      e.g. [{"service": "AU_Regular", "free": True}, {"service": "AU_Pickup"}]
    international_services: list of dicts with keys: service, cost, ship_to
      e.g. [{"service": "AU_AusPostRegisteredPostInternationalParcel", "cost": 150, "ship_to": "Worldwide"}]
    """
    site_id = SITE_ID_MAP.get(marketplace, "0")

    # Auto-suggest category if not provided
    if not category_id:
        print(f"No category specified — looking up suggestions for: {title}")
        suggestions = suggest_category(title)
        if suggestions:
            category_id = suggestions[0]["id"]
            print(f"  Auto-selected: {suggestions[0]['name']} ({category_id})")
            if len(suggestions) > 1:
                for s in suggestions[1:4]:
                    print(f"  Also considered: {s['name']} ({s['id']})")
        else:
            print("  No category suggestions found. Listing without category.")

    # Resolve condition to a valid ID for this category
    if category_id and auth_token:
        condition_id = resolve_condition(condition, category_id, auth_token, sandbox, site_id)
    else:
        condition_id = CONDITION_ID_MAP.get(condition, "1000")

    body = _build_listing_xml(
        title=title,
        description=description,
        price=price,
        condition_id=condition_id,
        image_urls=image_urls,
        quantity=quantity,
        category_id=category_id,
        currency=currency,
        marketplace=marketplace,
        shipping_type=shipping_type,
        domestic_services=domestic_services,
        international_services=international_services,
        dispatch_days=dispatch_days,
        ship_to_locations=ship_to_locations,
        package_type=package_type,
        package_length=package_length,
        package_width=package_width,
        package_depth=package_depth,
        weight_kg=weight_kg,
        returns_accepted=returns_accepted,
        return_days=return_days,
        return_shipping_paid_by=return_shipping_paid_by,
        item_specifics=item_specifics,
        condition_description=condition_description,
        postcode=postcode,
        location=location,
        best_offer=best_offer,
        best_offer_min=best_offer_min,
        best_offer_auto_accept=best_offer_auto_accept,
        gallery_type=gallery_type,
    )

    call_name = "VerifyAddFixedPriceItem" if draft else "AddFixedPriceItem"
    result = trading_api_call(call_name, body, auth_token, sandbox, site_id)

    ack = _extract_xml_value(result, "Ack")
    if ack not in ("Success", "Warning"):
        errors = _extract_xml_value(result, "LongMessage") or _extract_xml_value(result, "ShortMessage")
        raise EbayApiError(f"eBay {call_name} failed: {ack}\nError: {errors}\n{result}")

    item_id = _extract_xml_value(result, "ItemID")
    if draft:
        fees = _extract_xml_value(result, "Fee")
        print(f"Verification passed (draft). Estimated fees shown above.")
    else:
        print(f"Listed! Item ID: {item_id}")
        print(f"https://www.ebay.com/itm/{item_id}")

    return item_id


def revise_fixed_price_item(
    item_id: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
    price: float | None = None,
    title: str = "",
    description: str = "",
    best_offer_min: float | None = None,
    best_offer_auto_accept: float | None = None,
    currency: str = "AUD",
) -> str:
    """Revise an existing fixed-price listing via Trading API."""
    fields = ""
    if price is not None:
        fields += f'\n    <StartPrice currencyID="{_escape_xml(currency)}">{price}</StartPrice>'
    if title:
        fields += f"\n    <Title>{_escape_xml(title)}</Title>"
    if description:
        fields += f"\n    <Description><![CDATA[{description}]]></Description>"
    if best_offer_min is not None or best_offer_auto_accept is not None:
        fields += "\n    <ListingDetails>"
        if best_offer_auto_accept is not None:
            fields += f'\n      <BestOfferAutoAcceptPrice currencyID="{_escape_xml(currency)}">{best_offer_auto_accept}</BestOfferAutoAcceptPrice>'
        if best_offer_min is not None:
            fields += f'\n      <MinimumBestOfferPrice currencyID="{_escape_xml(currency)}">{best_offer_min}</MinimumBestOfferPrice>'
        fields += "\n    </ListingDetails>"

    body = f"""
  <Item>
    <ItemID>{_escape_xml(item_id)}</ItemID>{fields}
  </Item>"""

    result = trading_api_call("ReviseFixedPriceItem", body, auth_token, sandbox, site_id)
    ack = _extract_xml_value(result, "Ack")
    if ack not in ("Success", "Warning"):
        errors = _extract_xml_value(result, "LongMessage") or _extract_xml_value(result, "ShortMessage")
        raise EbayApiError(f"ReviseFixedPriceItem failed: {ack}\nError: {errors}")

    print(f"Revised item {item_id} successfully.")
    return item_id


def get_category_specifics(
    category_id: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> list[dict]:
    """Get required/recommended item specifics for a category via GetCategorySpecifics.

    Returns a list of dicts with keys: name, required (bool), values (list of valid values).
    """
    body = f"""
  <CategorySpecific>
    <CategoryID>{_escape_xml(category_id)}</CategoryID>
  </CategorySpecific>"""
    result = trading_api_call("GetCategorySpecifics", body, auth_token, sandbox, site_id)

    ack = _extract_xml_value(result, "Ack")
    if ack not in ("Success", "Warning"):
        errors = _extract_xml_value(result, "LongMessage") or _extract_xml_value(result, "ShortMessage")
        raise EbayApiError(f"GetCategorySpecifics failed: {ack}\n{errors}")

    specifics = []
    # Parse each NameRecommendation block
    for block in re.finditer(
        r"<NameRecommendation>(.*?)</NameRecommendation>", result, re.DOTALL
    ):
        content = block.group(1)
        name = _extract_xml_value(content, "Name")
        if not name:
            continue
        # Check ValidationRules for MinRequired
        usage = _extract_xml_value(content, "UsageConstraint") or ""
        min_values = _extract_xml_value(content, "MinValues") or "0"
        required = usage.lower() == "required" or min_values != "0"

        # Extract recommended values
        values = re.findall(r"<ValueRecommendation>\s*<Value>(.*?)</Value>", content, re.DOTALL)

        specifics.append({
            "name": name,
            "required": required,
            "values": values,
        })

    return specifics


def find_categories_online(
    query: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
    parent_id: str = "",
) -> list[dict]:
    """Search eBay categories via GetCategories (Trading API).

    Uses keyword matching against category names fetched from the eBay site.
    GetSuggestedCategories is deprecated (always 503), so this uses GetCategories
    with a parent filter or fetches top-level and filters by keyword.

    Returns a list of dicts with keys: id, name, leaf (bool), parent_id.
    """
    body = """
  <DetailLevel>ReturnAll</DetailLevel>
  <ViewAllNodes>true</ViewAllNodes>
  <LevelLimit>4</LevelLimit>"""
    if parent_id:
        body += f"\n  <CategoryParent>{_escape_xml(parent_id)}</CategoryParent>"

    result = _trading_api_call_safe("GetCategories", body, auth_token, sandbox, site_id)
    if result is None:
        return []

    categories = []
    for block in re.finditer(
        r"<Category>(.*?)</Category>", result, re.DOTALL
    ):
        content = block.group(1)
        cat_id = _extract_xml_value(content, "CategoryID")
        cat_name = _extract_xml_value(content, "CategoryName")
        cat_parent = _extract_xml_value(content, "CategoryParentID")
        is_leaf = "<LeafCategory>true</LeafCategory>" in content

        categories.append({
            "id": cat_id,
            "name": cat_name,
            "leaf": is_leaf,
            "parent_id": cat_parent,
        })

    # Filter by query keywords
    if query and not parent_id:
        terms = query.lower().split()
        filtered = []
        for cat in categories:
            name_lower = cat["name"].lower()
            score = sum(1 for t in terms if t in name_lower)
            if score > 0:
                cat["score"] = score
                filtered.append(cat)
        filtered.sort(key=lambda x: (-x.get("score", 0), not x["leaf"]))
        return filtered

    return categories


def validate_leaf_category(
    category_id: str,
    auth_token: str,
    sandbox: bool = False,
    site_id: str = "0",
) -> tuple[bool, str]:
    """Check if a category ID is a valid leaf category on the given site.

    Returns (is_leaf, category_name). If the API call fails, returns (True, "") to
    avoid blocking listings.
    """
    body = f"""
  <DetailLevel>ReturnAll</DetailLevel>
  <ViewAllNodes>true</ViewAllNodes>
  <CategoryParent>{_escape_xml(category_id)}</CategoryParent>"""

    result = _trading_api_call_safe("GetCategories", body, auth_token, sandbox, site_id)
    if result is None:
        return True, ""  # Can't verify — don't block

    for block in re.finditer(r"<Category>(.*?)</Category>", result, re.DOTALL):
        content = block.group(1)
        cat_id = _extract_xml_value(content, "CategoryID")
        if cat_id == category_id:
            cat_name = _extract_xml_value(content, "CategoryName")
            is_leaf = "<LeafCategory>true</LeafCategory>" in content
            return is_leaf, cat_name

    return True, ""  # Not found — don't block


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
    sub.add_parser("dashboard", help="Show all active/sold listings with prices and metrics")
    msg_p = sub.add_parser("messages", help="Show recent eBay messages")
    msg_p.add_argument("--days", type=int, default=14, help="Number of days to look back (default: 14)")

    cat_p = sub.add_parser("categories", help="Search for eBay category IDs (built-in)")
    cat_p.add_argument("query", nargs="+", help="Keywords to search (e.g. 'gimbal stabilizer')")

    fc_p = sub.add_parser("find-category", help="Search eBay site for category IDs (live API)")
    fc_p.add_argument("query", nargs="+", help="Keywords to search (e.g. 'mobile phones')")
    fc_p.add_argument("--marketplace", default="AU", choices=MARKETPLACES.keys(), help="Marketplace (default: AU)")
    fc_p.add_argument("--parent", default="", help="Parent category ID to search within")

    sp_p = sub.add_parser("specifics", help="Show required item specifics for a category")
    sp_p.add_argument("category_id", help="eBay category ID")
    sp_p.add_argument("--marketplace", default="AU", choices=MARKETPLACES.keys(), help="Marketplace (default: AU)")

    verify_p = sub.add_parser("verify", help="Dry-run a listing (VerifyAddFixedPriceItem)")

    list_p = sub.add_parser("list", help="Create and publish a listing")

    # Add shared args to both list and verify
    for p in [list_p, verify_p]:
        p.add_argument("--title", required=True, help="Item title (max 80 chars)")
        p.add_argument("--description", required=True, help="Item description (max 4000 chars)")
        p.add_argument("--price", required=True, type=float, help="Listing price")
        p.add_argument("--condition", required=True, choices=CONDITIONS, help="Item condition")
        p.add_argument("--image", required=True, action="append", dest="images", help="Image URL or local file path (repeatable)")
        p.add_argument("--quantity", type=int, default=1, help="Quantity available (default: 1)")
        p.add_argument("--category", default="", help="eBay category ID (auto-suggested from title if omitted)")
        p.add_argument("--marketplace", default="US", choices=MARKETPLACES.keys(), help="Marketplace (default: US)")
        p.add_argument("--currency", default="USD", help="Currency code (default: USD)")
        p.add_argument("--sku", default="", help="Unique SKU (auto-generated if omitted)")
        p.add_argument("--brand", default="", help="Brand name")
        p.add_argument("--format", default="FIXED_PRICE", choices=["FIXED_PRICE", "AUCTION"], help="Listing format")
        p.add_argument("--draft", action="store_true", help="Create offer without publishing")
        # Preset
        p.add_argument("--preset", default="", choices=[""] + list(LISTING_PRESETS.keys()),
                        help=f"Apply a listing preset ({', '.join(LISTING_PRESETS.keys())})")
        # Shipping
        p.add_argument("--shipping-type", default="Flat", help="Shipping type (Flat, Calculated, CalculatedDomesticFlatInternational)")
        p.add_argument("--domestic-shipping", action="append", dest="domestic_services", metavar="SERVICE[:COST|free]",
                        help="Domestic shipping (repeatable). e.g. --domestic-shipping AU_Regular:free --domestic-shipping AU_Pickup")
        p.add_argument("--international-shipping", action="append", dest="intl_services", metavar="SERVICE:COST[:SHIP_TO]",
                        help="International shipping (repeatable). e.g. --international-shipping AU_AusPostRegisteredPostInternationalParcel:150:Worldwide")
        p.add_argument("--dispatch-days", type=int, default=3, help="Handling/dispatch time in days (default: 3)")
        p.add_argument("--ship-to", default="", help="Ship to locations (e.g. Worldwide, AU, US)")
        # Calculated shipping dimensions
        p.add_argument("--package-type", default="", help="Package type (e.g. PaddedBags, LargeEnvelope, PackageThickEnvelope)")
        p.add_argument("--package-length", type=float, default=None, help="Package length in cm")
        p.add_argument("--package-width", type=float, default=None, help="Package width in cm")
        p.add_argument("--package-depth", type=float, default=None, help="Package depth in cm")
        p.add_argument("--weight", type=float, default=None, help="Package weight in kg (e.g. 2.5)")
        # Returns
        p.add_argument("--no-returns", action="store_true", help="Don't accept returns")
        p.add_argument("--return-days", type=int, default=30, help="Return period in days (default: 30)")
        p.add_argument("--return-paid-by", default="Buyer", choices=["Buyer", "Seller"], help="Who pays return shipping (default: Buyer)")
        # Item details
        p.add_argument("--specific", action="append", dest="specifics", metavar="Name=Value", help="Item specific (repeatable, e.g. --specific 'Brand=Sony')")
        p.add_argument("--condition-description", default="", help="Describe item condition details")
        p.add_argument("--postcode", default="", help="Item location postcode")
        p.add_argument("--location", default="", help="Item location city/state (e.g. 'Mascot, NSW')")
        # Best offer
        p.add_argument("--best-offer", action="store_true", help="Enable Best Offer")
        p.add_argument("--best-offer-min", type=float, default=None, help="Auto-decline offers below this price")
        p.add_argument("--best-offer-auto-accept", type=float, default=None, help="Auto-accept offers at or above this price")
        # Display
        p.add_argument("--gallery-plus", action="store_true", help="Enable Gallery Plus for larger images in search")

    args = parser.parse_args()

    # --- Commands that don't need env/auth ---

    if args.command == "categories":
        query = " ".join(args.query)
        results = search_categories(query)
        if results:
            print(f"Categories matching '{query}':")
            for r in results[:10]:
                print(f"  {r['id']:>8}  {r['name']}")
        else:
            print(f"No categories found for '{query}'. Try different keywords.")
            print(f"Available categories ({len(CATEGORY_KEYWORDS)}):")
            for cat_id, name in sorted(CATEGORY_KEYWORDS.items(), key=lambda x: x[1]):
                print(f"  {cat_id:>8}  {name}")
        return

    env = get_env()
    sandbox = env["sandbox"]

    if args.command == "auth":
        if env.get("mode") == "authnauth":
            print("Auth'n'Auth mode — no OAuth flow needed.")
            print("Your EBAY_AUTH_TOKEN is already set. Use 'list' to create listings.")
            sys.exit(0)
        do_auth()

    elif args.command == "refresh":
        if env.get("mode") == "authnauth":
            print("Auth'n'Auth tokens don't need refreshing (valid ~18 months).")
            sys.exit(0)
        tokens = load_tokens()
        refresh_token(tokens)
        print("Token refreshed successfully.")

    # --- dashboard: show all listings with metrics ---

    elif args.command == "dashboard":
        auth_token = env.get("auth_token", "")
        if not auth_token:
            print("dashboard requires Auth'n'Auth token.", file=sys.stderr)
            sys.exit(1)

        body = """
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>50</EntriesPerPage></Pagination>
  </ActiveList>
  <SoldList>
    <Include>true</Include>
    <DurationInDays>30</DurationInDays>
    <Pagination><EntriesPerPage>25</EntriesPerPage></Pagination>
  </SoldList>
  <DetailLevel>ReturnAll</DetailLevel>"""
        result = trading_api_call("GetMyeBaySelling", body, auth_token, sandbox, "15")

        # Collect active item IDs
        active_ids = []
        active_block = re.search(r"<ActiveList>(.*?)</ActiveList>", result, re.DOTALL)
        if active_block:
            for m in re.finditer(r"<ItemID>(\d+)</ItemID>", active_block.group(1)):
                if m.group(1) not in active_ids:
                    active_ids.append(m.group(1))

        # Fetch full details for each active item
        print("=" * 90)
        print(f"{'ACTIVE LISTINGS':^90}")
        print("=" * 90)
        print(f"{'Title':<42} {'Price':>8}  {'Watch':>5}  {'Offers':>6}  {'BestOffer':>9}")
        print("-" * 90)
        for item_id in active_ids:
            item_body = f"<ItemID>{item_id}</ItemID><DetailLevel>ReturnAll</DetailLevel>"
            try:
                item_result = trading_api_call("GetItem", item_body, auth_token, sandbox, "15")
                title = _extract_xml_value(item_result, "Title")
                price_m = re.search(r"<StartPrice[^>]*>([\d.]+)</StartPrice>", item_result)
                price = price_m.group(1) if price_m else "?"
                watchers = _extract_xml_value(item_result, "WatchCount") or "0"
                bo_count = _extract_xml_value(item_result, "BestOfferCount") or "0"
                bo_on = _extract_xml_value(item_result, "BestOfferEnabled")
                bo_str = "on" if bo_on == "true" else "off"
                print(f"  {title[:40]:<40} A${price:>7}  {watchers:>5}  {bo_count:>6}  {bo_str:>9}")
            except EbayApiError:
                print(f"  #{item_id} — error fetching details")

        # Sold items
        print()
        print("=" * 90)
        print(f"{'SOLD (last 30 days)':^90}")
        print("=" * 90)
        sold_block = re.search(r"<SoldList>(.*?)</SoldList>", result, re.DOTALL)
        if sold_block:
            for item in re.finditer(r"<OrderTransaction>(.*?)</OrderTransaction>", sold_block.group(1), re.DOTALL):
                c = item.group(1)
                title = _extract_xml_value(c, "Title")
                price_m = re.search(r"<TransactionPrice[^>]*>([\d.]+)</TransactionPrice>", c)
                price = price_m.group(1) if price_m else "?"
                buyer = _extract_xml_value(c, "BuyerUserID")
                item_id = _extract_xml_value(c, "ItemID")
                print(f"  {title[:40]:<40} A${price:>7}  buyer: {buyer}  #{item_id}")
        else:
            print("  (none)")
        print()

    # --- messages: show recent eBay messages ---

    elif args.command == "messages":
        auth_token = env.get("auth_token", "")
        if not auth_token:
            print("messages requires Auth'n'Auth token.", file=sys.stderr)
            sys.exit(1)

        from datetime import datetime, timedelta, timezone
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=args.days)
        body = f"""
  <FolderID>0</FolderID>
  <StartCreationTime>{start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}</StartCreationTime>
  <EndCreationTime>{end.strftime('%Y-%m-%dT%H:%M:%S.000Z')}</EndCreationTime>
  <DetailLevel>ReturnHeaders</DetailLevel>"""
        result = trading_api_call("GetMyMessages", body, auth_token, sandbox, "15")

        msgs = []
        for block in re.finditer(r"<Message>(.*?)</Message>", result, re.DOTALL):
            c = block.group(1)
            sender = _extract_xml_value(c, "Sender")
            subject = _extract_xml_value(c, "Subject")
            date = _extract_xml_value(c, "ReceiveDate")[:10]
            read = _extract_xml_value(c, "Read")
            item_title = _extract_xml_value(c, "ItemTitle")
            marker = "  " if read == "true" else "* "
            msgs.append((date, marker, sender, subject[:70], item_title))

        if msgs:
            print(f"Messages (last {args.days} days)  (* = unread)")
            print("-" * 90)
            for date, marker, sender, subject, item_title in msgs:
                print(f"{marker}{date}  {sender:<20} {subject}")
        else:
            print("No messages.")

    # --- find-category: live eBay API category search ---

    elif args.command == "find-category":
        query = " ".join(args.query)
        site_id = SITE_ID_MAP.get(args.marketplace, "15")
        auth_token = env.get("auth_token", "")
        if not auth_token:
            print("find-category requires Auth'n'Auth token.", file=sys.stderr)
            sys.exit(1)
        try:
            results = find_categories_online(
                query, auth_token, sandbox, site_id, parent_id=args.parent
            )
        except EbayApiError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
        if results:
            print(f"eBay {args.marketplace} categories matching '{query}':")
            for r in results[:20]:
                leaf = " (leaf)" if r.get("leaf") else ""
                print(f"  {r['id']:>8}  {r['name']}{leaf}")
        else:
            print(f"No categories found for '{query}' on {args.marketplace}.")

    # --- specifics: show required item specifics for a category ---

    elif args.command == "specifics":
        site_id = SITE_ID_MAP.get(args.marketplace, "15")
        auth_token = env.get("auth_token", "")
        if not auth_token:
            print("specifics requires Auth'n'Auth token.", file=sys.stderr)
            sys.exit(1)

        # First validate the category
        is_leaf, cat_name = validate_leaf_category(
            args.category_id, auth_token, sandbox, site_id
        )
        if cat_name:
            print(f"Category {args.category_id}: {cat_name}" + (" (leaf)" if is_leaf else " (NOT leaf — cannot list here)"))
        if not is_leaf:
            print("This category has subcategories. Use 'find-category' to find leaf categories.")
            # Show subcategories
            try:
                subs = find_categories_online("", auth_token, sandbox, site_id, parent_id=args.category_id)
                for s in subs[:20]:
                    leaf = " (leaf)" if s.get("leaf") else ""
                    print(f"  {s['id']:>8}  {s['name']}{leaf}")
            except EbayApiError:
                pass
            return

        # Show valid conditions
        print(f"\nValid conditions for category {args.category_id}:")
        conditions = get_valid_conditions(args.category_id, auth_token, sandbox, site_id)
        if conditions:
            for c in conditions:
                print(f"  {c['id']:>6}  {c['name']}")
        else:
            print("  (could not fetch — try using standard condition IDs)")

        # Try to fetch item specifics (may 503 if API is deprecated)
        try:
            specs = get_category_specifics(args.category_id, auth_token, sandbox, site_id)
            if specs:
                print(f"\nItem specifics for category {args.category_id}:")
                for s in specs:
                    req = "REQUIRED" if s["required"] else "optional"
                    vals = ", ".join(s["values"][:5]) if s["values"] else ""
                    if s["values"] and len(s["values"]) > 5:
                        vals += f" (+{len(s['values'])-5} more)"
                    print(f"  {req:10s} {s['name']}: {vals}")
        except EbayApiError:
            print("\n  (GetCategorySpecifics unavailable — this API may be deprecated)")
            print("  Tip: try listing with --preset and eBay will tell you what's missing.")

    # --- list / verify: create or dry-run a listing ---

    elif args.command in ("list", "verify"):
        is_verify = args.command == "verify"

        # Apply preset defaults (CLI args override preset values)
        if hasattr(args, "preset") and args.preset:
            preset = LISTING_PRESETS.get(args.preset)
            if not preset:
                print(f"Unknown preset: {args.preset}", file=sys.stderr)
                sys.exit(1)
            print(f"Applying preset '{args.preset}'...")
            if args.marketplace == "US" and "marketplace" in preset:
                args.marketplace = preset["marketplace"]
            if args.currency == "USD" and "currency" in preset:
                args.currency = preset["currency"]
            if not args.postcode and "postcode" in preset:
                args.postcode = preset["postcode"]
            if not args.location and "location" in preset:
                args.location = preset["location"]
            if not args.domestic_services and "domestic_services" in preset:
                args.domestic_services = None  # Will use preset below
            if preset.get("no_returns"):
                args.no_returns = True
            if preset.get("best_offer"):
                args.best_offer = True

        if env.get("mode") == "authnauth":
            auth_token = env["auth_token"]
            site_id = SITE_ID_MAP.get(args.marketplace, "0")

            if is_verify:
                print("Verifying listing (dry-run)...")
            else:
                print("Using Trading API (Auth'n'Auth)...")

            # Validate leaf category before uploading images
            if args.category:
                is_leaf, cat_name = validate_leaf_category(
                    args.category, auth_token, sandbox, site_id
                )
                if not is_leaf:
                    print(f"Error: Category {args.category} ({cat_name}) is NOT a leaf category.", file=sys.stderr)
                    print("Use 'find-category' or 'specifics' to find the right leaf category.", file=sys.stderr)
                    sys.exit(1)
                if cat_name:
                    print(f"Category: {args.category} ({cat_name})")

            # Upload local images if needed
            image_urls = resolve_images(args.images, auth_token, sandbox)

            # Parse item specifics from "Name=Value" pairs
            item_specifics = {}
            if args.specifics:
                for spec in args.specifics:
                    if "=" not in spec:
                        print(f"Invalid specific (use Name=Value): {spec}", file=sys.stderr)
                        sys.exit(1)
                    k, v = spec.split("=", 1)
                    item_specifics[k.strip()] = v.strip()

            # Parse domestic shipping: SERVICE[:COST|free]
            domestic_services = []
            if args.domestic_services:
                for ds in args.domestic_services:
                    parts = ds.split(":")
                    svc = {"service": parts[0]}
                    if len(parts) > 1:
                        if parts[1].lower() == "free":
                            svc["free"] = True
                        else:
                            svc["cost"] = float(parts[1])
                    domestic_services.append(svc)
            elif hasattr(args, "preset") and args.preset:
                # Use preset domestic services
                preset = LISTING_PRESETS.get(args.preset, {})
                domestic_services = preset.get("domestic_services", [])

            # Parse international shipping: SERVICE:COST[:SHIP_TO]
            international_services = []
            if args.intl_services:
                for ints in args.intl_services:
                    parts = ints.split(":")
                    svc = {"service": parts[0]}
                    if len(parts) > 1:
                        svc["cost"] = float(parts[1])
                    if len(parts) > 2:
                        svc["ship_to"] = parts[2]
                    international_services.append(svc)

            try:
                trading_add_fixed_price_item(
                    title=args.title,
                    description=args.description,
                    price=args.price,
                    condition=args.condition,
                    image_urls=image_urls,
                    quantity=args.quantity,
                    category_id=args.category,
                    currency=args.currency,
                    marketplace=args.marketplace,
                    auth_token=auth_token,
                    sandbox=sandbox,
                    draft=is_verify or args.draft,
                    shipping_type=args.shipping_type,
                    domestic_services=domestic_services or None,
                    international_services=international_services or None,
                    dispatch_days=args.dispatch_days,
                    ship_to_locations=args.ship_to,
                    package_type=args.package_type,
                    package_length=args.package_length,
                    package_width=args.package_width,
                    package_depth=args.package_depth,
                    weight_kg=args.weight,
                    returns_accepted=not args.no_returns,
                    return_days=args.return_days,
                    return_shipping_paid_by=args.return_paid_by,
                    item_specifics=item_specifics or None,
                    condition_description=args.condition_description,
                    postcode=args.postcode,
                    location=args.location,
                    best_offer=args.best_offer,
                    best_offer_min=args.best_offer_min,
                    best_offer_auto_accept=args.best_offer_auto_accept,
                    gallery_type="Plus" if args.gallery_plus else "",
                )
            except EbayApiError as e:
                print(f"\n{e}", file=sys.stderr)
                sys.exit(1)
        else:
            # Inventory API path (OAuth)
            try:
                sku = args.sku or f"CLAUDE-{uuid.uuid4().hex[:8].upper()}"
                marketplace = MARKETPLACES[args.marketplace]

                print(f"Using Inventory API (OAuth)...")
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
            except EbayApiError as e:
                print(f"\n{e}", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    main()
