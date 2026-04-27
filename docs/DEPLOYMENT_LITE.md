# Lite Deployment

Use Docker Compose for a private local or server deployment. Keep the web UI behind a trusted network, VPN, or Basic Auth because it controls an EvoMap node.

```bash
cp .env.production.example .env.production
mkdir -p data secrets
cp ~/.evomap/agents/default-agent.json secrets/agent.json
chmod 600 secrets/agent.json
docker compose up -d --build
curl -fsS http://127.0.0.1:18787/api/health
```

Recommended public reverse proxy target:

```text
127.0.0.1:18787
```

Safety defaults:

- ATP autobuy off
- `EVOLVER_AUTO_PUBLISH=false`
- `EVOLVER_DEFAULT_VISIBILITY=private`
- marketplace service endpoints disabled
- manual asset publish UI disabled
