# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.6] - 2026-09-30

### Security
- Upgraded `re2` from 1.24 to 1.27, fixing DoS and out-of-bounds read advisories in `re2` and advisories in its transitive dependencies `tar`, `brace-expansion`, `ip-address` and `undici`
- Added `overrides` for `tar`, `brace-expansion`, `postcss`, `esbuild`, `vite` and `nanoid` to keep patched versions installed
- The published package now contains only `dist/`, `package.json` and `README.md`; earlier versions also shipped internal files such as `.codekin/reports/` and `.github/`

### Changed
- **Node.js support:** now requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` (declared in `engines`), the minimum supported by the patched `re2`. Node 20 is no longer supported.
- `MemoryEventTransport.emit` now delivers to run-specific and event-type subscribers before global subscribers (previously global came first)
- Upgraded `cron-parser` from 5.5 to 5.10

### Notes
- Version 0.3.5 was tagged but never published to npm; 0.3.6 supersedes it.

## [0.3.2] - 2026-04-11

### Added
- CI workflow for automated build, typecheck, and test on pull requests
- Security scanning workflow with weekly `npm audit` checks
- Dependabot configuration for automated dependency and GitHub Actions updates
- `CODEOWNERS` file requiring designated reviewers for security-sensitive paths
- `SECURITY.md` with vulnerability reporting instructions and disclosure policy
- Branch protection documentation in README

### Changed
- Pinned GitHub Actions in `publish.yml` to full commit SHAs to prevent supply-chain attacks via tag hijacking

## [0.2.6] - 2026-04-03

### Added
- Initial public release
- Durable workflow execution engine with step orchestration
- SQLite and PostgreSQL storage backends
- In-memory storage for testing
- Cron-based scheduling with SQLite and PostgreSQL persistence
- Workflow completion triggers
- Socket.IO and webhook event transports with HMAC-SHA256 signing
- SSRF protection for webhook URLs with DNS-rebinding prevention
- Concurrency control with priority queues
- Rule-based planning system for dynamic workflow generation
- Full TypeScript support with type inference
