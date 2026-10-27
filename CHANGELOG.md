# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Six read-only report tools in a new `reports` domain: `kqm_pipeline_summary`,
  `kqm_quote_conversion_funnel`, `kqm_sales_order_margin_report`,
  `kqm_customer_spend_summary`, `kqm_product_velocity_report`, and
  `kqm_purchase_vs_sales_reconciliation`. Each has a `maxCalls` budget (default 60, max 120),
  returns `partial`/`partialReason`/`callsUsed`/`method`, and degrades to partial results on
  rate limits, a 75-second time limit and client cancellation. See `docs/REPORTS.md`.
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
- Reports and `*_get_full` tools make one HTTP attempt per call (`maxRetries: 0`), so
  `maxCalls` is a true request budget. The `maxCalls` maximum is 120 (was 500 in the first
  draft of the reports).
- Reports and `*_get_full` tools stop at a 75-second deadline or when the client cancels, and
  return a partial result with the reason (`*_get_full` returns an error if it stops before
  the main record is read). The MCP request signal now reaches the report and entity handlers.
- One sliding-window rate limiter per API key (60 a minute, keyed by a hash of the key, at most
  10,000 keys) is shared by every report, `*_get_full` and list/get request. A key is tracked only
  after a successful response. At the cap the least recently used idle key is dropped; if every
  key is busy, the new key gets a temporary limiter for that call or run and nobody's window is
  reset. Requests are never refused by the limiter.
- Minimum Node is now 22.12.0 (the SDK 1.0.5 requires it); CI tests only Node 22.x.
- Plain list/get tools no longer retry (`maxRetries: 0`), so one limiter slot is one HTTP attempt.
- Each report run clears its deadline timer and abort listeners when it finishes (`Run.close()`),
  including on errors.
- Dependency moved to `@wyre-ai/node-kaseya-quote-manager` `^1.0.5` (same code as 1.0.0, new
  scope); `.npmrc` and CI now configure only the `@wyre-ai` scope.
- `kqm_pipeline_summary` with `includeCost` reads every page of supplier links, and leaves a
  quote unpriced (partial) if that read is cut short, instead of trusting the first 100 links.
- `partial` and `partialReason` are the first fields of every report and `*_get_full` result so
  they survive truncation. `*_get_full` results add `complete` flags per child list (and
  `linesComplete` per quote section).
- The 100 KB cap now covers the whole result text: defanging, the envelope and the truncation
  note are counted before the data is cut.
- `modifiedAfter` accepts strict ISO 8601 only (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM[:SS[.fff]]`
  with an optional `Z` or `±HH:MM`); impossible dates are refused. `page` is limited to 10,000.

### Security

- `CONDUIT_S2S_SECRET` must be at least 32 characters, and `MCP_ALLOW_INSECURE_DEV` is refused
  unless `NODE_ENV=development`.
- `/mcp` rejects bodies over 256 KiB with 413 (after the S2S check) and caps chunked bodies in
  the transport. Tool input over 10,000 values is refused.
- HTTP request failures return a fixed 500 and no longer log the error object.
- `MCP_ALLOW_INSECURE_DEV` requires `NODE_ENV` to be exactly `development`; `Development` or a
  padded value now refuses to start.
- A bad `AUTH_MODE` is refused without echoing its value. Fatal startup errors log only the
  error type and a message of at most 200 characters.

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
