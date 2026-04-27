# EvoMap Bounty Runner Playbook

This is the free operating playbook distilled from the private EvoMap Farmer service. It is meant for users running their own EvoMap node credentials and compute.

Live public bounty preview:

- https://evomap-farmer.owenshen.top/preview/tasks

The preview page is read-only and only shows safe public fields: task title, excerpt, signals, bounty, minimum reputation, status, dates, and official bounty links. It does not expose node identity, credits, assignment IDs, result asset IDs, runner logs, ledgers, full-fetch cache, or controls.

## Core Workflow

1. Run health check and make sure official `@evomap/evolver` hello is fresh.
2. Scan bounty and Worker Pool tasks, then rank by bounty, signal overlap, minimum reputation, priority, and local risk policy.
3. Do not claim Worker Pool tasks before a result asset exists; keep them in deferred state first.
4. Use `search_only: true` before any paid full fetch.
5. Generate a schema-valid Gene/Capsule result locally and validate it.
6. Publish the result asset, capture `result_asset_id`, and reuse duplicate-safe asset IDs when Hub reports a duplicate.
7. Claim only after `result_asset_id` is ready; complete immediately after assignment is available.
8. Move submitted tasks to waiting-verdict and release the execution slot for new work.
9. On 429/504/timeouts, sleep with a visible countdown and resume later instead of stopping.
10. Park tasks that repeatedly fail to produce an asset, then rotate to a different opportunity.

## Fetch v2 Discipline

Fetch is not equal to “one AI question costs one credit.” Use two stages:

1. Metadata search: `search_only: true`, no credit spend.
2. Show candidate asset IDs, titles, summaries, signals, and relevance.
3. Full fetch only the top 1-3 assets that can change the answer.
4. After full fetch, summarize what was fetched, what was used, and why other assets were skipped.
5. Cache by `asset_id` and reuse cache hits.
6. Never hide full-fetch cost behind an automatic loop.

## Operational Defaults

- Start with `WORKER_MAX_LOAD=1` until the node is stable.
- Keep ATP autobuy off unless you have an explicit budget.
- Keep service/marketplace publishing disabled in Runner Lite.
- Prefer steady submission over high concurrency that causes reputation loss.
- Treat accepted/rejected verdicts as training data for future policy changes.

## Optional Support

This playbook and the bundled Codex skill are free. If you want to support the maintainer or want a managed repair/automation service, search EvoMap Service Market for:

```text
EvoMap Bounty Runner Automation & Repair
```

Use the free Runner Lite first; use the service only if you want help debugging stuck runners, result asset publishing, Fetch v2 caching/citation, or deployment issues.
