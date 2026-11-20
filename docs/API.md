# Using the shortener from another service (e.g. vrumvrum)

Base URL: `https://vv1.eu/_/api` · machine-readable spec: `GET /_/api/openapi.json`

## 1. Get a key

In the admin UI → **API keys**, create a key for the service:

- scopes: `links:read`, `links:write`, `stats:read`
- owner prefix: `vrumvrum:` — the key can then only create, see and count links whose
  `owner` starts with `vrumvrum:`
- namespaces (optional): `vv1.eu`

Store it as a server-side secret (e.g. `SHORTENER_API_KEY`). Never ship it to browsers or apps.

```
Authorization: Bearer sk_live_…
```

## 2. Create a link for something in your app

Use `external_id` (your own id) so retries never create duplicates: the same `owner` +
`external_id` returns the existing link with `200` and `"existed": true`.

```sh
curl -sX POST https://vv1.eu/_/api/links \
  -H "Authorization: Bearer $SHORTENER_API_KEY" -H 'content-type: application/json' \
  -d '{
    "namespace": "vv1.eu",
    "target_url": "https://vrumvrum.ro/anunt/123",
    "owner": "vrumvrum:garage:42",
    "external_id": "listing:123",
    "title": "Dacia Logan 2019",
    "tags": ["listing"],
    "utm": { "utm_source": "qr", "utm_medium": "print" },
    "append_utm": true,
    "metadata": { "listing_id": 123, "garage_id": 42 }
  }'
```

Response (`201`):

```json
{
  "id": "…", "namespace": "vv1.eu", "code": "A7K2",
  "short_url": "https://vv1.eu/A7K2",
  "qr": { "svg": "https://vv1.eu/_/qr/A7K2.svg", "png": "https://vv1.eu/_/qr/A7K2.png", "payload": "HTTPS://VV1.EU/A7K2" },
  "owner": "vrumvrum:garage:42", "external_id": "listing:123", "metadata": { "listing_id": 123, "garage_id": 42 },
  "status": "active", "version": 1
}
```

Up to 500 at once, all or nothing: `POST /links/bulk` with `{ "items": [ … ] }`.

## 3. Show the QR code

The QR URLs are public and edge-cached, so they can go straight into an `<img>` or a PDF:

```
https://vv1.eu/_/qr/A7K2.svg?size=512&ecc=M&margin=4&fg=111111&bg=ffffff
https://vv1.eu/_/qr/A7K2.png?size=1024&ecc=H        # print / stickers
```

## 4. Find, change, pause

```
GET    /links/by-external/listing:123?owner=vrumvrum:garage:42
GET    /links?owner=vrumvrum:garage:42&tag=listing&limit=50&cursor=…
PATCH  /links/vv1.eu/A7K2   { "target_url": "…", "metadata": { … } }
PATCH  /links/vv1.eu/A7K2   { "status": "paused" }      # stops redirecting within ~60 s
DELETE /links/vv1.eu/A7K2                               # archive; code never reused
```

## 5. Tracking

Every scan/click is logged (country, city, device, OS, browser, referrer host, bot flag).

```
GET /links/vv1.eu/A7K2/stats?from=2026-11-01&to=2026-11-30         # per day
GET /links/vv1.eu/A7K2/stats?interval=hour                          # live hours
GET /links/vv1.eu/A7K2/clicks?limit=100&cursor=…                    # raw rows, no hashes
GET /stats/overview?owner=vrumvrum:garage:42&from=…&to=…&top=20     # dashboard for one garage
```

`overview` returns `totals` (human clicks, daily uniques, bots, unknown codes, requests),
a per-day `series`, `outcomes`, `top` links and `breakdowns` by country, city, device, os,
browser and referrer. Days up to yesterday come from rollups; today is counted live.

## Errors

JSON `{ "error": "…", "detail": … }` with `400` (validation), `401` (key), `403` (scope or
owner/namespace restriction), `404`, `409` (code taken / archived). Responses are never cached.
