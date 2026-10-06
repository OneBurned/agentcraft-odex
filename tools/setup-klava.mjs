// Prepare a local reviewer workspace. Never restarts the bridge or changes GitHub permissions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[index + 1]); };
const directory = option('--workspace');
const tradeRecord = option('--traderecord');
const profile = option('--profile-dir');
for (const repo of [tradeRecord, root]) await fs.access(path.join(repo, '.git'));
await fs.mkdir(directory, { recursive: true });
for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) {
  try { await fs.copyFile(path.join(root, 'tools/klava', name), path.join(directory, name), fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const access = { version: 1, repositories: [
  { id: 'traderecord', name: 'TradeRecord', path: tradeRecord, github: 'OneBurned/TITracker' },
  { id: 'agentcraft', name: 'AgentCraft', path: root, github: 'OneBurned/agentcraft-odex' },
] };
async function preserveOrCreate(file, value) {
  try { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e;
    if (JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))) !== JSON.stringify(value)) throw new Error(`Existing configuration differs: ${file}`);
  }
}
await preserveOrCreate(path.join(directory, 'access.json'), access);
await fs.mkdir(profile, { recursive: true });
await preserveOrCreate(path.join(profile, 'claude-workspace.json'), { directory });
console.log(JSON.stringify({ prepared: true, directory, projects: access.repositories.map(r => r.github), restartRequired: true }));
