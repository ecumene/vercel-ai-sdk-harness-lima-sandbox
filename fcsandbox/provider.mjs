// createFirecrackerSandbox — the single function you attach to a HarnessAgent,
// exactly like createVercelSandbox. It is a thin HTTP client to our control
// plane (the analog of @vercel/sandbox talking to vercel.com/api). It performs
// NO compute itself; every run/spawn/file op is a REST call the control plane
// brokers to the microVM (or local driver).
//
//   const provider = createFirecrackerSandbox({ baseUrl: 'http://127.0.0.1:7070' });
//   const agent = new HarnessAgent({ harness: createPi(...), sandbox: provider });
//
// Implements HarnessV1SandboxProvider -> HarnessV1NetworkSandboxSession. Suited
// to host-runtime harnesses (Pi): no exposed ports, so getPortUrl throws.

import { randomUUID } from 'node:crypto';

const PROVIDER_ID = 'firecracker-sandbox';

export function createFirecrackerSandbox(settings = {}) {
  const baseUrl = (settings.baseUrl || 'http://127.0.0.1:7070').replace(/\/$/, '');
  const token = settings.token || process.env.FC_TOKEN || '';
  const create = settings; // { name?, runtime?, env? }

  const api = async (path, { method = 'POST', body, signal } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal,
    });
    return res;
  };
  const apiJson = async (path, opts) => {
    const res = await api(path, opts);
    if (!res.ok) throw new Error(`control-plane ${path} -> ${res.status}: ${await res.text()}`);
    return res.json();
  };

  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: PROVIDER_ID,

    async createSession(options = {}) {
      options.abortSignal?.throwIfAborted();
      const name = create.name || `harness-${options.sessionId || randomUUID()}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
      const { sandbox, session } = await apiJson('/v2/sandboxes', {
        body: { name, runtime: create.runtime, env: create.env },
        signal: options.abortSignal,
      });

      const sessionId = session.id;
      const base = makeSandboxSession({ api, apiJson, sessionId, cwd: session.cwd });

      const netSession = {
        ...base,
        id: sandbox.name,
        defaultWorkingDirectory: session.cwd,
        ports: [],
        getPortUrl: async () => {
          throw new Error(
            `${PROVIDER_ID} does not expose ports (host-runtime harnesses only).`,
          );
        },
        stop: async () => {
          await api(`/v2/sandboxes/sessions/${sessionId}/stop`).catch(() => {});
        },
        destroy: async () => {
          await api(`/v2/sandboxes/${encodeURIComponent(sandbox.name)}`, { method: 'DELETE' }).catch(() => {});
        },
        restricted: () => base,
      };

      if (options.onFirstCreate) {
        await options.onFirstCreate(base, { abortSignal: options.abortSignal });
      }
      return netSession;
    },
  };
}

// The bare SandboxSession surface (file I/O + run/spawn), all over REST.
function makeSandboxSession({ api, apiJson, sessionId, cwd }) {
  const cmdPath = `/v2/sandboxes/sessions/${sessionId}/cmd`;

  // Consume the control plane's NDJSON command stream, dispatching frames.
  async function streamCmd({ command, workingDirectory, env, signal }, handlers) {
    const res = await api(cmdPath, {
      body: { command, cwd: workingDirectory, env },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`cmd failed: ${res.status} ${await res.text().catch(() => '')}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let exitCode = 0;
    let timedOut = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'chunk') handlers.onChunk?.(frame.stream, frame.data);
        else if (frame.type === 'exit') { exitCode = frame.exitCode; timedOut = !!frame.timedOut; }
      }
    }
    return { exitCode, timedOut };
  }

  async function run({ command, workingDirectory, env, abortSignal }) {
    let stdout = '';
    let stderr = '';
    const { exitCode, timedOut } = await streamCmd(
      { command, workingDirectory, env, signal: abortSignal },
      { onChunk: (stream, data) => (stream === 'stdout' ? (stdout += data) : (stderr += data)) },
    );
    return { exitCode, stdout, stderr, timedOut };
  }

  function spawn({ command, workingDirectory, env, abortSignal }) {
    const enc = new TextEncoder();
    let outCtl;
    let errCtl;
    // Own controller so kill() can terminate the run; chain the caller's signal.
    const ctl = new AbortController();
    abortSignal?.addEventListener('abort', () => ctl.abort(), { once: true });
    const stdout = new ReadableStream({ start: (c) => (outCtl = c) });
    const stderr = new ReadableStream({ start: (c) => (errCtl = c) });
    const done = streamCmd(
      { command, workingDirectory, env, signal: ctl.signal },
      {
        onChunk: (stream, data) =>
          (stream === 'stdout' ? outCtl : errCtl).enqueue(enc.encode(data)),
      },
    )
      .then((r) => {
        outCtl.close();
        errCtl.close();
        return r;
      })
      .catch((e) => {
        try { outCtl.error(e); errCtl.error(e); } catch {}
        return { exitCode: 1 };
      });
    return Promise.resolve({
      stdout,
      stderr,
      wait: () => done,
      kill: async () => ctl.abort(),
    });
  }

  async function readBinaryFile({ path }) {
    const res = await api(`/v2/sandboxes/sessions/${sessionId}/fs/read`, { body: { path } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const { contentB64 } = await res.json();
    return new Uint8Array(Buffer.from(contentB64, 'base64'));
  }
  async function readFile(opts) {
    const bytes = await readBinaryFile(opts);
    if (bytes == null) return null;
    return new ReadableStream({ start: (c) => { c.enqueue(bytes); c.close(); } });
  }
  async function readTextFile({ path, encoding = 'utf-8', startLine, endLine }) {
    const bytes = await readBinaryFile({ path });
    if (bytes == null) return null;
    let text = Buffer.from(bytes).toString(encoding === 'utf-8' ? 'utf8' : encoding);
    if (startLine != null || endLine != null) {
      const lines = text.split('\n');
      text = lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join('\n');
    }
    return text;
  }
  async function writeBinaryFile({ path, content }) {
    await apiJson(`/v2/sandboxes/sessions/${sessionId}/fs/write`, {
      body: { path, contentB64: Buffer.from(content).toString('base64') },
    });
  }
  async function writeTextFile({ path, content, encoding = 'utf-8' }) {
    await writeBinaryFile({ path, content: Buffer.from(content, encoding === 'utf-8' ? 'utf8' : encoding) });
  }
  async function writeFile({ path, content }) {
    const chunks = [];
    for await (const c of content) chunks.push(Buffer.from(c));
    await writeBinaryFile({ path, content: Buffer.concat(chunks) });
  }

  return {
    description: `Firecracker sandbox (session ${sessionId}). Working dir: ${cwd}. No exposed ports.`,
    run,
    spawn,
    readFile,
    readBinaryFile,
    readTextFile,
    writeFile,
    writeBinaryFile,
    writeTextFile,
  };
}
