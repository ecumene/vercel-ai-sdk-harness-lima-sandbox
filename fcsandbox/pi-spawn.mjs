// pi-spawn.mjs — start N Pi sessions against the firecracker server and LEAVE
// the microVMs running so you can inspect them in the dashboard. Each session
// does a little work (write a file, run a couple commands) so the UI shows
// command activity, then the process exits WITHOUT destroying the VMs.
//
//   FC_SERVER=http://127.0.0.1:7070 N=3 \
//   node --env-file=/Users/mitchellhynes/work/spellbook/.env.dev fcsandbox/pi-spawn.mjs
//
// Clean up later with:  node fcsandbox/pi-cleanup.mjs

import { randomUUID } from 'node:crypto';
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createPi } from '@ai-sdk/harness-pi';
import { createFirecrackerSandbox } from './provider.mjs';

const BASE_URL = (process.env.FC_SERVER || 'http://127.0.0.1:7070').replace(/\/$/, '');
const N = Number(process.env.N || 3);
const KEY = process.env.ANTHROPIC_API_KEY || process.env.BACKEND_ANTHROPIC_API_KEY;
if (!KEY) { console.error('Missing ANTHROPIC_API_KEY / BACKEND_ANTHROPIC_API_KEY'); process.exit(1); }
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';

const prompts = [
  'Create notes.md with a haiku about tiny virtual machines, then list the files in your working directory.',
  'Write a file fib.js that prints the first 10 Fibonacci numbers, then run it with node.',
  'Create data.txt containing the numbers 1 to 20 one per line, then count the lines with wc -l.',
];

async function spawnOne(i) {
  const name = `pi-${i}-${randomUUID().slice(0, 6)}`;
  const provider = createFirecrackerSandbox({ baseUrl: BASE_URL, name });
  const agent = new HarnessAgent({
    harness: createPi({ model: MODEL, auth: { customEnv: { ANTHROPIC_API_KEY: KEY } } }),
    sandbox: provider,
    permissionMode: 'allow-all',
    instructions: 'You are a coding agent in an isolated Firecracker microVM. Use your tools.',
  });
  const session = await agent.createSession();
  const result = await agent.stream({ session, prompt: prompts[(i - 1) % prompts.length] });
  for await (const part of result.stream) { /* drain */ void part; }
  console.log(`  ✓ ${name} ready (left running)`);
  // NOTE: intentionally NOT calling session.destroy() — keep the VM alive.
}

console.log(`\nSpawning ${N} Pi sandboxes on ${BASE_URL} (leaving them running)…\n`);
await Promise.all(Array.from({ length: N }, (_, i) => spawnOne(i + 1)));
console.log(`\nDone. Open the dashboard:  ${BASE_URL}/`);
console.log('Clean up with:  node fcsandbox/pi-cleanup.mjs');
process.exit(0);
