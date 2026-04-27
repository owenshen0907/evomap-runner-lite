import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyEvolverEnv, printableEvolverEnv, redact } from './evolver-env.mjs';

const { agent } = applyEvolverEnv();
const require = createRequire(import.meta.url);
const evolverRoot = path.join(process.cwd(), 'node_modules', '@evomap', 'evolver');

if (!existsSync(evolverRoot)) {
  console.error('Missing @evomap/evolver. Run npm install first.');
  process.exit(1);
}

let buildHello;
try {
  ({ buildHello } = require(path.join(evolverRoot, 'src', 'gep', 'a2aProtocol.js')));
} catch (err) {
  console.error(`Unable to load official evolver hello builder: ${err.message}`);
  console.error('Run npm install @evomap/evolver@latest, then retry npm run evolver:hello.');
  process.exit(1);
}

if (typeof buildHello !== 'function') {
  console.error('Installed @evomap/evolver does not expose buildHello. Upgrade to @evomap/evolver >= 1.69.0.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const hubUrl = (process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || 'https://evomap.ai').replace(/\/+$/, '');
const nodeId = process.env.A2A_NODE_ID || agent?.node_id;
const nodeSecret = process.env.A2A_NODE_SECRET || agent?.node_secret;
const packageJson = JSON.parse(readFileSync(path.join(evolverRoot, 'package.json'), 'utf8'));

if (!nodeId || !nodeSecret) {
  console.error('Missing A2A_NODE_ID/A2A_NODE_SECRET. Run npm run setup first.');
  process.exit(1);
}

const capabilities = {
  dashboard: 'evomap-runner-lite',
  official_evolver_package: packageJson.version,
  worker_enabled: process.env.WORKER_ENABLED === '1',
  worker_domains: process.env.WORKER_DOMAINS || '',
  worker_max_load: Number(process.env.WORKER_MAX_LOAD || 1),
  deferred_claim: true,
  safe_defaults: {
    autobuy: process.env.EVOLVER_ATP_AUTOBUY || 'off',
    validator: process.env.EVOLVER_VALIDATOR_ENABLED || 'false',
    auto_publish: process.env.EVOLVER_AUTO_PUBLISH || 'false',
    visibility: process.env.EVOLVER_DEFAULT_VISIBILITY || 'private',
  },
};

const hello = buildHello({
  name: process.env.EVOLVER_AGENT_NAME || process.env.AGENT_NAME || agent?.name || 'EvoMap Runner Lite Agent',
  senderId: nodeId,
  capabilities,
});

hello.payload.meta = {
  source: 'evomap-runner-lite:evolver-hello',
  session_scope: process.env.EVOLVER_SESSION_SCOPE || '',
  worker_enabled: process.env.WORKER_ENABLED === '1',
  worker_domains: process.env.WORKER_DOMAINS || '',
  worker_max_load: Number(process.env.WORKER_MAX_LOAD || 1),
};

if (dryRun) {
  console.log(JSON.stringify({ env: printableEvolverEnv(), hello: redact(hello) }, null, 2));
  process.exit(0);
}

const response = await fetch(`${hubUrl}/a2a/hello`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${nodeSecret}`,
    'content-type': 'application/json',
    'user-agent': `EvoMapRunnerLiteOfficialHello/@evomap-evolver-${packageJson.version}`,
  },
  body: JSON.stringify(hello),
});

const text = await response.text();
let payload;
try {
  payload = text ? JSON.parse(text) : {};
} catch {
  payload = { raw: text };
}

if (!response.ok) {
  const retryAfter = response.headers.get('retry-after');
  console.error(JSON.stringify(redact({
    status: 'evolver_hello_failed',
    http_status: response.status,
    retry_after: retryAfter,
    response: payload,
  }), null, 2));
  process.exit(response.status === 429 ? 0 : 1);
}

let node = null;
try {
  const nodeResponse = await fetch(`${hubUrl}/a2a/nodes/${encodeURIComponent(nodeId)}`, {
    headers: {
      authorization: `Bearer ${nodeSecret}`,
      'user-agent': 'EvoMapRunnerLiteOfficialHelloCheck/0.1',
    },
    cache: 'no-store',
  });
  node = await nodeResponse.json();
} catch {
  node = null;
}

const sentAt = new Date().toISOString();
const ack = payload?.payload || payload || {};

if (agent?.file) {
  try {
    const current = JSON.parse(readFileSync(agent.file, 'utf8'));
    const nextAgent = {
      ...current,
      hub_node_id: ack.hub_node_id || current.hub_node_id,
      heartbeat_interval_ms: ack.heartbeat_interval_ms || current.heartbeat_interval_ms,
      claimed: ack.claimed ?? current.claimed,
      owner_user_id: ack.owner_user_id || current.owner_user_id,
      last_hello_message_id: hello.message_id,
      last_confirmed_by: 'evolver:hello',
      last_confirmed_at: sentAt,
      last_known_credit_balance: ack.credit_balance ?? current.last_known_credit_balance,
    };
    writeFileSync(agent.file, `${JSON.stringify(nextAgent, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`Warning: official hello succeeded, but local agent receipt was not updated: ${err.message}`);
  }
}

const status = {
  status: 'evolver_hello_sent',
  sent_at: sentAt,
  hub_url: hubUrl,
  node_id: nodeId,
  evolver_version: packageJson.version,
  worker_enabled: process.env.WORKER_ENABLED === '1',
  worker_domains: process.env.WORKER_DOMAINS || '',
  worker_max_load: Number(process.env.WORKER_MAX_LOAD || 1),
  response: payload,
  node: node ? {
    node_id: node.node_id,
    alias: node.alias,
    last_seen_at: node.last_seen_at,
    online: node.online,
    status: node.status,
    reputation_score: node.reputation_score,
    credit_balance: node.credit_balance,
  } : null,
};

const statusFile = path.join(process.cwd(), 'data', 'logs', 'evolver-hello-status.json');
mkdirSync(path.dirname(statusFile), { recursive: true });
writeFileSync(statusFile, `${JSON.stringify(redact(status), null, 2)}\n`);

console.log(JSON.stringify(redact(status), null, 2));
