// Portable observer entry point. The SDK's local session readers do not start model runs.
import { loadConfig, FOREMAN_VERSION } from './config.js';
import { consoleLogger } from './context.js';
import { Foreman } from './foreman.js';
import { ForemanServer } from './server.js';
import { ObserverBackend } from './agents/observer.js';
import { claimRunFiles, liveOwner, profileRunFile, releaseRunFiles } from './runfile.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function main() {
  const cfg = loadConfig([...process.argv.slice(2), '--backend', 'observer']);
  cfg.host = '127.0.0.1';
  cfg.allowBrowserOrigins = false;
  cfg.notify = false;
  if (cfg.reset || cfg.goal || cfg.autostart) throw new Error('The portable observer accepts explicit progress updates only.');
  if (await liveOwner(profileRunFile(cfg.dataDir))) throw new Error('Observer profile is already running.');
  const log = consoleLogger('observer');
  const fm = new Foreman({ config: cfg, logger: log });
  const server = new ForemanServer(fm, { host: cfg.host, port: cfg.port, log });
  try {
    await server.start();
    await claimRunFiles(cfg.home, cfg.dataDir, { pid: process.pid, port: server.port, host: cfg.host,
      backend: 'observer', profile: cfg.profile, version: FOREMAN_VERSION, startedAt: new Date().toISOString() });
    await fm.start(new ObserverBackend(fm));
  } catch (e) {
    await server.stop();
    await fm.close();
    await releaseRunFiles(cfg.home, cfg.dataDir);
    throw e;
  }
  let stopping = false;
  const ownerFile = path.join(cfg.dataDir, 'portable.json');
  const stopFile = path.join(cfg.dataDir, 'portable-stop.json');
  const token = randomUUID();
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, port: server.port }));
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(stopTimer);
    await server.stop();
    await fm.close();
    await releaseRunFiles(cfg.home, cfg.dataDir);
    fs.rmSync(ownerFile, { force: true });
    fs.rmSync(stopFile, { force: true });
    process.exit(0);
  };
  // A local stop request allows a hidden Windows process to flush state before exiting.
  const stopTimer = setInterval(() => {
    try {
      const request = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
      if (request.token === token && request.pid === process.pid) void stop();
    } catch { /* no request */ }
  }, 500);
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGBREAK', () => void stop());
  log.info(`Codex observer ready: ws://${cfg.host}:${server.port}`);
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
