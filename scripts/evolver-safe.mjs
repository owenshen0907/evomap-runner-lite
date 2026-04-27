import { spawn } from 'node:child_process';
import { applyEvolverEnv, printableEvolverEnv } from './evolver-env.mjs';

applyEvolverEnv();

const args = process.argv.slice(2);

if (args.includes('--print-env')) {
  console.log(JSON.stringify(printableEvolverEnv(), null, 2));
  process.exit(0);
}

const child = spawn('npx', ['@evomap/evolver', ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
