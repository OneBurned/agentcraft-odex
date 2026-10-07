// Bounded ZIP reader for inspecting every member, including nested Fabric JARs.
import { inflateRawSync, deflateRawSync } from 'node:zlib';
export function readZip(bytes, maxBytes = 256 * 1024 * 1024) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw Error('Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12);
  let pos = bytes.readUInt32LE(end + 16), total = 0;
  if (bytes.readUInt32LE(end + 4) !== 0 || count === 65535 || pos + size !== end || bytes.readUInt16LE(end + 8) !== count) throw Error('Unsupported ZIP layout');
  const names = new Set(), entries = [], metadata = [bytes.subarray(end + 22)];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10);
    const packed = bytes.readUInt32LE(pos + 20), length = bytes.readUInt32LE(pos + 24);
    const n = bytes.readUInt16LE(pos + 28), x = bytes.readUInt16LE(pos + 30), c = bytes.readUInt16LE(pos + 32);
    const offset = bytes.readUInt32LE(pos + 42), mode = bytes.readUInt32LE(pos + 38) >>> 16;
    if (pos + 46 + n + x + c > end) throw Error('Invalid ZIP entry length');
    const name = bytes.subarray(pos + 46, pos + 46 + n).toString('utf8');
    metadata.push(bytes.subarray(pos + 46, pos + 46 + n + x + c));
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').includes('..') || names.has(name.toLowerCase())) throw Error('Unsafe or duplicate ZIP path');
    names.add(name.toLowerCase());
    if (flags & 1 || (mode & 0xf000) === 0xa000 || ![0, 8].includes(method)) throw Error('Encrypted, linked or unsupported ZIP entry');
    total += length;
    if (total > maxBytes || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw Error('ZIP exceeds inspection limit or has invalid offset');
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLength + localExtra;
    metadata.push(bytes.subarray(offset + 30 + localNameLength, start));
    if (start + packed > bytes.length || bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name) throw Error('Invalid ZIP local entry');
    const data = method === 0 ? bytes.subarray(start, start + packed) : inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: Math.max(1, length) });
    if (data.length !== length || crc32(data) !== bytes.readUInt32LE(pos + 16)) throw Error('ZIP length/CRC mismatch');
    entries.push({ name, data }); pos += 46 + n + x + c;
  }
  if (pos !== end) throw Error('ZIP directory size mismatch');
  entries.metadata = Buffer.concat(metadata);
  return entries;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function writeZip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name), packed = deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(0x800, 8); d.writeUInt16LE(8, 10);
    d.writeUInt32LE(crc, 16); d.writeUInt32LE(packed.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(filename.length, 28); d.writeUInt32LE(offset, 42);
    locals.push(h, filename, packed); central.push(d, filename); offset += h.length + filename.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
