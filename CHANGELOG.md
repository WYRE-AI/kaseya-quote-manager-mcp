# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release of the Kaseya Quote Manager (Datto Commerce) MCP server.
- Read-only access to all 20 Quote Manager resources via 39 entity tools, grouped into
  5 navigable domains: `sales`, `procurement`, `catalog`, `crm`, and `org`.
- `kqm_navigate` and `kqm_status` discovery tools.
- Pre-baked prompts: `quote-pipeline-review`, `quote-detail`, `purchasing-summary`.
- stdio and HTTP Streamable transports; gateway mode with `x-kaseya-quote-manager-api-key`
  header injection.
- Built on `@wyre-technology/node-kaseya-quote-manager`.

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
