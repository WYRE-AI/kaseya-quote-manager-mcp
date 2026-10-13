# Kaseya Quote Manager MCP Server

[![Build Status](https://github.com/WYRE-AI/kaseya-quote-manager-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/WYRE-AI/kaseya-quote-manager-mcp/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI
assistants **read-only** access to [Kaseya Quote Manager](https://help.quotemanager.kaseya.com/)
(Datto Commerce) — quotes, sales orders, purchasing, the product catalog, and customers.

> Maintained by [Wyre Technology](https://github.com/WYRE-AI).

## Quick Start

**Claude Desktop** — download, open, done:

1. Download `kaseya-quote-manager-mcp.mcpb` from the [latest release](https://github.com/WYRE-AI/kaseya-quote-manager-mcp/releases/latest)
2. Open the file (double-click or drag into Claude Desktop)
3. Enter your Kaseya Quote Manager **API Key** when prompted

**Claude Code (CLI):**

```bash
claude mcp add kaseya-quote-manager-mcp \
  -e KASEYA_QUOTE_MANAGER_API_KEY=your-api-key \
  -- npx -y github:WYRE-AI/kaseya-quote-manager-mcp
```

## Authentication

Quote Manager authenticates with a single **API key** sent in the `apiKey` header. Generate
one in Quote Manager under **Settings → API**.

Stdio and `AUTH_MODE=env` read `KASEYA_QUOTE_MANAGER_API_KEY`. The HTTP transport does not
start unless `CONDUIT_S2S_SECRET` is a real value. Known placeholders (`changeme`,
`change-me`, `secret`, `example`, `placeholder`, `replace-me`, `your-secret`,
`your-s2s-secret`, `s2s-secret`, `replace-with-a-real-secret`) are rejected, including when
`MCP_ALLOW_INSECURE_DEV=1` is set. The process never logs the secret.

### HTTP authentication

With `MCP_TRANSPORT=http` and a configured secret, every `/mcp` request must include
`X-Gateway-S2S`:

```
X-Gateway-S2S: t=<unix seconds>,v1=<64 lowercase hex chars>
```

`v1` is HMAC-SHA256 of the exact ASCII string `t=<unix seconds>` (the same prefix that
appears in the header), keyed with `CONDUIT_S2S_SECRET`, encoded as 64 lowercase hex
characters. The timestamp must be within 300 seconds of the server clock. A missing or
invalid header returns 401.

In `AUTH_MODE=gateway` (the container image and Compose default), `/mcp` also requires
`X-Kaseya-Quote-Manager-Api-Key`. That header is the only credential for the request. A
request without it returns 401 and does not fall back to `KASEYA_QUOTE_MANAGER_API_KEY`.

`/health` stays unauthenticated, does not require `X-Gateway-S2S`, and does not return the
API key. The stdio transport does not use `CONDUIT_S2S_SECRET`.

## Configuration

Copy [`.env.example`](.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `KASEYA_QUOTE_MANAGER_API_KEY` | For stdio and `AUTH_MODE=env` | Quote Manager API key. Gateway mode does not read this. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-Kaseya-Quote-Manager-Api-Key` on each `/mcp` request and never falls back to the environment variable. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is overridden and logged. A placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a secret is configured. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. Ignored in favor of `127.0.0.1` when the insecure-dev bypass is on. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. Defaults to `info`. |

## Features

- **Read-only by design** — the Quote Manager API exposes only `list`/`get`; no tool can
  mutate your data.
- **39 entity tools** across 5 domains, plus `kqm_navigate` / `kqm_status` discovery tools.
- **Decision-tree navigation** — call `kqm_navigate` to explore a domain's tools.
- **Rate limiting** — respects the API's 60 req/min limit, with retry on 429/5xx.
- **Dual transport** — stdio (local) and HTTP Streamable (gateway/Docker).
- **MCPB packaging** for one-click Claude Desktop install.

## Domains & tools

Tools are named `kqm_<entity>_list` and `kqm_<entity>_get`.

| Domain | Entities |
|--------|----------|
| `sales` | quote, quote_section, quote_line, sales_order, sales_order_line, sales_order_payment |
| `procurement` | purchase_order, purchase_order_line, purchase_order_cost, supplier, product_supplier |
| `catalog` | product, product_image (list only), category, brand |
| `crm` | customer, customer_address, contact |
| `org` | employee, warehouse |

`list` tools accept `page`, `pageSize` (max 100), and `modifiedAfter` where supported, plus
entity-specific filters (e.g. `quoteNumber`, `customerID`, `purchaseOrderID`).

## Usage example

```
kqm_navigate { "domain": "sales" }
kqm_quote_list { "page": 1, "pageSize": 50 }
kqm_quote_get { "id": 12345 }
kqm_quote_section_list { "quoteID": 12345 }
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to
`AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode
the API key arrives on each request as `X-Kaseya-Quote-Manager-Api-Key`. It is not read
from the environment.

```bash
docker build -t kaseya-quote-manager-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:8080:8080 \
  kaseya-quote-manager-mcp
# Health: curl localhost:8080/health
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`,
does not pass `KASEYA_QUOTE_MANAGER_API_KEY`, and publishes `127.0.0.1:8080:8080`.
A project `.env` is interpolation only — the gateway service has no `env_file`.

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses
`KASEYA_QUOTE_MANAGER_API_KEY`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_MODE=env \
  -e KASEYA_QUOTE_MANAGER_API_KEY=your-api-key \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -p 127.0.0.1:8080:8080 \
  kaseya-quote-manager-mcp
```

Local HTTP without a secret is development-only. It always binds `127.0.0.1` and logs a
warning. A non-loopback `MCP_HTTP_HOST` is overridden:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

Sign a gateway request with `X-Gateway-S2S` and the API key header. Build the header
first: `v1` is HMAC-SHA256 of the exact ASCII string `t=<unix seconds>` (no trailing
newline), keyed with `CONDUIT_S2S_SECRET`, as 64 lowercase hex characters.

```bash
: "${CONDUIT_S2S_SECRET:?Set CONDUIT_S2S_SECRET to the server secret}"
: "${KASEYA_QUOTE_MANAGER_API_KEY:?Set KASEYA_QUOTE_MANAGER_API_KEY to the Quote Manager API key}"
timestamp="$(date +%s)"
digest="$(
  printf 't=%s' "$timestamp" |
    openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" |
    awk '{print $NF}' |
    tr '[:upper:]' '[:lower:]'
)"
X_GATEWAY_S2S="t=${timestamp},v1=${digest}"

curl -sS http://127.0.0.1:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-gateway-s2s: ${X_GATEWAY_S2S}" \
  -H "x-kaseya-quote-manager-api-key: ${KASEYA_QUOTE_MANAGER_API_KEY}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kqm_status","arguments":{}}}'
```

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

Apache-2.0 © WYRE Technology
