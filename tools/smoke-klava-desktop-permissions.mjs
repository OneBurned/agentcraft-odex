// Opt-in real CLI permission check in a disposable folder. No user conversation is resumed.
// The app's injected servers are represented by harmless local probes, not connected apps.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findClaude } from '../foreman/src/studio-review.ts';
import { klavaDesktopSettings } from './lib/klava-desktop-settings.mjs';

const exe = findClaude(); if (!exe) throw new Error('Claude CLI missing');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-desktop-permissions-'));
const calls = path.join(directory, 'calls.jsonl');
const server = path.join(directory, 'probe.cjs');
await fs.writeFile(server, `
const fs = require('fs');
const [name, log] = process.argv.slice(2);
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const q = JSON.parse(line); if (q.id === undefined) return;
  let result = {};
  if (q.method === 'initialize') result = {protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'permission-probe',version:'1'}};
  if (q.method === 'tools/list') result = {tools:[{name,description:'Harmless permission probe; call with no arguments.',inputSchema:{type:'object',properties:{}}}]};
  if (q.method === 'tools/call') {
    fs.appendFileSync(log, JSON.stringify({name})+'\\n');
    result = {content:[{type:'text',text:'probe ok'}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
});
`);
const servers = {
  // Browser names are reserved by Claude and cannot be supplied as user MCP probes.
  klava: 'projects', terminal: 'run_in_terminal', 'scheduled-tasks': 'create_scheduled_task',
  ccd_session_mgmt: 'send_message', ccd_settings: 'set_setting',
  '1a59c906-04da-521d-bda7-7f71b9f9e01c': 'create',
  '6f616b42-0ed8-571e-823f-ee4aca6b7ce9': 'show_widget',
};
const mcpServers = Object.fromEntries(Object.entries(servers).map(([id, name]) => [id,
  {command:process.execPath,args:[server,name,calls]}]));
const settings = klavaDesktopSettings({ permissions: {
  // An existing allow must not override our denies.
  allow: Object.entries(servers).map(([id, name]) => `mcp__${id}__${name}`),
} }, ['projects']);
await fs.mkdir(path.join(directory, '.claude'));
await fs.writeFile(path.join(directory, '.claude/settings.json'), JSON.stringify(settings));
const child = spawn(exe, ['-p', '--output-format', 'stream-json', '--verbose',
  '--no-session-persistence', '--setting-sources', 'project',
  // The disposable project is untrusted: grant probes at the caller level.
  // Project denies must still win over these grants; no deny flags are passed.
  '--allowedTools', Object.entries(servers).map(([id, name]) => `mcp__${id}__${name}`).join(','),
  '--strict-mcp-config', '--mcp-config', JSON.stringify({mcpServers}),
], {cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
let output = ''; let stderr = '';
child.stdout.on('data', b => output += b); child.stderr.on('data', b => stderr += b);
const timer = setTimeout(() => child.kill(), 90000);
child.stdin.on('error', () => {});
child.stdin.end('This is a harmless permission test. Call mcp__klava__projects once. Then call each available MCP probe once. Do not use native tools. Answer briefly.');
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Claude permission smoke failed (${code}): ${stderr.slice(-500)}`);
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(events.find(e => e.type === 'result'), null, 2));
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  await fs.writeFile(path.join(directory, 'inventory.json'), JSON.stringify({tools:init?.tools,servers:init?.mcp_servers}, null, 2));
  if (!init?.tools?.includes('mcp__klava__projects')) throw new Error('Klava tool missing');
  const forbidden = Object.entries(servers).filter(([id]) => id !== 'klava').map(([id, name]) => `mcp__${id}__${name}`);
  for (const tool of [...forbidden, 'Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'Artifacts', 'ArtifactData', 'ArtifactComments', 'CronCreate', 'ScheduleWakeup', 'SendMessage']) {
    if (init.tools.includes(tool)) throw new Error(`Denied tool still exposed: ${tool}`);
  }
  // A failed MCP connection is not evidence that permission rules worked.
  for (const name of Object.keys(servers)) {
    if (!init.mcp_servers?.some(s => s.name === name && s.status === 'connected')) throw new Error(`Probe not connected: ${name}; inventory: ${directory}`);
  }
  if (events.find(e => e.type === 'result')?.is_error !== false) throw new Error(`Claude did not complete smoke; result: ${directory}`);
  const invoked = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  if (!invoked.length || invoked.some(c => c.name !== 'projects')) throw new Error('Expected only Klava probe calls');
  console.log(JSON.stringify({passed:true,directory,claudeVersion:init.claude_code_version,
    deniedConnectedServers:forbidden.length,klavaCalls:invoked.length,desktopUIVerified:false,
    browserInjectionVerified:false}));
} finally { clearTimeout(timer); }
