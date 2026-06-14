// Firecracker compute driver. One Firecracker microVM per sandbox, driven by
// firecracker-sandbox.sh. Real kernel-level isolation; Linux + /dev/kvm only
// (here: inside the Lima nested-virt VM on the Mac, or an EC2 *.metal host).
//
// Driver interface used by the control plane:
//   create(rec)                  -> { cwd, ip, pid, ... }   provision a microVM
//   spawnProc(rec, opts)         -> { stdout, stderr, wait(), kill() }
//   writeFile(rec, {path,content})
//   readFile(rec, {path})        -> Buffer | null
//   stop(rec) / destroy(rec)

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'firecracker-sandbox.sh');

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Remote script fed to `exec` over the VM's stdin: export env, cd, run command.
function remoteScript({ command, cwd, env }) {
  const exports = Object.entries(env || {})
    .filter(([k]) => {
      if (VALID_ENV_KEY.test(k)) return true;
      throw new Error(`invalid env var name: ${JSON.stringify(k)}`);
    })
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join('\n');
  return `${exports}\ncd ${shq(cwd)} 2>/dev/null || true\n${command}\n`;
}

function runScript(args, { input } = {}) {
  return new Promise((res, rej) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', rej);
    child.on('close', (code) =>
      res({
        code: code ?? 0,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    if (input != null) child.stdin.end(input);
  });
}

export function createFirecrackerDriver({ cwd = '/workspace' } = {}) {
  return {
    id: 'firecracker',

    async create(rec) {
      const { code, stdout, stderr } = await runScript(['start', rec.name]);
      if (code !== 0) throw new Error(`firecracker start failed: ${stderr}`);
      const info = JSON.parse(stdout.toString('utf8').trim().split('\n').pop());
      return { ip: info.ip, pid: info.pid, tap: info.tap, vcpus: info.vcpus, memMib: info.mem_mib, cwd };
    },

    spawnProc(rec, { command, workingDirectory, env }) {
      const script = remoteScript({
        command,
        cwd: workingDirectory || rec.state.cwd,
        env: { ...rec.env, ...env },
      });
      const child = spawn('bash', [SCRIPT, 'exec', rec.name], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(script);
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () =>
          new Promise((res) => child.on('close', (code) => res({ exitCode: code ?? 0 }))),
        kill: () => child.kill('SIGKILL'),
      };
    },

    async writeFile(rec, { path, content }) {
      const b64 = Buffer.from(content).toString('base64');
      const { code, stderr } = await runScript(['write', rec.name, path], { input: b64 });
      if (code !== 0) throw new Error(`firecracker write failed: ${stderr}`);
    },

    async readFile(rec, { path }) {
      const { code, stdout, stderr } = await runScript(['read', rec.name, path]);
      if (code === 44) return null; // file genuinely not found
      if (code !== 0) throw new Error(`firecracker read failed (${code}): ${stderr}`);
      return Buffer.from(stdout.toString('utf8').trim(), 'base64');
    },

    async stop(rec) {
      await runScript(['stop', rec.name]).catch(() => {});
    },

    async destroy(rec) {
      await runScript(['destroy', rec.name]).catch(() => {});
    },
  };
}
