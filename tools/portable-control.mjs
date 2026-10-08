import { ForemanClient } from './lib/foremanclient.mjs';
const port = Number(process.argv[2] || 7878);
let client;
try {
  client = await ForemanClient.connect({ port, timeoutMs: 1200, client: 'portable-status' });
  console.log(JSON.stringify({ running: true, backend: client.state.foreman?.backend, port }));
} catch {
  console.log(JSON.stringify({ running: false, port }));
} finally { client?.close(); }
