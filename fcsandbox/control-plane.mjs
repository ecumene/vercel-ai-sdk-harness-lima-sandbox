// Control plane — the only thing that talks to the data plane (drivers/VMs).
// Mirrors the shape of Vercel's sandbox API: stateless HTTP service over a DB,
// brokering commands and file I/O against a per-sandbox "session".
//
//   POST   /v2/sandboxes                              create sandbox + session
//   GET    /v2/sandboxes/:name                        fetch sandbox
//   DELETE /v2/sandboxes/:name                        destroy sandbox
//   POST   /v2/sandboxes/sessions/:id/cmd             run/spawn (NDJSON stream)
//   POST   /v2/sandboxes/sessions/:id/fs/write        write file
//   POST   /v2/sandboxes/sessions/:id/fs/read         read file
//   POST   /v2/sandboxes/sessions/:id/stop            stop session
//
// Dashboard:
//   GET    /                                            live HTML dashboard
//   GET    /api/sandboxes                               enriched VM list + summary
//   GET    /api/sandboxes/:name/metrics                 live in-VM metrics
//
// Run: node fcsandbox/control-plane.mjs   (PORT=7070  FC_STATE_DIR=...)

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { openDb } from './db.mjs';
import { createFirecrackerDriver } from './drivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.FC_STATE_DIR || join(HERE, '.state');
const PORT = Number(process.env.PORT || 7070);
// Bind loopback-only by default; exposing the port == handing out root-in-guest.
const HOST = process.env.HOST || (process.env.FC_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1');
const TOKEN = process.env.FC_TOKEN || ''; // when set, every request must present it
const CLOCK_HZ = 100; // USER_HZ on Linux

// Constant-time-ish bearer check. Empty TOKEN disables auth (loopback dev).
function authorized(req) {
  if (!TOKEN) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

const db = await openDb(join(STATE_DIR, 'control-plane.db'));
const driver = createFirecrackerDriver();

const sandboxKey = (name) => `sandbox:${name}`;
const sessionKey = (id) => `session:${id}`;
const rid = (p) => `${p}-${randomUUID().slice(0, 8)}`;

// In-memory per-sandbox command activity for the dashboard.
const cmdStats = new Map(); // name -> { total, running, last }
const statsFor = (name) => {
  let s = cmdStats.get(name);
  if (!s) cmdStats.set(name, (s = { total: 0, running: 0, last: null }));
  return s;
};

// Find the firecracker host process for a sandbox by matching its api-sock in
// /proc/<pid>/cmdline, then read RSS + cumulative CPU from /proc. Lets the
// dashboard show real host-side resource use per microVM.
function hostStats(name) {
  const sock = join(STATE_DIR, 'vms', name, 'fc.sock');
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmdline;
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        continue;
      }
      const argv = cmdline.split('\0');
      if (!argv.some((a) => a === sock)) continue;
      if (!(argv[0] || '').includes('firecracker')) continue; // skip the sudo wrapper
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const utime = Number(fields[11] || 0);
      const stime = Number(fields[12] || 0);
      return { pid: Number(pid), alive: true, rssMiB: +(rssKb / 1024).toFixed(1), cpuSeconds: +((utime + stime) / CLOCK_HZ).toFixed(2) };
    }
  } catch {}
  return { pid: null, alive: false, rssMiB: 0, cpuSeconds: 0 };
}

// Live guest metrics gathered by exec-ing a single compact command in the VM.
const METRICS_CMD = [
  'echo UPTIME $(cut -d" " -f1 /proc/uptime)',
  'echo LOAD $(cut -d" " -f1-3 /proc/loadavg)',
  'echo MEMKB $(grep -E "^(MemTotal|MemAvailable):" /proc/meminfo | tr -s " " | cut -d" " -f2 | paste -sd" ")',
  'echo DISK $(df -Pm /workspace 2>/dev/null | tail -1 | tr -s " " | cut -d" " -f2-5)',
  'echo PROCS $(ls -d /proc/[0-9]* | wc -l)',
].join('; ');

function parseMetrics(out) {
  const m = {};
  for (const line of out.split('\n')) {
    const [k, ...rest] = line.trim().split(/\s+/);
    m[k] = rest;
  }
  const memKb = (m.MEMKB || []).map(Number);
  const disk = (m.DISK || []).map((x) => x.replace('%', ''));
  return {
    uptimeSec: Number(m.UPTIME?.[0] || 0),
    load: (m.LOAD || []).map(Number),
    memTotalMiB: memKb[0] ? Math.round(memKb[0] / 1024) : null,
    memUsedMiB: memKb[0] && memKb[1] ? Math.round((memKb[0] - memKb[1]) / 1024) : null,
    diskTotalMiB: Number(disk[0] || 0),
    diskUsedMiB: Number(disk[1] || 0),
    diskUsePct: Number(disk[3] || 0),
    procs: Number(m.PROCS?.[0] || 0),
  };
}

const readJson = (req) =>
  new Promise((res, rej) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        res(raw ? JSON.parse(raw) : {});
      } catch (e) {
        rej(e);
      }
    });
    req.on('error', rej);
  });

const sendJson = (res, status, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};

function loadSession(id) {
  const session = db.get(sessionKey(id));
  if (!session) return null;
  const rec = db.get(sandboxKey(session.sandboxName));
  if (!rec) return null;
  return { session, rec };
}

async function handleCreate(req, res) {
  const body = await readJson(req);
  const name = body.name || rid('sb');
  const existing = db.get(sandboxKey(name));
  if (existing) {
    // An in-flight create (no state yet) means someone else is provisioning this name.
    if (!existing.state) return sendJson(res, 409, { error: 'provisioning' });
    return sendJson(res, 200, toCreateResponse(existing));
  }
  const rec = {
    name,
    runtime: body.runtime || 'node24',
    env: body.env || {},
    createdAt: Date.now(),
    status: 'running',
  };
  // Reserve the name synchronously before the async boot so concurrent creates collide.
  db.set(sandboxKey(name), rec);
  try {
    rec.state = await driver.create(rec);
  } catch (err) {
    db.del(sandboxKey(name)); // release the reservation so the name is retryable
    throw err;
  }
  rec.cwd = rec.state.cwd;
  const sessionId = rid('sess');
  rec.sessionId = sessionId;
  db.set(sandboxKey(name), rec);
  db.set(sessionKey(sessionId), { id: sessionId, sandboxName: name, cwd: rec.cwd, createdAt: Date.now() });
  sendJson(res, 201, toCreateResponse(rec));
}

const toCreateResponse = (rec) => ({
  sandbox: { name: rec.name, status: rec.status, runtime: rec.runtime, cwd: rec.cwd },
  session: { id: rec.sessionId, cwd: rec.cwd, status: rec.status },
});

// Streamed command execution. Frames (NDJSON):
//   {"type":"start","cmdId":"..."}
//   {"type":"chunk","stream":"stdout"|"stderr","data":"..."}
//   {"type":"exit","exitCode":N}
async function handleCmd(req, res, sessionId) {
  const found = loadSession(sessionId);
  if (!found) return sendJson(res, 404, { error: 'session_not_found' });
  const body = await readJson(req);
  const { command, args = [], cwd, env, timeout } = body;
  const full = args.length ? `${command} ${args.join(' ')}` : command;

  const proc = driver.spawnProc(found.rec, { command: full, workingDirectory: cwd, env });
  const cmdId = rid('cmd');
  const stats = statsFor(found.rec.name);
  stats.total += 1;
  stats.running += 1;
  const startedAt = Date.now();

  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  write({ type: 'start', cmdId });

  const onAbort = () => proc.kill();
  req.on('close', () => {
    if (!res.writableEnded) onAbort();
  });

  proc.stdout.on('data', (d) => write({ type: 'chunk', stream: 'stdout', data: d.toString('utf8') }));
  proc.stderr.on('data', (d) => write({ type: 'chunk', stream: 'stderr', data: d.toString('utf8') }));

  let timer;
  let timedOut = false;
  if (timeout) timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeout);
  const { exitCode } = await proc.wait();
  if (timer) clearTimeout(timer);
  stats.running -= 1;
  stats.last = {
    command: full.length > 120 ? full.slice(0, 117) + '…' : full,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    at: Date.now(),
  };
  write({ type: 'exit', exitCode, timedOut });
  res.end();
}

// Enriched view of all sandboxes for the dashboard.
function listSandboxes() {
  const items = db.list('sandbox:').map(([, rec]) => {
    const host = rec.status === 'running' ? hostStats(rec.name) : { pid: rec.state?.pid ?? null, alive: false, rssMiB: 0, cpuSeconds: 0 };
    const stats = cmdStats.get(rec.name) || { total: 0, running: 0, last: null };
    return {
      name: rec.name,
      status: host.alive ? rec.status : rec.status === 'running' ? 'unreachable' : rec.status,
      runtime: rec.runtime,
      sessionId: rec.sessionId,
      ip: rec.state?.ip ?? null,
      tap: rec.state?.tap ?? null,
      vcpus: rec.state?.vcpus ?? null,
      memMib: rec.state?.memMib ?? null,
      cwd: rec.cwd,
      createdAt: rec.createdAt,
      uptimeSec: Math.max(0, Math.round((Date.now() - rec.createdAt) / 1000)),
      host,
      commands: stats,
    };
  });
  items.sort((a, b) => b.createdAt - a.createdAt);
  const running = items.filter((i) => i.status === 'running');
  return {
    summary: {
      total: items.length,
      running: running.length,
      vcpus: running.reduce((s, i) => s + (i.vcpus || 0), 0),
      memMib: running.reduce((s, i) => s + (i.memMib || 0), 0),
      rssMiB: +running.reduce((s, i) => s + (i.host.rssMiB || 0), 0).toFixed(1),
      commands: items.reduce((s, i) => s + (i.commands.total || 0), 0),
    },
    sandboxes: items,
  };
}

async function handleMetrics(req, res, name) {
  const rec = db.get(sandboxKey(name));
  if (!rec || rec.status !== 'running') return sendJson(res, 404, { error: 'not_found' });
  try {
    const proc = driver.spawnProc(rec, { command: METRICS_CMD });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    await proc.wait();
    sendJson(res, 200, parseMetrics(out));
  } catch (err) {
    sendJson(res, 502, { error: 'metrics_failed', message: String(err?.message || err) });
  }
}

function serveUi(res) {
  try {
    const html = readFileSync(join(HERE, 'ui.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
    res.end(html);
  } catch {
    sendJson(res, 500, { error: 'ui_missing' });
  }
}

async function handleWrite(req, res, sessionId) {
  const found = loadSession(sessionId);
  if (!found) return sendJson(res, 404, { error: 'session_not_found' });
  const { path, contentB64 } = await readJson(req);
  await driver.writeFile(found.rec, { path, content: Buffer.from(contentB64, 'base64') });
  sendJson(res, 200, { ok: true });
}

async function handleRead(req, res, sessionId) {
  const found = loadSession(sessionId);
  if (!found) return sendJson(res, 404, { error: 'session_not_found' });
  const { path } = await readJson(req);
  const buf = await driver.readFile(found.rec, { path });
  if (buf == null) return sendJson(res, 404, { error: 'not_found' });
  sendJson(res, 200, { contentB64: Buffer.from(buf).toString('base64') });
}

async function handleStop(req, res, sessionId) {
  const found = loadSession(sessionId);
  if (!found) return sendJson(res, 404, { error: 'session_not_found' });
  await driver.stop(found.rec);
  found.rec.status = 'stopped';
  db.set(sandboxKey(found.rec.name), found.rec);
  sendJson(res, 200, { ok: true });
}

async function handleDestroy(req, res, name) {
  const rec = db.get(sandboxKey(name));
  if (!rec) return sendJson(res, 404, { error: 'not_found' });
  await driver.destroy(rec);
  db.del(sandboxKey(name));
  if (rec.sessionId) db.del(sessionKey(rec.sessionId));
  sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    if (p === '/health') return sendJson(res, 200, { ok: true, driver: driver.id, db: db.backend });
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

    if (m === 'GET' && (p === '/' || p === '/ui')) return serveUi(res);
    if (m === 'GET' && p === '/api/sandboxes') return sendJson(res, 200, listSandboxes());

    if (m === 'POST' && p === '/v2/sandboxes') return await handleCreate(req, res);

    let mm;
    if ((mm = p.match(/^\/api\/sandboxes\/([^/]+)\/metrics$/)) && m === 'GET')
      return await handleMetrics(req, res, mm[1]);

    if ((mm = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/cmd$/)) && m === 'POST')
      return await handleCmd(req, res, mm[1]);
    if ((mm = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/fs\/write$/)) && m === 'POST')
      return await handleWrite(req, res, mm[1]);
    if ((mm = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/fs\/read$/)) && m === 'POST')
      return await handleRead(req, res, mm[1]);
    if ((mm = p.match(/^\/v2\/sandboxes\/sessions\/([^/]+)\/stop$/)) && m === 'POST')
      return await handleStop(req, res, mm[1]);

    if ((mm = p.match(/^\/v2\/sandboxes\/([^/]+)$/))) {
      if (m === 'GET') {
        const rec = db.get(sandboxKey(mm[1]));
        return rec ? sendJson(res, 200, toCreateResponse(rec)) : sendJson(res, 404, { error: 'not_found' });
      }
      if (m === 'DELETE') return await handleDestroy(req, res, mm[1]);
    }

    sendJson(res, 404, { error: 'route_not_found', path: p });
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String(err?.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[control-plane] listening on ${HOST}:${PORT}  driver=${driver.id}  db=${db.backend}`);
});
