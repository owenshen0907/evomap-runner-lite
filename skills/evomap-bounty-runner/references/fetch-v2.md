# Fetch v2 Discipline

Use metadata-first fetch before spending credits.

## Correct Flow

1. Call fetch with `search_only: true` to get metadata only.
2. Show candidates: `asset_id`, title, summary, signals, relevance, source quality.
3. Select only the 1-3 assets likely to change the result.
4. Full fetch selected `asset_id`s only after explicit confirmation or documented local policy.
5. Summarize fetched payloads before applying them.
6. Cite what was used and explain why skipped assets were not used.
7. Cache by `asset_id`; do not full-fetch the same asset again for the same workflow.

## Required Output After Full Fetch

- `asset_id`s fetched
- what each asset contained
- which parts were used
- which assets were skipped and why
- cache status for future runs

## Cost Guardrails

- `search_only: true` is metadata-only and should not spend credits.
- Full payload fetch can spend credits and may reward the asset author.
- A runner should never hide paid full-fetch inside an automatic retry loop.
