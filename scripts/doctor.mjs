import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyEvolverEnv, candidateAgentFiles } from './evolver-env.mjs';

applyEvolverEnv();
const HUB = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL || 'https://evomap.ai';
const TIMEOUT_MS = Number(process.env.EVOMAP_DOCTOR_TIMEOUT_MS || 8000);
const offline = process.argv.includes('--offline');

function readAgent() {
  for (const file of candidateAgentFiles()) {
    if (!existsSync(file)) continue;
    const agent = JSON.parse(readFileSync(file, 'utf8'));
    return { ...agent, file };
  }
  if (process.env.A2A_NODE_ID && process.env.A2A_NODE_SECRET) {
    return {
      node_id: process.env.A2A_NODE_ID,
      node_secret: process.env.A2A_NODE_SECRET,
      model: process.env.EVOLVER_MODEL_NAME,
      name: process.env.EVOLVER_AGENT_NAME,
      source: '.env.local',
      file: null,
    };
  }
  return null;
}

function readEvolverHelloStatus() {
  const file = path.join(process.cwd(), 'data', 'logs', 'evolver-hello-status.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function checkEvolverVersion(version) {
  const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return;
  const [, major, minor] = match.map(Number);
  if (major > 1 || (major === 1 && minor >= 69)) pass('@evomap/evolver hello support', '>= 1.69.0');
  else warn('@evomap/evolver hello support', `${version}; upgrade to >= 1.69.0`);
}

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` - ${detail}` : ''}`);
}

function warn(label, detail = '') {
  console.log(`WARN ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  failed = true;
}

async function checkHub(agent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${HUB}/a2a/nodes/${encodeURIComponent(agent.node_id)}`;
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${agent.node_secret}`,
        'user-agent': 'EvoMapRunnerLiteDoctor/0.1',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.ok) {
      pass('Hub auth', `connected to ${HUB}`);
      return;
    }
    if (response.status === 429) {
      warn('Hub auth', `rate limited by ${HUB}; local config still looks valid`);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      fail('Hub auth', `credential rejected with HTTP ${response.status}`);
      return;
    }
    warn('Hub auth', `HTTP ${response.status}; retry later or run npm run evolver:help`);
  } catch (err) {
    if (err.name === 'AbortError') {
      warn('Hub auth', `timed out after ${TIMEOUT_MS}ms`);
    } else {
      warn('Hub auth', err.message);
    }
  } finally {
    clearTimeout(timer);
  }
}

let failed = false;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 18) pass('Node.js', process.version);
else fail('Node.js', `${process.version}; need >=18`);

let evolverVersion = '';
if (existsSync(path.join(process.cwd(), 'node_modules', '@evomap', 'evolver'))) {
  evolverVersion = 'installed';
  try {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules', '@evomap', 'evolver', 'package.json'), 'utf8'));
    evolverVersion = packageJson.version ? `v${packageJson.version}` : evolverVersion;
  } catch {}
  pass('@evomap/evolver', evolverVersion);
  checkEvolverVersion(evolverVersion);
} else {
  fail('@evomap/evolver', 'missing; run npm install');
}

if (existsSync(path.join(process.cwd(), '.env.local'))) pass('.env.local', 'present');
else warn('.env.local', 'not present; this is OK if an agent file exists');

const agent = readAgent();
if (!agent) {
  fail('Agent credentials', 'run npm run setup, or create ~/.evomap/agents/default-agent.json');
} else {
  if (agent.node_id) pass('A2A_NODE_ID', agent.node_id);
  else fail('A2A_NODE_ID', 'missing');

  if (agent.node_secret) pass('A2A_NODE_SECRET', '[redacted]');
  else fail('A2A_NODE_SECRET', 'missing');

  if (agent.file) pass('Agent file', agent.file);
  else pass('Agent source', agent.source || 'environment variables');

  if (agent.model || process.env.EVOLVER_MODEL_NAME) pass('Model name', agent.model || process.env.EVOLVER_MODEL_NAME);
  else warn('Model name', 'not set; official Evolver will use its own default');
}

if (process.env.WORKER_ENABLED === '1') pass('Worker mode', `enabled; max load ${process.env.WORKER_MAX_LOAD || 'default'}`);
else warn('Worker mode', 'not enabled; official Evolver will not pick up Worker Pool tasks');

if (process.env.WORKER_DOMAINS) pass('Worker domains', process.env.WORKER_DOMAINS);
else warn('Worker domains', 'not set; capability matching may be too broad or weak');

if (process.env.WORKER_MAX_LOAD && Number(process.env.WORKER_MAX_LOAD) > 1) {
  warn('Worker max load', `${process.env.WORKER_MAX_LOAD}; stable mode recommends 1 until result assets submit reliably`);
}

if (process.env.EVOLVER_AUTO_PUBLISH === 'true') {
  warn('Auto publish', 'enabled; results may be sent to Hub automatically');
} else {
  pass('Auto publish', 'off; use reviewed/private result assets before submitting bounties');
}

pass('Safety defaults', 'autobuy off, validator off, private visibility by wrapper default');

const helloStatus = readEvolverHelloStatus();
if (helloStatus?.status === 'evolver_hello_sent') {
  const ageMs = Date.now() - Date.parse(helloStatus.sent_at || '');
  if (Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000) {
    pass('Official evolver hello', `sent ${Math.max(1, Math.round(ageMs / 60000))}m ago`);
  } else {
    warn('Official evolver hello', 'local receipt is old; run npm run evolver:hello');
  }
} else {
  warn('Official evolver hello', 'no local receipt; run npm run evolver:hello once after setup');
}

if (!offline && agent?.node_id && agent?.node_secret) {
  await checkHub(agent);
} else if (offline) {
  warn('Hub auth', 'skipped because --offline was used');
}

if (failed) {
  console.log('\nNext step: run npm run setup, npm run evolver:hello, then npm run doctor again.');
  process.exit(1);
}

console.log('\nDoctor finished. If Official evolver hello is WARN, run npm run evolver:hello. If Hub auth is only WARN 429, wait a few minutes and retry; local setup is otherwise ready.');
