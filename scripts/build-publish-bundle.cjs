#!/usr/bin/env node

const { buildPublishBundle } = require('@evomap/evolver/src/gep/a2aProtocol.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const agent = input.agent || {};
    if (!agent.node_id || !input.secret) {
      throw new Error('Missing agent.node_id or secret.');
    }
    process.env.A2A_NODE_ID = agent.node_id;
    process.env.A2A_NODE_SECRET = input.secret;
    process.env.AGENT_NAME = agent.name || process.env.AGENT_NAME || 'EvoMap Runner Lite Agent';
    const message = buildPublishBundle({ gene: input.gene, capsule: input.capsule });
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (err) {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  }
});
