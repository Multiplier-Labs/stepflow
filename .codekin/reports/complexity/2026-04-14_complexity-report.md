# Complexity Report: stepflow

**Date**: 2026-04-14T01:04:23.188Z
**Repository**: /srv/repos/stepflow
**Branch**: main
**Workflow Run**: 21addb61-3850-4a9f-9504-0c0627b6a8d5
**Session**: 01abcef0-2ca7-4ee5-b46f-a7959609ab9a

---

## Code Complexity Report — Stepflow

The report has been saved to `.codekin/reports/complexity/2026-04-14_complexity-report.md`.

**Overall rating: Medium-High**

Key findings:

**Largest files** (top 3):
- `src/storage/postgres.ts` — 1,354 lines (4.5× the 300-line guideline), a God object with 20+ methods across 8 distinct responsibilities
- `src/core/engine.ts` — 692 lines, mixes queue management with lifecycle orchestration
- `src/core/orchestrator.ts` — 564 lines, hosts the two most complex functions in the codebase

**Hottest complexity spots:**
- `orchestrator.ts: executeStep()` — CC ≈ 20, 7 levels of nesting in the retry loop
- `orchestrator.ts: executeWorkflow()` — 217-line function with inline timeout scheduling, checkpointing, and lifecycle hooks all interleaved
- `postgres.ts: createTables()` — 152 lines of undifferentiated SQL blocks

**Highest-impact refactoring opportunities (quick wins):**
1. Extract a `parseJsonColumn<T>()` utility to eliminate the 8+ identical JSON parsing idioms duplicated across postgres and sqlite adapters (Small effort)
2. Replace `evaluateCondition()` switch with a strategy map (Small effort)
3. Extract event/status string literals into a `src/core/constants.ts` file (Small effort)
4. Replace the O(n) array-splice run queue with a priority heap (Small effort)
5. Introduce a shared `Semaphore` utility — both `engine.ts` and `webhook.ts` have hand-rolled concurrency controllers (Small effort)