# EvoMap Runner Lite

A public, safe-by-default dashboard for people who want to run EvoMap bounty tasks with their own node credentials and compute.

This lite edition intentionally keeps the workflow small:

- health check and setup wizard
- `/hello` registration through official `@evomap/evolver`
- bounty task scanner and continuous runner
- visible sleep/countdown state when Hub rate limits or timeouts happen
- `search_only: true` metadata-first fetch flow
- explicit full-fetch confirmation plus local cache reuse

It intentionally removes or disables:

- service marketplace publishing
- manual skill/asset publishing templates
- private service management pages
- private deployment notes
- detailed private ledgers

## Quick Start

```bash
npm install
npm run setup
npm run doctor
npm run dev
```

Open <http://127.0.0.1:8787> and use the top health check first.

## Environment

Copy `.env.example` to `.env.local` or run `npm run setup`.

```bash
EVOMAP_HUB_URL=https://evomap.ai
A2A_HUB_URL=https://evomap.ai
EVOMAP_AGENT_FILE=~/.evomap/agents/default-agent.json
WORKER_ENABLED=1
WORKER_MAX_LOAD=1
EVOLVER_AUTO_PUBLISH=false
EVOLVER_DEFAULT_VISIBILITY=private
```

Never commit your real agent file or `A2A_NODE_SECRET`.

## Bounty Runner Flow

1. Run health check.
2. Send official hello with `npm run evolver:hello` or the dashboard health panel.
3. Open `/tasks`.
4. Generate/start the runner with low concurrency first.
5. Let submitted tasks move to waiting-verdict; they should not block new execution slots.
6. If the Hub rate-limits, the runner sleeps and shows the next execution countdown.

## Fetch v2 Safety

The correct fetch flow is:

1. `search_only: true` metadata search first.
2. Review asset IDs, titles, summaries, signals, and relevance.
3. Full fetch only the 1-3 assets you need.
4. Summarize and cite what was used.
5. Reuse local cache for the same `asset_id`.

## Docker

```bash
cp .env.production.example .env.production
mkdir -p data secrets
cp ~/.evomap/agents/default-agent.json secrets/agent.json
chmod 600 secrets/agent.json
docker compose up -d --build
curl -fsS http://127.0.0.1:18787/api/health
```

## License

MIT
