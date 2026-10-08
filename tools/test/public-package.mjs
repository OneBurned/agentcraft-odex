import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readZip } from '../lib/zip.mjs';
import { inspectRelease } from '../lib/portable-install.mjs';
const root = path.resolve(process.argv[2]), release = await inspectRelease(root);
assert.equal(release.build.publicRelease, true); assert.equal(release.build.additionalSkins, false);
const jar = readZip(await fs.readFile(path.join(root, `mods/agentcraft-${release.build.version}.jar`)));
const original = readZip(await fs.readFile(`mod/build/libs/agentcraft-${release.build.version}.jar`));
const removed = ['girl_swimsuit', 'gta_sa_girl', 'skuf', 'ded_vasyan', 'girl_no_armor', 'boy_no_armor'];
for (const id of removed) {
  const name = `assets/agentcraft/textures/entity/agent/${id}.png`;
  assert(!jar.some(e => e.name === name));
  const source = original.find(e => e.name === name);
  if (source) assert(!jar.some(e => e.data.equals(source.data)), 'Excluded image cannot remain under another filename');
}
for (const entry of original.filter(e => e.name.endsWith('.class') || e.name.startsWith('META-INF/jars/'))) {
  assert(jar.find(e => e.name === entry.name)?.data.equals(entry.data), 'Classes and nested dependency notices remain unchanged');
}
for (const e of jar.filter(e => /^assets\/agentcraft\/lang\/(ru_ru|en_us)\.json$/.test(e.name))) {
  const lang = JSON.parse(e.data); for (const id of removed) assert(!(`skin.agentcraft.${id}` in lang));
}
const files = await fs.readdir(path.join(root, 'licenses'));
for (const name of ['AgentCraft-MIT.txt', 'Fabric-API-Apache-2.0.txt', 'Node-LICENSE.txt', 'ws-MIT.txt', 'zod-MIT.txt', 'MCP-SDK-MIT.txt', 'Claude-Agent-SDK.txt']) assert(files.includes(name));
assert((await fs.readFile(path.join(root, 'SOURCES.txt'), 'utf8')).includes('NOT included'));
await assert.rejects(fs.access(path.join(root, 'buildings')), /ENOENT/);
console.log('Public package: six images and labels absent, no renamed copies, original classes/dependencies intact, seven license notices present, no personal schematics.');
