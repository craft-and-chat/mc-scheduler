import { spawn, execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');

// Starts an isolated `wrangler dev --local` (own persist dir, fresh DB). Returns { base, stop }.
export async function startWorker({ port, vars = {} }) {
  const persist = path.join(root, `.wrangler-test-${port}`);
  rmSync(persist, { recursive: true, force: true });
  execFileSync(wrangler, ['d1', 'execute', 'mc-scheduler', '--local', '--persist-to', persist, '--file=schema.sql'], { cwd: root, stdio: 'pipe' });
  const args = ['dev', '--local', '--port', String(port), '--persist-to', persist, '--inspector-port', String(port + 1000)];
  for (const [k, v] of Object.entries({ ADMIN_KEY: 'testkey', DEV_FAKE_NOW_ALLOWED: '1', DAY_START_HOUR: '12', ...vars })) args.push('--var', `${k}:${v}`);
  const proc = spawn(wrangler, args, { cwd: root, stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(base + '/api/health')).status < 500) break; } catch { /* not up yet */ }
    if (Date.now() > deadline || proc.exitCode !== null) { proc.kill(); throw new Error('worker failed to start:\n' + log); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    base,
    stop: () => new Promise((res) => { proc.once('exit', res); proc.kill('SIGTERM'); setTimeout(() => { proc.kill('SIGKILL'); res(); }, 3000); }),
  };
}

export function client(base, defaults = {}) {
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...defaults, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  };
}
