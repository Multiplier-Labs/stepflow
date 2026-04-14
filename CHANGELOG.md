# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
