// Build a self-contained Windows observer package from tested local artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../foreman/node_modules/esbuild/lib/main.js';
import { parseArgs } from 'node:util';
import { readZip, writeZip } from './lib/zip.mjs';
import { auditPortable } from './audit-portable.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=(await fs.readFile(path.join(root,'mod/gradle.properties'),'utf8')).match(/^mod_version=(.+)$/m)[1].trim();
const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'include-schematics': { type: 'string' } } });
if (positionals.length > 1) throw Error('Use --include-schematics <directory> to explicitly include private buildings.');
const out=path.resolve(positionals[0] || path.join(root,'dist',`AgentCraft-${version}-portable`));
const buildingSource=values['include-schematics'] ? path.resolve(values['include-schematics']) : null;
const templates=path.join(root,'tools/portable-templates');
try { await fs.access(out); throw new Error('Output directory already exists; choose a fresh directory.'); }
catch(e) { if(e.code!=='ENOENT') throw e; }
await fs.mkdir(out,{recursive:true});
async function copy(from,to) {
  await fs.mkdir(path.dirname(to),{recursive:true});
  await fs.copyFile(from,to);
}
const opts={bundle:true,platform:'node',format:'esm',target:'node24',legalComments:'external', minify:true,
  banner:{js:"import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);"}};
await build({...opts,entryPoints:[path.join(root,'foreman/src/observer-main.ts')],outfile:path.join(out,'foreman/src/observer-main.mjs')});
await build({...opts,entryPoints:[path.join(root,'foreman/src/claude-workspace-server.ts')],outfile:path.join(out,'foreman/src/claude-workspace-server.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/portable-control.mjs')],outfile:path.join(out,'control.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/codex-progress.mjs')],outfile:path.join(out,'codex-progress.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/studio.mjs')],outfile:path.join(out,'studio.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/migrate-team.ts')],outfile:path.join(out,'migrate-team.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/connect-codex-chat.ts')],outfile:path.join(out,'connect-codex-chat.mjs')});
await build({...opts,entryPoints:[path.join(root,'tools/klava-terminal.mjs')],outfile:path.join(out,'foreman/src/agent-terminal.mjs')});
// Replace only declared presentation resources. Classes, skins and third-party notices stay intact.
const jar=readZip(await fs.readFile(path.join(root,`mod/build/libs/agentcraft-${version}.jar`)));
const cast=await fs.readFile(path.join(templates,'cast.json'));
const cosmeticIds=['girl_swimsuit','gta_sa_girl','skuf','ded_vasyan','girl_no_armor','boy_no_armor'];
for (const entry of jar) {
  if (entry.name==='assets/agentcraft/cast.json') entry.data=cast;
  if (/^assets\/agentcraft\/lang\/(en_us|ru_ru)\.json$/.test(entry.name)) {
    const lang=JSON.parse(entry.data.toString('utf8'));
    cosmeticIds.forEach((id,i)=>lang[`skin.agentcraft.${id}`]=`${entry.name.includes('ru_ru')?'Скин':'Skin'} ${i+1}`);
    entry.data=Buffer.from(JSON.stringify(lang,null,2)+'\n');
  }
}
for (const id of cosmeticIds) if (!jar.some(e=>e.name===`assets/agentcraft/textures/entity/agent/${id}.png`)) throw Error('Missing required cosmetic skin: '+id);
await fs.mkdir(path.join(out,'mods'),{recursive:true});
await fs.writeFile(path.join(out,`mods/agentcraft-${version}.jar`),writeZip(jar));
await copy(path.join(templates,'personas.json'),path.join(out,'personas.example.json'));
await copy(path.join(root,'docs/ROLE_QUEUE.md'),path.join(out,'ROLE_QUEUE.md'));
// Optional private asset pack. Schematics remain user-owned files outside the public mod JAR.
if(buildingSource) {
  for(const name of await fs.readdir(buildingSource)) {
    if(!/^[a-z0-9][a-z0-9_-]{0,63}\.schem$/.test(name) && name!=='SOURCES.txt') continue;
    await copy(path.join(buildingSource,name),path.join(out,'buildings',name));
  }
}
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
for (const name of await fs.readdir(path.join(templates,'workspace')))
  await copy(path.join(templates,'workspace',name),path.join(out,'workspace-template',name));
const nodeVersion=process.version;
const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
if(!license.ok) throw new Error(`Cannot retrieve the license for bundled Node ${nodeVersion}: ${license.status}`);
await fs.writeFile(path.join(out,'licenses/Node-LICENSE.txt'),await license.text());
await copy(path.join(templates,'cast.json'),path.join(out,'assets-src/cast.json'));
for(const name of await fs.readdir(path.join(root,'tools/portable'))) {
  const target=name==='agentcraft-client.json'?path.join('config',name):name;
  await copy(path.join(root,'tools/portable',name),path.join(out,target));
}
await fs.writeFile(path.join(out,'BUILD.json'),JSON.stringify({version,minecraft:'26.3',fabricLoader:'0.19.5+',node:nodeVersion,backend:'observer'},null,2));
const audit=await auditPortable(out,{allowSchematics:!!buildingSource});
if (!audit.ok) {
  console.error(JSON.stringify(audit));
  throw Error('Portable privacy audit failed. This output is incomplete and must not be distributed.');
}
// A marker is written only after the final audit; never publish partially assembled output.
await fs.writeFile(path.join(out,'PACKAGE-READY.json'),JSON.stringify({version,privacyAudit:'pass',privateSchematics:!!buildingSource},null,2)+'\n');
console.log(out);
