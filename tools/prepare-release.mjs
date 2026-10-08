// Prepare local release assets only. Publishing and pushing require separate user confirmation.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { auditPortable } from './audit-portable.mjs';
import { inspectRelease, files, inside } from './lib/portable-install.mjs';
import { readZip, writeZip } from './lib/zip.mjs';

const [packageArg, outputArg, label, checksArg] = process.argv.slice(2);
if (!packageArg || !outputArg || !checksArg || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(label ?? '')) throw Error('Usage: node tools/prepare-release.mjs <public package> <new output directory> <version-rc.N> <checks.json>');
const root = path.resolve(packageArg), out = path.resolve(outputArg), release = await inspectRelease(root);
if (!release.build.publicRelease || release.build.additionalSkins !== false || !label.startsWith(release.build.version + '-rc.')) throw Error('Expected a public prerelease without additional skins');
if (inside(root, out) || inside(out, root)) throw Error('Release output and package must be separate');
const audit = await auditPortable(root); if (!audit.ok) throw Error('Package leak audit failed');
const checks = JSON.parse(await fs.readFile(checksArg, 'utf8'));
if (checks.publicPackage !== 'pass' || checks.liveAcceptance !== 'pending') throw Error('Require explicit public-package checks and pending live acceptance for this candidate');
const zipName = `AgentCraft-${label}-windows-x64.zip`, prefix = `AgentCraft-${label}/`;
const entries = [];
for (const name of (await files(root)).sort()) entries.push({ name: prefix + name, data: await fs.readFile(path.join(root, name)) });
const zip = writeZip(entries), extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcraft-release-verify-'));
let archiveAudit;
try {
  const decoded = readZip(zip); if (decoded.length !== entries.length) throw Error('Archive lost files');
  for (let i = 0; i < entries.length; i++) {
    const e = decoded[i], original = entries[i];
    if (e.name !== original.name || !e.data.equals(original.data)) throw Error('Archive round-trip mismatch');
    const dest = path.join(extracted, e.name.slice(prefix.length)); if (!inside(extracted, dest)) throw Error('Archive escaped verification root');
    await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, e.data, { flag: 'wx' });
  }
  await inspectRelease(extracted); archiveAudit = await auditPortable(extracted); if (!archiveAudit.ok) throw Error('Extracted archive leak audit failed');
} finally {
  if (!inside(os.tmpdir(), extracted) || !path.basename(extracted).startsWith('agentcraft-release-verify-')) throw Error('Unsafe cleanup root');
  await fs.rm(extracted, { recursive: true, force: true });
}
await fs.mkdir(out); // Fresh output only; never overwrite assets awaiting approval.
await fs.writeFile(path.join(out, zipName), zip, { flag: 'wx' });
for (const lang of ['ru', 'en']) await fs.copyFile(`docs/releases/${label}.${lang}.md`, path.join(out, `RELEASE_NOTES.${lang}.md`), fs.constants.COPYFILE_EXCL);
await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), path.join(out, 'THIRD_PARTY_NOTICES.txt'), fs.constants.COPYFILE_EXCL);
await fs.writeFile(path.join(out, 'AUDIT.json'), JSON.stringify({ package: audit, extractedArchive: archiveAudit, archiveRoundTrip: 'pass', additionalSkins: 'excluded', personalSchematics: 'excluded' }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(out, 'CHECKS.json'), JSON.stringify(checks, null, 2) + '\n', { flag: 'wx' });
const sums = [];
for (const name of (await fs.readdir(out)).sort()) sums.push(`${createHash('sha256').update(await fs.readFile(path.join(out, name))).digest('hex')}  ${name}`);
await fs.writeFile(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: out, archive: zipName, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), files: entries.length, audit: archiveAudit, published: false }));
