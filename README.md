# Firecracker sandboxes for AI agent harnesses

A small, self-hosted clone of Vercel Sandbox. Every AI agent session runs in its
own **Firecracker microVM** (dedicated kernel, private filesystem, own network),
so multiple coding agents run in parallel, fully isolated from each other and the
host. It plugs into the AI SDK `HarnessAgent` with one function — just like
Vercel's sandbox, but running on your own machine.

## How it works

Two sides, connected by plain HTTP:

```
  YOUR MAC                                THE LINUX VM (has /dev/kvm)
  Pi HarnessAgent                         control-plane.mjs ("the server")
   └─ createFirecrackerSandbox()  ──HTTP──▶  REST API + dashboard
      (model API key stays here)   :7070     └─ spawns one microVM per session
                                                vm1 · vm2 · vm3  (separate kernels)
```

- The **harness** runs on your Mac and only makes HTTP calls — it never touches a
  VM directly (same as `@vercel/sandbox` only talking to `vercel.com/api`).
- The **control plane** runs inside a Linux VM (Firecracker needs `/dev/kvm`) and
  brokers every command and file op into the right microVM.
- Each **microVM** is a real, separate machine. On a Mac the Linux VM is provided
  by Lima with nested virtualization (Apple Silicon M3+/macOS 15+); on a Linux
  `.metal` host you run the server directly.

See `fcsandbox/` for the pieces: `firecracker-sandbox.sh` (boots microVMs),
`control-plane.mjs` (server + dashboard), `drivers.mjs`, `db.mjs`, `ui.html`,
`provider.mjs` (the function you attach to the harness), `example.mjs` (a minimal
agent), and `pi-cleanup.mjs` (tear down).

## Minimal setup

### 1. Start the server (once)

```bash
limactl start --tty=false --name=fc fcsandbox/lima-fc.yaml          # create the Linux VM (one time)
limactl shell fc -- bash -lc \
  'export FC_STATE_DIR=$HOME/fcstate PORT=7070; cd '"$PWD"'; bash fcsandbox/server.sh'
```

On a Linux `.metal` host, skip Lima and just run `bash fcsandbox/server.sh`.

### 2. Write your harness agent

Point `createFirecrackerSandbox` at the server and pass it to a `HarnessAgent`
(full version in `fcsandbox/example.mjs`):

```js
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createPi } from '@ai-sdk/harness-pi';
import { createFirecrackerSandbox } from './fcsandbox/provider.mjs';

const sandbox = createFirecrackerSandbox({ baseUrl: 'http://127.0.0.1:7070' });

const agent = new HarnessAgent({
  harness: createPi({
    model: 'anthropic/claude-sonnet-4-5',
    auth: { customEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } },
  }),
  sandbox,                 // ← each session runs in its own Firecracker microVM
  permissionMode: 'allow-all',
});

const session = await agent.createSession();
const result = await agent.stream({ session, prompt: 'Write hello.txt with a haiku, then cat it.' });
for await (const part of result.stream) {
  if (part.type === 'text-delta') process.stdout.write(part.text);
}
await session.destroy();   // or leave it running to watch in the dashboard
```

### 3. Run it

```bash
ANTHROPIC_API_KEY=sk-... node fcsandbox/example.mjs "Build a small CLI todo app"
```

### 4. Done

Watch it live at **http://127.0.0.1:7070/**. Clean up any sandboxes you left
running with `npm run cleanup`.

## Dashboard

The control plane serves a live dashboard showing every microVM — status, CPU,
memory, uptime, command history, and live in-guest metrics on click.

![Firecracker sandboxes dashboard](dashboard.png)
