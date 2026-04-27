import nextEnv from '@next/env';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadEnvConfig } = nextEnv;

export const stableEvolverDefaults = {
  A2A_HUB_URL: 'https://evomap.ai',
  WORKER_ENABLED: '1',
  WORKER_DOMAINS: 'evomap,a2a,ai-navigation,guide,tutorial,automation,codex,agent-infrastructure,api-integration,debugging',
  WORKER_MAX_LOAD: '1',
  EVOLVER_SESSION_SCOPE: 'evomap-runner-lite',
  EVOLVER_ATP_AUTOBUY: 'off',
  ATP_AUTOBUY_DAILY_CAP_CREDITS: '0',
  ATP_AUTOBUY_PER_ORDER_CAP_CREDITS: '0',
  EVOLVER_VALIDATOR_ENABLED: 'false',
  EVOLVER_AUTO_PUBLISH: 'false',
  EVOLVER_DEFAULT_VISIBILITY: 'private',
  EVOLVER_ROLLBACK_MODE: 'none',
};

export const DEFAULT_AGENT_FILE = path.join(os.homedir(), '.evomap', 'agents', 'default-agent.json');
export const LEGACY_AGENT_FILE = path.join(os.homedir(), '.evomap', 'agents', 'default-agent.json');

export function expandHome(filePath) {
  if (!filePath) return null;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function candidateAgentFiles() {
  return [
    expandHome(process.env.EVOMAP_AGENT_FILE),
    DEFAULT_AGENT_FILE,
    LEGACY_AGENT_FILE,
  ].filter(Boolean);
}

export function applyStableEvolverDefaults() {
  for (const [key, value] of Object.entries(stableEvolverDefaults)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

export function loadAgentEnv() {
  let loaded = null;
  for (const agentFile of candidateAgentFiles()) {
    if (!existsSync(agentFile)) continue;
    const agent = JSON.parse(readFileSync(agentFile, 'utf8'));
    loaded = { ...agent, file: agentFile };
    if (!process.env.A2A_NODE_ID && agent.node_id) process.env.A2A_NODE_ID = agent.node_id;
    if (!process.env.A2A_NODE_SECRET && agent.node_secret) process.env.A2A_NODE_SECRET = agent.node_secret;
    if (!process.env.EVOLVER_MODEL_NAME && agent.model) process.env.EVOLVER_MODEL_NAME = agent.model;
    if (!process.env.EVOLVER_AGENT_NAME && agent.name) process.env.EVOLVER_AGENT_NAME = agent.name;
    if (!process.env.AGENT_NAME && (agent.name || process.env.EVOLVER_AGENT_NAME)) {
      process.env.AGENT_NAME = agent.name || process.env.EVOLVER_AGENT_NAME;
    }
    if (agent.hub_url && (!process.env.A2A_HUB_URL || process.env.A2A_HUB_URL === stableEvolverDefaults.A2A_HUB_URL)) {
      process.env.A2A_HUB_URL = agent.hub_url;
    }
    if (agent.hub_url && (!process.env.EVOMAP_HUB_URL || process.env.EVOMAP_HUB_URL === stableEvolverDefaults.A2A_HUB_URL)) {
      process.env.EVOMAP_HUB_URL = agent.hub_url;
    }
    break;
  }

  if (!loaded && process.env.A2A_NODE_ID && process.env.A2A_NODE_SECRET) {
    loaded = {
      node_id: process.env.A2A_NODE_ID,
      node_secret: process.env.A2A_NODE_SECRET,
      name: process.env.EVOLVER_AGENT_NAME || process.env.AGENT_NAME,
      model: process.env.EVOLVER_MODEL_NAME,
      source: 'environment variables',
      file: null,
    };
  }

  return loaded;
}

export function applyEvolverEnv() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  applyStableEvolverDefaults();
  const agent = loadAgentEnv();
  return { agent };
}

export function printableEvolverEnv() {
  const keys = [
    'A2A_HUB_URL',
    'A2A_NODE_ID',
    'A2A_NODE_SECRET',
    'EVOLVER_MODEL_NAME',
    'EVOLVER_AGENT_NAME',
    'EVOLVER_SESSION_SCOPE',
    'WORKER_ENABLED',
    'WORKER_DOMAINS',
    'WORKER_MAX_LOAD',
    'EVOLVER_ATP_AUTOBUY',
    'ATP_AUTOBUY_DAILY_CAP_CREDITS',
    'ATP_AUTOBUY_PER_ORDER_CAP_CREDITS',
    'EVOLVER_VALIDATOR_ENABLED',
    'EVOLVER_AUTO_PUBLISH',
    'EVOLVER_DEFAULT_VISIBILITY',
    'EVOLVER_ROLLBACK_MODE',
  ];
  return Object.fromEntries(keys.map((key) => [
    key,
    key.includes('SECRET') && process.env[key] ? '[redacted]' : process.env[key] || '',
  ]));
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/secret|token|authorization|password|credential/i.test(key)) return [key, '[redacted]'];
    return [key, redact(item)];
  }));
}
