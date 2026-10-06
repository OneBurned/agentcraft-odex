// Prepare a local reviewer workspace. Never restarts the bridge or changes GitHub permissions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[index + 1]); };
const directory = option('--workspace');
const tradeRecord = option('--traderecord');
const profile = option('--profile-dir');
const skillsRoot = args.includes('--skills') ? option('--skills') : undefined;
const update = args.includes('--update');
if (skillsRoot) await fs.access(path.join(skillsRoot, 'AGENTS.md'));
for (const repo of [tradeRecord, root]) await fs.access(path.join(repo, '.git'));
const read = async file => {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error(`Expected a regular file: ${file}`);
    return await fs.readFile(file, 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
};
const accessFile = path.join(directory, 'access.json');
const oldAccessText = await read(accessFile);
const oldAccess = oldAccessText === undefined ? undefined : JSON.parse(oldAccessText);
const effectiveSkills = skillsRoot ?? oldAccess?.skillsRoot;
if (effectiveSkills !== undefined) {
  if (typeof effectiveSkills !== 'string' || !path.isAbsolute(effectiveSkills)) throw new Error('skillsRoot must be an absolute directory path.');
  await fs.access(path.join(effectiveSkills, 'AGENTS.md'));
}
const access = { version: 1, ...(effectiveSkills ? { skillsRoot: effectiveSkills } : {}), repositories: [
  { id: 'traderecord', name: 'TradeRecord', path: tradeRecord, github: 'OneBurned/TITracker' },
  { id: 'agentcraft', name: 'AgentCraft', path: root, github: 'OneBurned/agentcraft-odex' },
] };
const changedAccess = oldAccess !== undefined && !isDeepStrictEqual(oldAccess, access);
if (changedAccess) {
  // The updater can add missing shared rules, never replace repositories or an existing root.
  const addingSkills = oldAccess.skillsRoot === undefined && effectiveSkills && isDeepStrictEqual({ ...oldAccess, skillsRoot: effectiveSkills }, access);
  if (!addingSkills) throw new Error(`Existing access differs; repositories and existing skillsRoot must be reviewed manually: ${accessFile}`);
  if (!update) throw new Error('Use --update with --skills to add shared rules to an existing workspace.');
}
const pointerFile = path.join(profile, 'claude-workspace.json');
const oldPointer = await read(pointerFile);
if (oldPointer !== undefined && !isDeepStrictEqual(JSON.parse(oldPointer), { directory })) throw new Error(`Existing profile points to another workspace: ${pointerFile}`);
const managedFile = path.join(directory, 'WORKSPACE.md');
const oldManaged = await read(managedFile);
const managed = await fs.readFile(path.join(root, 'tools/klava/WORKSPACE.md'), 'utf8');
const writeManaged = oldAccess === undefined || update;
// Validate existing user documents before any write. They are never replaced by an update.
for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) await read(path.join(directory, name));
await fs.mkdir(directory, { recursive: true });
let backup;
if (oldAccess !== undefined && (changedAccess || (writeManaged && oldManaged !== managed))) {
  const backups = path.join(directory, 'backups'); await fs.mkdir(backups, { recursive: true });
  backup = await fs.mkdtemp(path.join(backups, 'setup-'));
  for (const name of ['access.json', 'CLAUDE.md', 'PROJECTS.md', 'MEMORY.md', 'WORKSPACE.md']) {
    const content = await read(path.join(directory, name));
    if (content !== undefined) await fs.writeFile(path.join(backup, name), content, { flag: 'wx' });
  }
}
if (oldAccess === undefined || changedAccess) await fs.writeFile(accessFile, JSON.stringify(access, null, 2) + '\n');
for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md']) {
  try { await fs.copyFile(path.join(root, 'tools/klava', name), path.join(directory, name), fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
if (writeManaged && oldManaged !== managed) await fs.writeFile(managedFile, managed);
await fs.mkdir(profile, { recursive: true });
if (oldPointer === undefined) await fs.writeFile(pointerFile, JSON.stringify({ directory }, null, 2) + '\n', { flag: 'wx' });
// Tiny ASCII launchers handle paths with spaces and leave account credentials in the keyring.
const quote = value => `'${value.replaceAll("'", "''")}'`;
for (const [name, resume] of [['Start-Klava', false], ['Continue-Klava', true]]) {
  const ps = `$Host.UI.RawUI.WindowTitle = 'Klava - TradeRecord and AgentCraft'\r\n& ${quote(path.join(root, 'tools/open-klava.ps1'))} -Workspace ${quote(directory)}${resume ? ' -Continue' : ''}\r\n`;
  await fs.writeFile(path.join(directory, `${name}.ps1`), '\uFEFF' + ps, 'utf8');
  await fs.writeFile(path.join(directory, `${name}.cmd`), `@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0${name}.ps1"\r\nif errorlevel 1 pause\r\n`, 'utf8');
}
console.log(JSON.stringify({ prepared: true, directory, projects: access.repositories.map(r => r.github), backup, restartRequired: true,
  notice: oldAccess !== undefined && !update && oldManaged !== managed ? 'Run with --update to refresh WORKSPACE.md; personal instructions and memory will be preserved.' : undefined }));
