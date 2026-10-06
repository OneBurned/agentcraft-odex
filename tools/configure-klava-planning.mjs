// Explicit, backed-up activation of draft-only tools. No Claude turn or queue is started.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { claudeWorkspace } from '../foreman/src/claude-workspace.ts';
import { conversationLease } from '../foreman/src/claude-conversation.ts';
import { PlanningBinding, sameDirectory } from '../foreman/src/claude-planning.ts';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return args[i + 1]; };
const workspace = path.resolve(option('--workspace'));
const profile = path.resolve(option('--profile-dir'));
const port = Number(option('--port'));
claudeWorkspace(workspace);
const pointer = JSON.parse(await fs.readFile(path.join(profile, 'claude-workspace.json'), 'utf8'));
if (!sameDirectory(pointer.directory, workspace)) throw new Error('Profile is bound to another workspace.');
const read = async file => { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const old = await read(path.join(workspace, 'planning.json'));
const binding = PlanningBinding.parse(old ? JSON.parse(old) : { version: 1, workspace, profile, port, token: randomUUID() });
if (binding.port !== port || !sameDirectory(binding.workspace, workspace) || !sameDirectory(binding.profile, profile)) throw new Error('Another planning profile is already bound.');
const prior = await read(path.join(profile, 'planning.json'));
if (prior && JSON.stringify(PlanningBinding.parse(JSON.parse(prior))) !== JSON.stringify(binding)) throw new Error('Profile has a different planning binding.');
const settingsPath = path.join(workspace, '.claude/settings.json');
const settings = JSON.parse(await read(settingsPath) ?? '{}');
settings.permissions ??= {};
if (settings.permissions.allow !== undefined && !Array.isArray(settings.permissions.allow)) throw new Error('Invalid allow list.');
settings.permissions.allow = [...new Set([...(settings.permissions.allow ?? []), 'mcp__klava__planning_list', 'mcp__klava__planning_create'])];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map([
  ['WORKSPACE.md', await fs.readFile(path.join(root, 'tools/klava/WORKSPACE.md'), 'utf8')],
  ['.claude/settings.json', JSON.stringify(settings, null, 2) + '\n'],
  ['planning.json', JSON.stringify(binding, null, 2) + '\n'],
]);
const apply = args.includes('--apply');
const output = apply ? workspace : path.resolve(option('--prepare'));
const within = (root, target) => { const rel = path.relative(root, target); return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
if (!apply && (within(workspace, output) || within(profile, output))) throw new Error('Prepare outside the live workspace/profile.');
if (apply && conversationLease(workspace)) throw new Error('Return the conversation to the game and finish its reply before activation.');
let backup;
if (apply) {
  backup = path.join(workspace, 'backups', `planning-${randomUUID()}`); await fs.mkdir(backup, { recursive: true });
  for (const file of [...files.keys(), 'CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) {
    const old = await read(path.join(workspace, file));
    if (old !== undefined) { const target = path.join(backup, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, old); }
  }
  if (prior !== undefined) await fs.writeFile(path.join(backup, 'profile-planning.json'), prior);
}
const write = async (target, value) => { await fs.mkdir(path.dirname(target), { recursive: true }); const tmp = `${target}.${randomUUID()}.tmp`; await fs.writeFile(tmp, value, { flag: 'wx' }); await fs.rename(tmp, target); };
for (const [file, contents] of files) await write(path.join(output, file), contents);
// Both sides must agree: a partial workspace update cannot enable writes on another bridge.
await write(path.join(apply ? profile : output, apply ? 'planning.json' : 'profile-planning.json'), files.get('planning.json'));
console.log(JSON.stringify({ applied: apply, prepared: !apply, output, backup, port }));
