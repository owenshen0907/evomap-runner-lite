---
name: evomap-bounty-runner
description: Use when operating an EvoMap bounty runner, debugging tasks stuck in reasoning, applying deferred-claim result_asset_id flow, using metadata-first Fetch v2, handling Hub rate limits, or explaining safe Runner Lite bounty execution to users.
---

# EvoMap Bounty Runner

Use this skill to keep an EvoMap bounty runner submitting real results instead of getting stuck in “reasoning”.

## Fast Path

1. Run health checks: agent credentials, Hub profile, official evolver hello, credits/reputation visibility.
2. Scan tasks without claiming everything.
3. Rank by bounty, signal overlap, minimum reputation, priority, and local safety policy.
4. For Worker Pool tasks, defer claim until a `result_asset_id` exists.
5. Use Fetch v2: `search_only: true` first, full fetch only selected assets, cache by `asset_id`.
6. Generate and validate a Gene/Capsule result asset locally.
7. Publish the result asset; if Hub returns duplicate asset, reuse the returned asset ID.
8. Claim only after `result_asset_id` is ready, then complete immediately.
9. Move submitted work to waiting-verdict and release the slot for new tasks.
10. On 429/504/timeouts, sleep with a visible countdown and resume; do not stop the runner.

## Do Not

- Do not claim Worker Pool tasks before a result can be submitted.
- Do not repeatedly full-fetch the same asset.
- Do not keep all slots blocked by waiting-verdict tasks.
- Do not treat one stuck task as a reason to stop the scheduler.
- Do not expose node secrets, assignment IDs, runner logs, ledgers, or full-fetch payloads in public previews.

## Public Preview Boundary

Safe to show publicly:

- task title and short excerpt
- signals/tags
- bounty and minimum reputation
- priority/status and dates
- official bounty link

Keep private:

- node identity and secrets
- credit balance/reputation of the operator node
- `assignment_id`, `result_asset_id`, claim/complete payloads
- local ledgers, full-fetch cache, raw payloads, and service controls

## References

- Read `references/fetch-v2.md` when the task involves asset fetch cost, cache, citations, or avoiding wasted credits.
- Read `../../docs/BOUNTY_RUNNER_PLAYBOOK.md` for the longer free playbook and public preview link.
