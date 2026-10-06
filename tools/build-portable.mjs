// Build a self-contained Windows observer package from tested local artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../foreman/node_modules/esbuild/lib/main.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=(await fs.readFile(path.join(root,'mod/gradle.properties'),'utf8')).match(/^mod_version=(.+)$/m)[1].trim();
const out=path.resolve(process.argv[2] || path.join(root,'dist',`AgentCraft-Codex-${version}`));
try { await fs.access(out); throw new Error('Output directory already exists; choose a fresh directory.'); }
catch(e) { if(e.code!=='ENOENT') throw e; }
await fs.mkdir(out,{recursive:true});
async function copy(from,to) {
  await fs.mkdir(path.dirname(to),{recursive:true});
  await fs.copyFile(from,to);
}
const opts={bundle:true,platform:'node',format:'esm',target:'node24',legalComments:'external',
  banner:{js:"import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);"}};
await build({...opts,entryPoints:[path.join(root,'foreman/src/observer-main.ts')],outfile:path.join(out,'foreman/src/observer-main.mjs')});
await build({...opts,entryPoints:[path.join(root,'foreman/src/claude-workspace-server.ts')],outfile:path.join(out,'foreman/src/claude-workspace-server.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/portable-control.mjs')],outfile:path.join(out,'control.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/codex-progress.mjs')],outfile:path.join(out,'codex-progress.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/studio.mjs')],outfile:path.join(out,'studio.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/connect-codex-chat.ts')],outfile:path.join(out,'connect-codex-chat.mjs')});
await copy(path.join(root,`mod/build/libs/agentcraft-${version}.jar`),path.join(out,`mods/agentcraft-${version}.jar`));
const apiRoot=path.join(root,'.gradle-home/caches/modules-2/files-2.1/net.fabricmc.fabric-api/fabric-api/0.161.0+26.3');
let api;
for(const hash of await fs.readdir(apiRoot)) {
  for(const file of await fs.readdir(path.join(apiRoot,hash))) if(file.endsWith('.jar')) api=path.join(apiRoot,hash,file);
}
if(!api) throw new Error('Fabric API dependency has not been downloaded by Gradle.');
await copy(api,path.join(out,'mods',path.basename(api)));
await copy(process.execPath,path.join(out,'runtime/node.exe'));
await copy(path.join(root,'LICENSE'),path.join(out,'licenses/AgentCraft-MIT.txt'));
await copy(path.join(root,'foreman/node_modules/ws/LICENSE'),path.join(out,'licenses/ws-MIT.txt'));
await copy(path.join(root,'foreman/node_modules/zod/LICENSE'),path.join(out,'licenses/zod-MIT.txt'));
await copy(path.join(root,'foreman/node_modules/@modelcontextprotocol/sdk/LICENSE'),path.join(out,'licenses/MCP-SDK-MIT.txt'));
await copy(path.join(root,'foreman/node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md'),path.join(out,'licenses/Claude-Agent-SDK.txt'));
for (const name of ['CLAUDE.md', 'PROJECTS.md', 'MEMORY.md', 'WORKSPACE.md'])
  await copy(path.join(root,'tools/klava',name),path.join(out,'klava-template',name));
const nodeVersion=process.version;
const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
if(!license.ok) throw new Error(`Cannot retrieve the license for bundled Node ${nodeVersion}: ${license.status}`);
await fs.writeFile(path.join(out,'licenses/Node-LICENSE.txt'),await license.text());
await copy(path.join(root,'assets-src/cast.json'),path.join(out,'assets-src/cast.json'));
for(const name of await fs.readdir(path.join(root,'tools/portable'))) {
  const target=name==='agentcraft-client.json'?path.join('config',name):name;
  await copy(path.join(root,'tools/portable',name),path.join(out,target));
}
await fs.writeFile(path.join(out,'BUILD.json'),JSON.stringify({version,minecraft:'26.3',fabricLoader:'0.19.5+',node:nodeVersion,backend:'observer'},null,2));
console.log(out);
