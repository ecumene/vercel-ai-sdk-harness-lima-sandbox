// pi-cleanup.mjs — destroy every sandbox the firecracker server knows about.
//   FC_SERVER=http://127.0.0.1:7070 node fcsandbox/pi-cleanup.mjs

const BASE_URL = (process.env.FC_SERVER || 'http://127.0.0.1:7070').replace(/\/$/, '');
const TOKEN = process.env.FC_TOKEN || '';
const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
const { sandboxes } = await (await fetch(`${BASE_URL}/api/sandboxes`, { headers })).json();
if (!sandboxes.length) { console.log('No sandboxes to clean up.'); process.exit(0); }
for (const sb of sandboxes) {
  const r = await fetch(`${BASE_URL}/v2/sandboxes/${encodeURIComponent(sb.name)}`, { method: 'DELETE', headers });
  console.log(`  ${r.ok ? 'destroyed' : 'failed   '} ${sb.name}`);
}
console.log(`Cleaned up ${sandboxes.length} sandbox(es).`);
