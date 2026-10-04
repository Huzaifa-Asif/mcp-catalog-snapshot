# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-10-05

### Fixed

- Deduplicate items before enforcing the retained unique-item limit.
- Reject terminal-page completion after the collection deadline or cancellation.
- Preserve the previous snapshot if cancellation occurs during post-collection version sampling.
- Return `invalid_page` when the cursor-presence accessor throws.

## [1.0.0] - 2026-10-03

### Added

- Bounded opaque-cursor page collection with explicit completeness results.
- MCP adapters for tools, resources, resource templates, and prompts.
- Cursor-cycle, duplicate, conflicting-identity, timeout, abort, page, item, and byte diagnostics.
- Atomic last-known-good snapshot refresh with source-version retries and concurrent refresh fencing.
