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

Stdio and HTTP `AUTH_MODE=env` read `KASEYA_QUOTE_MANAGER_API_KEY`. The HTTP transport does
not start unless `CONDUIT_S2S_SECRET` is a real value of **at least 32 characters**
(`openssl rand -hex 32`). Known placeholders (`changeme`, `change-me`, `secret`, `example`,
`placeholder`, `replace-me`, `your-secret`, `your-s2s-secret`, `s2s-secret`,
`replace-with-a-real-secret`) are rejected, including when `MCP_ALLOW_INSECURE_DEV=1` is
set. `MCP_ALLOW_INSECURE_DEV` itself is refused unless `NODE_ENV=development`. The process
never logs the secret.

### Auth mode (HTTP)

`AUTH_MODE` is read when the HTTP server starts:

| Value | Behavior |
|-------|----------|
| unset or empty (after trimming) | `gateway` |
| `gateway` | Every `/mcp` request must carry `X-Kaseya-Quote-Manager-Api-Key`. The environment variable is never read. |
| `env` | Tools use `KASEYA_QUOTE_MANAGER_API_KEY` from the process environment. |
| anything else (`Gateway`, `ENV`, `standalone`, …) | The server logs an error and exits non-zero. Only the exact values `gateway` and `env` are accepted. |

Stdio ignores `AUTH_MODE` and reads `KASEYA_QUOTE_MANAGER_API_KEY`.

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

In `AUTH_MODE=gateway` (the default, and the container image and Compose setting), `/mcp`
also requires `X-Kaseya-Quote-Manager-Api-Key`. That header is the only credential for the
request. A request without it returns 401 and does not fall back to
`KASEYA_QUOTE_MANAGER_API_KEY`.

**Request body cap.** After the S2S check, a request whose `Content-Length` is over
256 KiB (262144 bytes) gets `413` with the JSON-RPC error
`{"jsonrpc":"2.0","error":{"code":-32600,"message":"Request body exceeds 262144 bytes"},"id":null}`.
The transport enforces the same cap on chunked bodies. An unauthenticated oversize request
still gets `401`.

`/health` stays unauthenticated, does not require `X-Gateway-S2S`, and does not return the
API key. Its `configured` flag is a presence check that is only ever true in `env` mode. The
stdio transport does not use `CONDUIT_S2S_SECRET`.

## Tool call hardening

- **Strict inputs.** Every tool schema has `additionalProperties: false`. IDs (`id`,
  `quoteID`, `salesOrderID`, …) are integers of at least 1, `page` is at least 1, `pageSize`
  is 1–100, and strings have a `maxLength`. A call is checked before it runs; an unknown
  argument, a missing required argument, or a bad value returns a fixed message that names
  the schema property and never echoes what you sent. Tool input with more than 10,000
  values is refused.
- **Untrusted content envelope.** Quote titles, notes, customer and contact names, addresses
  and delivery instructions are written by customers and staff. Every successful result is
  wrapped as `<untrusted-content nonce="…">…</untrusted-content nonce="…">` with a notice not
  to follow instructions inside it. Forged `untrusted-content` markers in the data are
  defanged; nothing else is changed (no HTML escaping).
- **100 KB response cap.** Output over 100 KB is cut on a character boundary and ends with
  `[TRUNCATED: the result was larger than 100 KB, so the rest was cut. Ask for less: a smaller pageSize, top or record limit, a later page, or narrower filters such as modifiedAfter. For a *_get_full tool, read the child records with their list tools instead.]`
  inside the envelope.
- **Fixed error text.** Errors are short fixed sentences (for example "Quote Manager
  rejected the API key."). Upstream bodies, URLs and your arguments are never returned or
  logged.

## Rate budget

Quote Manager allows **60 requests a minute and 10,000 a day** per API key, shared with every
other integration using that key. The server limits itself to 60 a minute. It does not
count the daily total, so plan for it: a few report runs a day is fine, a loop is not.

Report tools take `maxCalls` (1–500, default **60**). Every Quote Manager request a report
makes counts as one call, and the report stops and returns partial results when the budget
is spent. Reports make sequential requests with a single client, so the per-minute limiter
applies across the run, and use one retry at most so they fail fast. Roughly:

| Report | Calls |
|--------|-------|
| `kqm_pipeline_summary` (50 quotes) | 1 + 50 + one per selected section (about 100–150), plus one per distinct product with `includeCost` |
| `kqm_quote_conversion_funnel` (500 quotes) | 5 pages, plus one per converted quote with `useOrderDate` |
| `kqm_sales_order_margin_report` (50 orders) | 1 + 50 |
| `kqm_customer_spend_summary` (100 orders) | 1 + 2 per order scanned for the customer (about 201) |
| `kqm_product_velocity_report` (2,000 lines) | 20 line pages, then order pages with `includeCustomers` from the calls left over |
| `kqm_purchase_vs_sales_reconciliation` | 1 + purchase order pages + one per matching purchase order |

The default of 60 calls is small on purpose: bigger runs return `partial: true` with a
`partialReason` instead of spending your daily allowance. Raise `maxCalls` or narrow with `modifiedAfter` and the per-report limits to fit. See
[docs/REPORTS.md](docs/REPORTS.md) for the exact formulas.

## Configuration

Copy [`.env.example`](.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `KASEYA_QUOTE_MANAGER_API_KEY` | For stdio and `AUTH_MODE=env` | Quote Manager API key. Gateway mode does not read this. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | HTTP only. Unset or empty means `gateway`. Exactly `gateway` or `env`; any other value refuses to start. Gateway mode requires `X-Kaseya-Quote-Manager-Api-Key` on each `/mcp` request and never reads the environment variable. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret, at least 32 characters. The HTTP server logs an error and exits non-zero when this is empty, shorter than 32 characters, or a known placeholder. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development, and only with `NODE_ENV=development` (any other `NODE_ENV` refuses to start), to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is overridden and logged. A placeholder or short secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a secret is configured. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. Ignored in favor of `127.0.0.1` when the insecure-dev bypass is on. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. Defaults to `info`. |

## Features

- **Read-only by design** — the Quote Manager API exposes only `list`/`get`; no tool can
  mutate your data.
- **39 entity tools** across 5 domains, plus 3 `*_get_full` convenience tools, 6 read-only
  report tools, and `kqm_navigate` / `kqm_status` discovery tools.
- **Hardened tool calls** — strict input schemas, untrusted-content envelope, 100 KB response
  cap, fixed error messages. See [Tool call hardening](#tool-call-hardening).
- **Decision-tree navigation** — call `kqm_navigate` to explore a domain's tools.
- **Rate limiting** — respects the API's 60 req/min limit, with retry on 429/5xx, and
  call budgets on every report. See [Rate budget](#rate-budget).
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
| `reports` | the 6 report tools below |

`list` tools accept `page`, `pageSize` (max 100), and `modifiedAfter` where supported, plus
entity-specific filters (e.g. `quoteNumber`, `customerID`, `purchaseOrderID`).

Convenience tools that make several requests and return nested records (inputs: `id`,
`maxCalls`, default 60; partial results when the budget runs out):

- `kqm_quote_get_full` (`sales`) — quote, its sections, and each section's lines.
- `kqm_sales_order_get_full` (`sales`) — sales order, lines, and payments.
- `kqm_purchase_order_get_full` (`procurement`) — purchase order, lines, and costs.

## Reports

Read-only tools in the `reports` domain. Each takes `maxCalls` (default 60, max 500) and
returns `partial`, `partialReason`, `callsUsed`, `method`, and `generatedAt` alongside its
numbers. Money is rounded to 2 decimals; totals are before tax and discounts and exclude
delivery unless stated. Several figures are inferred from fields Quote Manager does not
document, and each report's `method` says which. Full details: [docs/REPORTS.md](docs/REPORTS.md).

| Tool | What it answers |
|------|-----------------|
| `kqm_pipeline_summary` | Quote count, value and (optionally) estimated cost and margin by raw status code |
| `kqm_quote_conversion_funnel` | Conversion rate, inferred win rate, expired unconverted quotes, average days to close |
| `kqm_sales_order_margin_report` | Revenue, cost and margin per sales order, from line price and cost |
| `kqm_customer_spend_summary` | Revenue, cost, payments and estimated outstanding by customer, top N |
| `kqm_product_velocity_report` | Best-selling products by units and revenue, with distinct orders and customers |
| `kqm_purchase_vs_sales_reconciliation` | For one sales order: sold vs purchased vs received, by product |

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

Generate the secret once, export it, and reuse it for the server and for signing requests.
`-e CONDUIT_S2S_SECRET` (name only) passes the exported value without putting it in the
`docker` command line.

```bash
export CONDUIT_S2S_SECRET="$(openssl rand -hex 32)"
docker build -t kaseya-quote-manager-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET \
  -p 127.0.0.1:8080:8080 \
  kaseya-quote-manager-mcp
# Health: curl localhost:8080/health
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`,
does not pass `KASEYA_QUOTE_MANAGER_API_KEY`, and publishes `127.0.0.1:8080:8080`.
A project `.env` is interpolation only — the gateway service has no `env_file`.

```bash
# Reuses the CONDUIT_S2S_SECRET exported above.
docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses
`KASEYA_QUOTE_MANAGER_API_KEY`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET \
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
newline), keyed with `CONDUIT_S2S_SECRET`, as 64 lowercase hex characters. Use the same
exported `CONDUIT_S2S_SECRET` the server was started with.

> `openssl dgst -hmac` takes the key as a process argument, so other local users can see it
> in the process list while it runs. Only run this example on a trusted single-user machine;
> elsewhere, sign requests from code that reads the secret from the environment.

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
