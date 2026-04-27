import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

const force = process.argv.includes('--force');
const defaultAgentFile = path.join(os.homedir(), '.evomap', 'agents', 'default-agent.json');
const legacyAgentFile = path.join(os.homedir(), '.evomap', 'agents', 'default-agent.json');
const agentFile = defaultAgentFile;
const envFile = path.join(process.cwd(), '.env.local');

async function ask(question, fallback = '') {
  const suffix = fallback ? ` (${fallback})` : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question}${suffix}: `);
  rl.close();
  return answer.trim() || fallback;
}

async function askHidden(question) {
  process.stdout.write(`${question}: `);
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const hidden = readline.createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
  const answer = await hidden.question('');
  hidden.close();
  process.stdout.write('\n');
  return answer.trim();
}

function toEnvPath(file) {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, file)}` : file;
}

function readExistingAgent() {
  for (const file of [defaultAgentFile, legacyAgentFile]) {
    if (!existsSync(file)) continue;
    try {
      return { file, agent: JSON.parse(readFileSync(file, 'utf8')) };
    } catch (err) {
      console.warn(`Ignoring unreadable agent file ${file}: ${err.message}`);
    }
  }
  return null;
}

function writeEnv(hubUrl, selectedAgentFile = agentFile) {
  const envAgentFile = toEnvPath(selectedAgentFile);
  const content = [
    '# Local-only EvoMap Runner Lite config. Do not commit this file.',
    `EVOMAP_HUB_URL=${hubUrl}`,
    `A2A_HUB_URL=${hubUrl}`,
    `EVOMAP_AGENT_FILE=${envAgentFile}`,
    'WORKER_ENABLED=1',
    'WORKER_DOMAINS=evomap,a2a,ai-navigation,guide,tutorial,automation,codex,agent-infrastructure,api-integration,debugging',
    'WORKER_MAX_LOAD=1',
    'EVOLVER_SESSION_SCOPE=evomap-runner-lite',
    'EVOLVER_ATP_AUTOBUY=off',
    'ATP_AUTOBUY_DAILY_CAP_CREDITS=0',
    'ATP_AUTOBUY_PER_ORDER_CAP_CREDITS=0',
    'EVOLVER_VALIDATOR_ENABLED=false',
    'EVOLVER_AUTO_PUBLISH=false',
    'EVOLVER_DEFAULT_VISIBILITY=private',
    'EVOLVER_ROLLBACK_MODE=none',
    '',
  ].join('\n');

  if (existsSync(envFile) && !force) {
    const current = readFileSync(envFile, 'utf8');
    const additions = [
      ['EVOMAP_AGENT_FILE', `EVOMAP_AGENT_FILE=${envAgentFile}`],
      ['WORKER_ENABLED', 'WORKER_ENABLED=1'],
      ['WORKER_DOMAINS', 'WORKER_DOMAINS=evomap,a2a,ai-navigation,guide,tutorial,automation,codex,agent-infrastructure,api-integration,debugging'],
      ['WORKER_MAX_LOAD', 'WORKER_MAX_LOAD=1'],
      ['EVOLVER_SESSION_SCOPE', 'EVOLVER_SESSION_SCOPE=evomap-runner-lite'],
      ['EVOLVER_ATP_AUTOBUY', 'EVOLVER_ATP_AUTOBUY=off'],
      ['ATP_AUTOBUY_DAILY_CAP_CREDITS', 'ATP_AUTOBUY_DAILY_CAP_CREDITS=0'],
      ['ATP_AUTOBUY_PER_ORDER_CAP_CREDITS', 'ATP_AUTOBUY_PER_ORDER_CAP_CREDITS=0'],
      ['EVOLVER_VALIDATOR_ENABLED', 'EVOLVER_VALIDATOR_ENABLED=false'],
      ['EVOLVER_AUTO_PUBLISH', 'EVOLVER_AUTO_PUBLISH=false'],
      ['EVOLVER_DEFAULT_VISIBILITY', 'EVOLVER_DEFAULT_VISIBILITY=private'],
      ['EVOLVER_ROLLBACK_MODE', 'EVOLVER_ROLLBACK_MODE=none'],
    ].filter(([key]) => !current.includes(`${key}=`)).map(([, line]) => line);
    if (additions.length) writeFileSync(envFile, `${current.trimEnd()}\n${additions.join('\n')}\n`);
    return 'updated existing .env.local';
  }
  writeFileSync(envFile, content);
  return existsSync(envFile) && force ? 'rewrote .env.local' : 'created .env.local';
}

console.log('EvoMap Runner Lite local setup');
console.log('Paste credentials from EvoMap. The node_secret is stored only in your home directory.');

const existing = force ? null : readExistingAgent();
if (existing) {
  const hubUrl = existing.agent.hub_url || 'https://evomap.ai';
  const envResult = writeEnv(hubUrl, existing.file);
  console.log(`\nFound existing agent file ${existing.file}`);
  console.log('Kept existing credentials. Re-run with npm run setup -- --force to replace them.');
  console.log(`${envResult}.`);
  console.log('Next: run npm run evolver:hello, npm run doctor, then npm run dev.');
  process.exit(0);
}

const hubUrl = await ask('Hub URL', 'https://evomap.ai');
const nodeId = await ask('A2A node_id');
const nodeSecret = await askHidden('A2A node_secret');
const name = await ask('Agent display name', 'My EvoMap Agent');
const model = await ask('Model name', 'my/local-agent');

if (!nodeId || !nodeSecret) {
  console.error('Setup cancelled: node_id and node_secret are required.');
  process.exit(1);
}

if (existsSync(agentFile) && !force) {
  console.error(`${agentFile} already exists. Re-run with npm run setup -- --force to overwrite it.`);
  process.exit(1);
}

mkdirSync(path.dirname(agentFile), { recursive: true });
writeFileSync(agentFile, `${JSON.stringify({ node_id: nodeId, node_secret: nodeSecret, name, model, hub_url: hubUrl }, null, 2)}\n`, { mode: 0o600 });
const envResult = writeEnv(hubUrl);

console.log(`\nCreated ${agentFile}`);
console.log(`${envResult}.`);
console.log('Next: run npm run evolver:hello, npm run doctor, then npm run dev.');
