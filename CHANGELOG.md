# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `dist/` is no longer committed to the repository. The npm package is unaffected: it is built from source when a release is published. Installing directly from Git (`github:Multiplier-Labs/stepflow`) is no longer supported; install from npm.

## [0.3.7] - 2026-11-07

### Security
- Webhooks no longer follow redirects. Previously a public webhook URL could redirect the signed POST body to an internal address, bypassing SSRF checks. All default deliveries, including IP-literal URLs, now use the DNS-pinned HTTP client; a custom `fetchFn` is called with `redirect: 'error'`.
- Enforce a real five-second DNS deadline for webhook lookups (the previous abort signal was ignored by `dns.lookup`) and count payload limits in UTF-8 bytes.
- Require Kysely 0.28.17 or newer for PostgreSQL support.

### Fixed
- PostgreSQL storage now persists completed-step checkpoints (`completed_steps_json`, added by an additive migration). Recovered runs previously re-executed steps that had already completed.
- Resuming a run respects `maxConcurrency` and is a no-op when the run is already active or queued; previously it could run twice. Queued recoveries keep their checkpoint, `resumeAllInterrupted()` recovers every storage page, and delayed runs that wait for capacity keep their original start time.
- SQLite run listings are ordered by `(created_at, id)`, so recovery paging cannot skip or repeat runs created in the same millisecond.
- The engine-level `defaultTimeout` setting is now applied to workflows without their own timeout.
- Cancellation during completion hooks is preserved, a throwing `run.created` subscriber no longer fails `startRun`, and a run whose success is already persisted keeps its `succeeded` status if shutdown or a timeout aborts it during the final write.
- Shutdown stops queue dispatch and waits for in-flight runs and admission I/O before closing adapters, instead of closing storage under running work. Launch timers are released correctly.
- PostgreSQL storage and schedule persistence keep caller-supplied pools open on `close()` and close adapter-owned pools only once.
- Refreshed the committed `dist/` build, which was stale for Git-based installs (missing the DNS pinning fix and the SQLite `completed_steps_json` migration). npm packages were not affected because they are built at publish time. CI now also checks package exports and PostgreSQL integration.

### Added
- `settings.shutdownTimeout` (default 30000 ms) bounds how long `shutdown()` waits for in-flight work; after it elapses shutdown logs a warning and closes adapters anyway.

### Changed
- After `shutdown()` begins, `startRun`, `resumeRun`, `cancelRun`, `getResumableRuns` and `resumeAllInterrupted` reject. Repeated `shutdown()` calls share one completion. Queued runs stay persisted for recovery by the next engine.
- Webhook endpoints that answer with a redirect are now treated as failed deliveries and retried, not followed.

### Notes
- 0.3.4, 0.3.5 and 0.3.6 were tagged on GitHub but never published to npm. Upgrading from npm 0.3.2 also brings in the changes listed under 0.3.6 and 0.3.4, notably the Node.js requirement of `^22.22.2 || ^24.15.0 || >=26.0.0` (Node 20 is no longer supported).
- Completed-step keys that PostgreSQL discarded before this release cannot be reconstructed; runs interrupted before upgrading may still repeat steps once on recovery.
- If shutdown begins while `startRun` is creating a run, `startRun` rejects but the run is already persisted as queued and will execute on the next recovery. Avoid blindly retrying `startRun` during shutdown.

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

## [0.3.4] - 2026-04-27

Not published to npm; included in 0.3.7. Also covers 0.3.3, which only switched publishing to npmjs.com.

### Security
- Webhook delivery pins the validated DNS resolution for the connection, closing a DNS-rebinding window between validation and connect.
- Webhook URL validation now covers IPv6: loopback, link-local, unique-local, and IPv4-mapped/translated/6to4 addresses that embed a private IPv4 address are blocked, while public IPv6 endpoints are allowed.
- The webhook delivery queue is capped (`maxQueueDepth`, default 1000, or `STEPFLOW_WEBHOOK_MAX_QUEUE_DEPTH`); deliveries beyond the cap are dropped and logged.
- Planning conditions using the `matches` operator reject regex patterns longer than 512 characters (the condition evaluates to false).

### Added
- Optional `logger` setting on storage and schedule persistence adapters; corrupted JSON columns are logged as structured warnings and counted by `getJsonParseCorruptionCount()`.

### Fixed
- SQLite storage adds missing columns to existing tables on startup, fixing `no column named completed_steps_json` errors after upgrades.
- Corrupted JSON in storage rows no longer crashes the process.
- A failure while dispatching a queued run marks that run failed (`QUEUE_DISPATCH_FAILED`) instead of stranding the rest of the queue.
- `waitForRun()` no longer misses a completion that happens while it starts.
- `shutdown()` clears pending launch timers so the process can exit.
- PostgreSQL pagination totals are counted in the same transaction as the page, and unexpected schema-migration errors are no longer swallowed.
- Restarting a `CronScheduler` no longer duplicates subscriptions, and an invalid persisted cron expression disables only that schedule.
- The deprecated async SQLite `transaction()` warns when its callback awaits real I/O outside the transaction.


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
