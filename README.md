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
one in Quote Manager under **Settings → API**. Set it as `KASEYA_QUOTE_MANAGER_API_KEY`.

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

```bash
docker build -t kaseya-quote-manager-mcp .
docker run --rm -p 8080:8080 \
  -e MCP_TRANSPORT=http \
  -e KASEYA_QUOTE_MANAGER_API_KEY=your-api-key \
  kaseya-quote-manager-mcp
# Health: curl localhost:8080/health
```

In the WYRE MCP Gateway the image runs with `AUTH_MODE=gateway`; the gateway injects the
key as the `x-kaseya-quote-manager-api-key` header per request.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

Apache-2.0 © WYRE Technology
