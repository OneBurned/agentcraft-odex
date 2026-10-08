import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readZip } from './lib/zip.mjs';

const rules = [
  ['user-path', /(?:[a-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)[^\s"'<>]+/i],
  ['private-project', /OneBurned|TradeRecord|TITracker|traderecord\.online|track-record\.online/i],
  ['private-persona', /Клав(?:а|ы|е|у|ой)(?!\p{L})|Кад[еэ]и?н|ворчливый скуф|дедовские пошлые|рюмку отставил/iu],
  ['session-id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['email', /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i],
];
// Public protocol constants, not conversation identifiers. Unknown UUIDs still fail.
const publicIds = new Set([
  '258eafa5-e914-47da-95ca-c5ab0dc85b11', // RFC 6455 WebSocket handshake GUID
  '1ac14e77-02e7-4e5d-b744-2eb1ae5198b7', // Windows System known-folder ID
  '00000000-0000-0000-0000-000000000000', // UUID validator sentinel
  'ffffffff-ffff-ffff-ffff-ffffffffffff', // UUID validator sentinel
  '3ab19d7e-9f35-45c2-926e-75e271cc60b3', // SDK remote-session UUID namespace, sdk.mjs
  '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude SDK public OAuth client ID, sdk.mjs
  '59637612-477b-4836-a601-b0589eda7704', // Claude SDK public Design OAuth client ID, sdk.mjs
  '22422756-60c9-4084-8eb7-27705fd5cf9a', // Claude SDK local OAuth client ID, sdk.mjs
  '00000000-0000-4000-8000-000000000000', // Claude SDK local Design client sentinel, sdk.mjs
]);
// Only reviewed, byte-identical third-party attribution/binaries can exempt public emails/UUIDs.
// No exception ever exempts personal project names, paths, state files or private personalities.
const vendorFile = new URL('./portable-vendor-hashes.json', import.meta.url);
export async function auditPortable(directory, { allowSchematics = false } = {}) {
  const root = path.resolve(directory), issues = [], vendor = JSON.parse(await fs.readFile(vendorFile, 'utf8'));
  let files = 0, members = 0, inspected = 0;
  const issue = (file, rule) => issues.push({ file: rules.reduce((s, [, re]) => s.replace(new RegExp(re.source, re.flags.replace('g', '') + 'g'), '[redacted]'), file), rule });
  function inspect(name, bytes, depth = 0) {
    if (++members > 100000 || (inspected += bytes.length) > 1024 * 1024 * 1024 || depth > 8) throw Error('Package exceeds inspection budget');
    const segments = name.toLowerCase().split(/[!/]/), base = segments.at(-1);
    if (segments.some(s => ['.git', '.claude', '.codex', 'memory', 'memories', 'logs', 'profile', 'profiles', 'backups'].includes(s)) ||
        /^(?:state|conversation(?:-lock)?|codex-chat(?:-state)?|planning|access|auth|credentials|sessions?)\.json$/i.test(base) ||
        /^(?:memory|game-history)\.md$/i.test(base) || /\.(?:jsonl|log|pem|key)$/i.test(base) || base === '.env' || base.startsWith('.env.')) issue(name, 'private-state-file');
    if (/\.schem$/i.test(base) && !allowSchematics) issue(name, 'schematic-without-flag');
    const archive = /\.(?:jar|zip)$/i.test(base) || bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'));
    if (archive) {
      try {
        const entries = readZip(bytes);
        inspect(name + '!zip-metadata', entries.metadata, depth + 1);
        for (const e of entries) if (!e.name.endsWith('/')) inspect(name + '!' + e.name, e.data, depth + 1);
      }
      catch { issue(name, 'uninspectable-archive'); }
      return;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const trusted = vendor[name] === digest;
    // Text, Java constant pools, PNG metadata and native binaries: no extension-based omission.
    // Decode JSON/JS escapes and UTF-16 as well as UTF-8; matches remain private.
    const decode = t => t.replace(/\\u\{([a-f0-9]+)\}|\\u([a-f0-9]{4})|\\x([a-f0-9]{2})/gi,
      (m, a, b, c) => { const n = parseInt(a ?? b ?? c, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : m; });
    const views = [decode(name), decode(bytes.toString('utf8')), decode(bytes.toString('utf16le'))];
    for (const [rule, regex] of rules) {
      if (trusted && ['email', 'session-id'].includes(rule)) continue;
      const filtered = views.map(v => {
        if (rule === 'session-id') return v.replace(new RegExp(regex.source, 'gi'), id => publicIds.has(id.toLowerCase()) ? '' : id);
        if (rule === 'email') return v.replace(/\buser@agentcraft\.local\b/g, ''); // generated placeholder Git identity
        if (rule === 'user-path') return v.replaceAll('/home/user/monorepo/CLAUDE.md', '') // SDK schema's public example
          .replace(/\/home\/\$\{[^}]+\}/g, ''); // computed home path, not an embedded user's path
        return v;
      });
      if (filtered.some(v => regex.test(v))) issue(name, rule);
    }
  }
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { issue(name, 'symlink'); continue; }
      if (entry.isDirectory()) await walk(full, name + '/');
      else if (entry.isFile()) {
        if ((await fs.stat(full)).size > 256 * 1024 * 1024) throw Error('File exceeds inspection budget');
        files++; inspect(name, await fs.readFile(full));
      }
      else issue(name, 'unsupported-file');
    }
  }
  await walk(root);
  return { ok: !issues.length, files, members, issues };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'allow-schematics': { type: 'boolean', default: false } } });
    if (positionals.length !== 1) throw Error('Usage: node tools/audit-portable.mjs <directory> [--allow-schematics]');
    const result = await auditPortable(positionals[0], { allowSchematics: values['allow-schematics'] });
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
