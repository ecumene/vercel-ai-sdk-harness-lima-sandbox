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
`provider.mjs` (the function you attach to the harness), and `pi-spawn.mjs` /
`pi-cleanup.mjs` (run agents / tear down).

## Run it

```bash
limactl start --tty=false --name=fc fcsandbox/lima-fc.yaml          # 1. create the VM (once)
limactl shell fc -- bash -lc \
  'export FC_STATE_DIR=$HOME/fcstate PORT=7070; cd '"$PWD"'; bash fcsandbox/server.sh'  # 2. start the server
npm run agents      # 3. spawn agent sandboxes, then open http://127.0.0.1:7070/
npm run cleanup     #    tear them down when done
```

## Dashboard

The control plane serves a live dashboard showing every microVM — status, CPU,
memory, uptime, command history, and live in-guest metrics on click.

![Firecracker sandboxes dashboard](dashboard.png)
