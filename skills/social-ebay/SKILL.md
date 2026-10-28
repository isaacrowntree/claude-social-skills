---
name: social-ebay
description: eBay: every REST and GraphQL operation eBay publishes, generated from its specs. Use the `social` CLI (Bun) for every eBay action: find operations with `social ebay ops`, read them with `social ebay describe`, run them with `social ebay call`; prefer this CLI over raw API calls in all cases.
---

# social ebay

eBay: every REST and GraphQL operation eBay publishes (listings, orders, offers, messages, returns, media, finances…), generated from its specs.

**Run:** `social ebay <command>` (installed via `bun link` in this repo, or `bun run /path/to/claude-social-skills/src/cli.ts ebay …`). Add `--dry-run` before any command to print the request instead of sending it.

## Credentials

- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME`

EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (developer.ebay.com/my/keys) give app-token operations. Add EBAY_RUNAME (accept URL https://localhost:8888/callback, OAuth enabled) and run `social auth login ebay` once for seller operations; the refresh token lasts ~18 months. EBAY_AUTH_TOKEN (Auth'n'Auth) only for `social ebay trading`. EBAY_MARKETPLACE (default EBAY_AU), EBAY_SANDBOX=1 optional.

Check what is present with `social auth status ebay`; store a value with `social auth set ebay <KEY> <value>` (OS keyring, else `~/.config/social/.env`); run the interactive flow with `social auth login ebay`. Docs: https://developer.ebay.com/develop/api

## API description this wrapper is built from

openapi: developer.ebay.com/develop/api/spec/<api>.json (29 REST APIs) + listing.graphqls (GraphQL); pinned in spec-pins.json. Refresh with `social specs pull ebay`; CI fails if upstream changes.

## Commands

Every command accepts `--json` (raw JSON) and `--jq <expr>` (filter the JSON with jq).

### `social ebay apis`

the ebay API groups and how many operations each has

### `social ebay ops [filter]...`

search operations: every word must appear in the id, summary, path, description or field names; best matches first

```
  --api <name>               only this API group (see `social ebay apis`)
```

### `social ebay describe <op>`

parameters, body, scopes and response shape of one operation

```
  --depth <n>                how deep to expand nested fields (default 2)
  --path <input.x.y>         GraphQL: show one nested input type, e.g. input.listingTerms
```

### `social ebay call <op>`

call any operation by id; --dry-run prints the request instead

```
  -p, --param <k=v>          path/query/header parameter (default [])
  -f, --field <k=v>          body field, typed (numbers, booleans, null, JSON literals) (default [])
  --raw-field <k=v>          body field, always a string (default [])
  --file <field=path>        file for a multipart part (image=./photo.jpg) or a binary body (default [])
  --output <file>            save a binary response (PDF, image, feed file) here
  --input <file>             request body from a JSON file (- for stdin)
  -a, --arg <k=json>         GraphQL: argument as JSON (e.g. -a input='{"listingId":"1"}'); --input takes the whole arguments object (default [])
  --select <fields>          GraphQL: selection set to return instead of the default
  --depth <n>                GraphQL: depth of the default selection (default "3")
  --print-query              GraphQL: print the generated document and variables, then exit
```

### `social ebay gql <query>`

run a GraphQL document against eBay (a string, @file.graphql, or - for stdin); document and variables are checked against the schema first

```
  -v, --var <k=json>         variable, JSON-typed (default [])
  --variables <file>         variables object from a JSON file
  --operation <name>         which operation to run when the document has several
```

### `social ebay trading <callName>`

legacy Trading API call with an XML body (Auth'n'Auth), for what the modern APIs lack (e.g. WatchCount)

```
  --body <xml>               XML body inside the <CallName>Request element (default "")
  --input <file>             read the XML body from a file or - for stdin
  --site <id>                eBay site id (default from EBAY_MARKETPLACE)
```

### `social ebay me`

the signed-in seller (identity.getUser), or an app-credentials check when not signed in

## Anything else

Every operation in eBay's specs is a `social ebay call <id>` away, with the right host, token and auth scheme; search with `social ebay ops <words>` before concluding something is unsupported. For an endpoint missing from the specs, `social api ebay <path>` sends the user token to api.ebay.com, or to a full `https://….ebay.com/…` URL (eBay hosts only). The legacy Trading API is `social ebay trading <Call>`.

## Generated operations

496 operations from eBay's published specs. `social ebay ops --api <api>` lists an API's operations.

| api | ops | spec |
|---|---|---|
| `account_v1` | 37 | Account v1 API |
| `account_v2` | 14 | Account v2 API |
| `analytics` | 4 | Analytics API |
| `browse` | 7 | searchapi_openapi Browse API OAS Baseline |
| `catalog` | 2 | Catalog API |
| `charity` | 2 | Charity API |
| `developer_analytics` | 2 | Analytics API |
| `edelivery_international_shipping` | 28 | EDIS public shipping API |
| `feed` | 23 | Feed API |
| `feedback` | 5 | Feedback API |
| `finances` | 11 | Finances API |
| `fulfillment` | 15 | Fulfillment API |
| `identity` | 1 | Identity API |
| `inventory` | 36 | Inventory API |
| `key_management` | 3 | Key Management API |
| `leads` | 2 | Classified Leads API |
| `logistics` | 6 | Logistics API |
| `marketing` | 84 | Marketing API |
| `media` | 13 | Media API |
| `message` | 5 | M2M Public API Service |
| `metadata` | 28 | Metadata API |
| `negotiation` | 2 | Negotiation API |
| `notification` | 21 | Notification API |
| `post_order` | 38 | Post-Order API |
| `recommendation` | 1 | Recommendation API |
| `stores` | 8 | Stores API |
| `taxonomy` | 9 | Taxonomy API |
| `translation` | 1 | Translation API |
| `vero_v2` | 5 | VeRO Public API's |
| `gql` | 83 | eBay GraphQL (Listing, offers, orders, returns, inquiries…) |

## How to work with eBay here

Every operation eBay publishes is callable by id; nothing needs a wrapper. Find it, read it, call it:

```bash
social ebay ops update price                # every word must match the id, summary, description or field names
social ebay ops --api gql offer             # one API only (`social ebay apis` lists them)
social ebay describe fulfillment.getOrders  # parameters, body fields, scopes, response shape
social ebay describe gql.updateListing      # required fields first; --path input.listingTerms drills in, --depth N expands
social ebay call fulfillment.getOrders -p limit=5 --jq '.orders[].orderId'
```

- REST: `-p name=value` for path/query/header parameters, `-f key=value` / `--input body.json` for the body, `--file field=path` for uploads, `--output file` for binary answers (shipping-label PDFs, feed files). Host, token (user or app) and auth scheme come from the spec.
- GraphQL (`gql.*`): `-a input='{…}'` (JSON) or `--input args.json`. Arguments are checked against the schema before anything is sent, and the error names the missing or unknown field. A selection is generated (`--depth`, default 3) without the fields your sign-in can't read; `--select '…'` picks fields yourself (keep `__typename` in unions, or an error result reads as `{}`), and `--print-query` shows the document. `social ebay gql '<document>'` runs hand-written GraphQL.
- A GraphQL answer with partial errors still prints its data, reports each error (with its field path) on stderr, and exits 1.
- `--dry-run` (before `ebay`) prints the request instead of sending it: every mutating REST call and every GraphQL request (queries too, since GraphQL is always POST). For listings, prefer eBay's own `options.operationMode: VALIDATE`, which checks everything and reports fees without creating anything.
- Item ids, legacy `ItemID`s and GraphQL `listingId`s are the same number for single-SKU listings.
- Specs are pulled on first use (`social specs pull ebay`).

## Recipes

Each flow below was run against a live AU seller account.

**Who am I / is auth working:** `social ebay me`

**Orders awaiting dispatch** (prints nothing when there are none):
```bash
social ebay call fulfillment.getOrders -p filter='orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}' \
  --jq '.orders[] | {orderId, buyer: .buyer.username, total: .pricingSummary.total.value, items: [.lineItems[].title]}'
```

**Active listings with titles and prices.** The search returns ids, 5 per page (`pagination.nextCursor` for more; `trading GetMyeBaySelling` below lists all at once); `sellerListings` takes one listing per call:
```bash
social ebay call gql.sellerListingSearch --jq '.data.sellerListingSearch.activeListings.listings[].listingId'
social ebay call gql.sellerListings -a input='{"listings":[{"listingId":"287564987884"}]}' \
  --select '... on ListingsSuccess { listings { __typename ... on ListingSuccess { listing { listingId sellerProduct { title } items { itemTerms { pricingTerms { fixedPrice { original { value currency } } } availability { quantityAvailable } } } } } } }' \
  --jq '.data.sellerListings.listings[0].listing | {id: .listingId, title: .sellerProduct.title, price: .items[0].itemTerms.pricingTerms.fixedPrice.original.value}'
```

**Buyer messages:** `social ebay call message.getConversations -p conversation_type=FROM_MEMBERS -p limit=10` lists conversations with only their latest message; `message.getConversation -p conversation_id=… -p conversation_type=FROM_MEMBERS` has the whole thread, and `describe message.sendMessage` shows how to reply.

**Best Offers:** `social ebay call gql.sellerNegotiationHistory -a input='{}'` lists pending offers (latest per negotiation; `{"filters":{"statusFilter":"ALL"}}` for history). Answer with `gql.acceptOffer`, `gql.counterOffer` or `gql.declineOffer` (describe each first).

**Send an offer to watchers** (seller-initiated; eBay picks who is eligible, and counter-offers must be off):
```bash
social ebay call negotiation.findEligibleItems --jq '.eligibleItems[].listingId'
echo '{"allowCounterOffer":false,"offerDuration":{"unit":"DAY","value":2},"message":"…","offeredItems":[{"listingId":"…","price":{"currency":"AUD","value":"158.00"},"quantity":1}]}' \
  | social ebay call negotiation.sendOfferToInterestedBuyers --input -
```

**Price, postage, Best Offer and title in one change** (validate, then the same file with EXECUTE): `gql.updateListing` with `listingItems.items[0].itemTerms.pricingTerms.fixedPrice`, `listingTerms.bestOfferTerms.{autoAcceptThreshold,autoDeclineThreshold}`, `listingTerms.fulfillmentTerms.shippingTerms.shippingServices[{shippingServiceCode,shippingCost,rank}]` and `product.title`.

**Promote listings** (pay a % only on sales): `marketing.createCampaign` with `{"fundingStrategy":{"fundingModel":"COST_PER_SALE","adRateStrategy":"FIXED","bidPercentage":"3.0"},…}`, then `marketing.bulkCreateAdsByListingId -p campaign_id=…` with `{"requests":[{"listingId":"…","bidPercentage":"3.0"}]}`.

**Photos for a listing** (replaces the retired Trading UploadSiteHostedPictures):
```bash
social ebay call media.createImageFromFile --file image=./photo.jpg --jq .imageUrl
```

**Category and required item specifics** (marketplace AU is category tree 15):
```bash
social ebay call taxonomy.getCategorySuggestions -p category_tree_id=15 -p q='bar stool' --jq '.categorySuggestions[0:3][] | .category'
social ebay call taxonomy.getItemAspectsForCategory -p category_tree_id=15 -p category_id=103431 \
  --jq '[.aspects[] | select(.aspectConstraint.aspectRequired) | .localizedAspectName]'
```

**Create a listing:** write the arguments, validate, read the violations, fix, then send the same file with `"operationMode": "EXECUTE"`. `idempotencyKey` must be 32 hex characters (`openssl rand -hex 16`); reuse it on a retry so eBay never makes a duplicate.
```json
{ "input": {
  "idempotencyKey": "<openssl rand -hex 16>", "marketplace": "EBAY_AU", "options": { "operationMode": "VALIDATE" },
  "product": {
    "title": "…", "description": "<p>…</p>", "imageUrls": ["<imageUrl from media.createImageFromFile>"],
    "categories": { "primaryCategoryId": "103431" },
    "itemCondition": { "conditionId": "3000", "conditionDescription": "Light wear." },
    "aspects": [{ "name": "Brand", "values": ["Unbranded"] }, { "name": "Colour", "values": ["Black"] }]
  },
  "listingItems": { "items": [{ "itemTerms": { "availability": { "quantityAvailable": 1 }, "pricingTerms": { "fixedPrice": "35.00" } } }] },
  "listingTerms": {
    "listingFormat": "FIXED_PRICE", "lifecycleTerms": { "listingDurationInDays": "GTC" },
    "itemLocation": { "country": "AU", "postalCode": "2000", "location": "Sydney, NSW" },
    "bestOfferTerms": { "bestOfferEnabled": true },
    "fulfillmentTerms": { "shippingTerms": { "handlingTimeDuration": "DAYS_3", "marketplaceShippingOptions": { "costType": "FLAT" },
      "shippingServices": [{ "shippingServiceCode": "AU_Regular", "shippingCost": "20.00", "rank": 1 }, { "shippingServiceCode": "AU_Pickup", "shippingCost": "0", "rank": 2 }] } },
    "returnTerms": { "domesticReturnTerms": { "returnAccepted": false } }
  } } }
```
```bash
social ebay call gql.createListing --input listing.json \
  --jq '.data.createListing | {type: .__typename, violations: [.violations[]? | "\(.violationDescription) \(.additionalInformation | map(.value) | join(", "))"], listing}'
```
Local pickup alone is rejected ("Marketplace delivery is required in addition to local pickup"); each missing required aspect is its own violation, named in `additionalInformation`.

**Change, end or relist a listing:** `gql.updateListing` (needs `marketplace` as well as the listing; takes the same `options.operationMode: VALIDATE`), `gql.endListing`, `gql.relistListing`. Run `describe` first: its "required fields" list is the minimum input.

**Returns, cancellations, inquiries, cases:** `social ebay ops --api post_order` (Post-Order sends the OAuth token as `IAF`, handled for you), or GraphQL `gql.sellerOrderReturns` / `gql.sellerOrderInquiries`, which need search filters (describe them first).

**Views and impressions per listing** (dates are US time, so end the range a day or two back; eBay returns the metrics in its own order, so map them from the header):
```bash
social ebay call analytics.getTrafficReport -p dimension=LISTING -p metric=LISTING_VIEWS_TOTAL,LISTING_IMPRESSION_TOTAL \
  -p filter="marketplace_ids:{EBAY_AU},date_range:[20260926..20261026]" \
  --jq '(.header.metrics | map(.key)) as $m | .records[] | {id: .dimensionValues[0].value, ($m[0]): .metricValues[0].value, ($m[1]): .metricValues[1].value}'
```

**Money:** `finances.getPayouts`, `finances.getTransactions` (`-p limit=…`).

**Legacy Trading API**, for what the modern APIs lack, such as watcher counts (needs EBAY_AUTH_TOKEN):
```bash
social ebay trading GetMyeBaySelling --body '<ActiveList><Include>true</Include></ActiveList><DetailLevel>ReturnAll</DetailLevel>' | grep -oE '<(ItemID|WatchCount)>[^<]+'
```

**Scopes:** a field or operation your sign-in lacks the scope for answers "Insufficient permissions". The sign-in requests every scope the app is granted; after that list changes, run `social auth login ebay` again.

## Behaviour

- Retries 502/503/504 on idempotent methods (3 attempts, 250 ms then 1 s); waits once on 429 up to 90 s.
- Errors print `HTTP <status> <method> <url>` and the response body, exit code 1.
- `--dry-run` prints the method, URL and body of any mutating call and sends nothing.
- `social doctor` makes one cheap authenticated read per configured platform.
