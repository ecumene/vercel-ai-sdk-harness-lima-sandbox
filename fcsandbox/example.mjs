// example.mjs — connect an AI SDK HarnessAgent to the running sandbox server.
//
// This is the whole integration: point createFirecrackerSandbox at the server,
// pass it to a HarnessAgent as `sandbox`, and run a turn. The agent's session
// gets its own Firecracker microVM; every tool call is brokered there.
//
// Run (server must already be up — see README):
//   ANTHROPIC_API_KEY=sk-... node fcsandbox/example.mjs "Write hello.txt with a haiku, then cat it"

import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createPi } from '@ai-sdk/harness-pi';
import { createFirecrackerSandbox } from './provider.mjs';

const SERVER = process.env.FC_SERVER || 'http://127.0.0.1:7070';
const KEY = process.env.ANTHROPIC_API_KEY || process.env.BACKEND_ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}
const prompt =
  process.argv.slice(2).join(' ') || 'Write hello.txt with a haiku about tiny VMs, then cat it.';

// 1. The sandbox: a thin client to the firecracker server. (token only needed
//    if you started the server with FC_TOKEN set.)
const sandbox = createFirecrackerSandbox({ baseUrl: SERVER, token: process.env.FC_TOKEN });

// 2. The agent: any harness + our sandbox. The model API key stays in this
//    process and is never sent to the server or the microVM.
const agent = new HarnessAgent({
  harness: createPi({
    model: process.env.MODEL || 'anthropic/claude-sonnet-4-5',
    auth: { customEnv: { ANTHROPIC_API_KEY: KEY } },
  }),
  sandbox,
  permissionMode: 'allow-all',
  instructions: 'You are a coding agent inside an isolated Firecracker microVM. Use your tools.',
});

// 3. Run a turn. createSession() spins up the microVM on the server.
const session = await agent.createSession();
try {
  const result = await agent.stream({ session, prompt });
  for await (const part of result.stream) {
    if (part.type === 'text-delta') process.stdout.write(part.text);
    else if (part.type === 'tool-call') process.stdout.write(`\n· ${part.toolName}\n`);
  }
  console.log();
} finally {
  // Destroy the microVM when done. Comment this out to leave it running so you
  // can inspect it in the dashboard at http://127.0.0.1:7070/.
  await session.destroy();
}
