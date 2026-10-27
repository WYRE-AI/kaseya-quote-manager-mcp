# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Six read-only report tools in a new `reports` domain: `kqm_pipeline_summary`,
  `kqm_quote_conversion_funnel`, `kqm_sales_order_margin_report`,
  `kqm_customer_spend_summary`, `kqm_product_velocity_report`, and
  `kqm_purchase_vs_sales_reconciliation`. Each has a `maxCalls` budget (default 60, max 500),
  returns `partial`/`partialReason`/`callsUsed`/`method`, and degrades to partial results on
  rate limits. See `docs/REPORTS.md`.
- `kqm_quote_get_full`, `kqm_sales_order_get_full`, and `kqm_purchase_order_get_full`
  convenience tools.
- Untrusted-content envelope around every successful tool result, a 100 KB response cap with a
  truncation note, and strict tool input schemas (`additionalProperties: false`, integer IDs of
  at least 1, bounded `pageSize` and string lengths) with runtime validation that never echoes
  caller values.

### Changed

- HTTP `AUTH_MODE` now defaults to `gateway` when unset or empty, and only the exact values
  `gateway` and `env` are accepted; anything else refuses to start. Gateway mode never reads
  `KASEYA_QUOTE_MANAGER_API_KEY`.
- Tool errors are fixed, caller-safe messages. Upstream bodies, URLs, arguments and IDs are no
  longer returned or logged.
- `.github/workflows/release.yml` is now `workflow_dispatch` only until the next publish is approved.

### Security

- `CONDUIT_S2S_SECRET` must be at least 32 characters, and `MCP_ALLOW_INSECURE_DEV` is refused
  unless `NODE_ENV=development`.
- `/mcp` rejects bodies over 256 KiB with 413 (after the S2S check) and caps chunked bodies in
  the transport. Tool input over 10,000 values is refused.
- HTTP request failures return a fixed 500 and no longer log the error object.

### Removed

- Unused `src/elicitation/forms.ts`.

## Initial release

### Added

- Initial release of the Kaseya Quote Manager (Datto Commerce) MCP server.
- Read-only access to all 20 Quote Manager resources via 39 entity tools, grouped into
  5 navigable domains: `sales`, `procurement`, `catalog`, `crm`, and `org`.
- `kqm_navigate` and `kqm_status` discovery tools.
- Pre-baked prompts: `quote-pipeline-review`, `quote-detail`, `purchasing-summary`.
- stdio and HTTP Streamable transports; gateway mode with `x-kaseya-quote-manager-api-key`
  header injection.
- Built on `@wyre-technology/node-kaseya-quote-manager`.

### Security

- HTTP MCP fails closed when `CONDUIT_S2S_SECRET` is empty or a known placeholder
  (CWE-306). `/mcp` requires `X-Gateway-S2S` (`t=<unix seconds>,v1=<hmac-sha256 hex>`).
  `AUTH_MODE=gateway` requires `X-Kaseya-Quote-Manager-Api-Key` on each request and does
  not fall back to `KASEYA_QUOTE_MANAGER_API_KEY`. `MCP_ALLOW_INSECURE_DEV=1` is local
  development only, skips S2S checks, and binds `127.0.0.1`. Docker and Compose publish
  the port on loopback and require the S2S secret; the gateway service has no static API key.

### Fixed

- **`kqm_status` and the unknown-tool error advised calling `kqm_navigate` to
  discover tools without qualification (and `kqm_status` claimed "all tools
  available").** Conduit suppresses `*_navigate` / `*_back` at the gateway
  (tier filtering lives in the grant resolver, which the container cannot
  see) and replaces them with `conduit__my_access`, so that advice pointed
  callers behind the gateway at a tool that returns method-not-found. Both
  strings now point to `conduit__my_access` for gateway callers and keep
  `kqm_navigate` as the standalone-mode discovery path. The tool itself is
  unchanged. (WYRE-AI/conduit#1236)

### Tests

- Handler-level unit tests for all 5 domain modules (`sales`, `procurement`, `catalog`,
  `crm`, `org`), covering all 39 entity tools. Each test mocks the underlying
  `KaseyaQuoteManagerClient` and invokes the exported `handleCall` directly, asserting
  both the outbound request shape (method + mapped params/id) and the response
  transformation, plus the unknown-tool and rejected-API-call paths. Domain handler
  files (`src/domains/{sales,procurement,catalog,crm,org}.ts`) go from ~5-10% to 100%
  statement coverage.
