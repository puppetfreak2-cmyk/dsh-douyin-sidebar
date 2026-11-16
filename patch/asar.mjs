// Read-only ASAR header parsing and integrity validation.
// An Electron archive begins with a Pickle-framed JSON directory; every packaged
// entry may carry a whole-file SHA256 plus per-block SHA256 records. Editing a
// payload byte therefore requires rewriting both, or the app refuses to start.
//
// Digests are adjudicated by ./sha.mjs, which can fall back to a pure-JS SHA-256
// when the native one contradicts itself.  A single native digest is not
// trustworthy here: see the note at the top of that file.
import { digestOf, matchesDigest, pureSha256 } from './sha.mjs';

export const sha256 = digestOf;

export function parseArchiveHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) throw new Error('archive header is truncated');
  const sizePicklePayload = buf.readUInt32LE(0);
  const headerPickleSize = buf.readUInt32LE(4);
  const headerPicklePayload = buf.readUInt32LE(8);
  const jsonSize = buf.readUInt32LE(12);
  const alignedJsonSize = Math.ceil(jsonSize / 4) * 4;
  const dataStart = 8 + headerPickleSize;
  if (
    sizePicklePayload !== 4 ||
    headerPickleSize !== headerPicklePayload + 4 ||
    headerPicklePayload !== alignedJsonSize + 4 ||
    dataStart > buf.length ||
    16 + jsonSize > dataStart
  ) {
    throw new Error('invalid ASAR header size or alignment');
  }
  const headerBlock = buf.subarray(16, 16 + jsonSize);
  const header = JSON.parse(headerBlock.toString('utf8'));
  if (!header || typeof header !== 'object' || !header.files || typeof header.files !== 'object') {
    throw new Error('invalid ASAR root directory');
  }
  return { header, headerBlock, dataStart };
}

export function validateEntryIntegrity(body, integrity) {
  if (!Buffer.isBuffer(body)) return 'body is not a Buffer';
  if (!integrity || integrity.algorithm !== 'SHA256') return 'unsupported integrity algorithm';
  if (typeof integrity.hash !== 'string' || !/^[a-f0-9]{64}$/.test(integrity.hash)) return 'invalid whole-file hash';
  if (!Number.isSafeInteger(integrity.blockSize) || integrity.blockSize <= 0) return 'invalid block size';
  if (!Array.isArray(integrity.blocks)) return 'missing block hashes';
  const expectedCount = Math.max(1, Math.ceil(body.length / integrity.blockSize));
  if (integrity.blocks.length !== expectedCount) {
    return `expected ${expectedCount} block hashes, found ${integrity.blocks.length}`;
  }
  // Mismatches are confirmed in pure JS before being reported; see ./sha.mjs.
  if (!matchesDigest(body, integrity.hash)) return 'whole-file hash mismatch';
  for (let i = 0; i < expectedCount; i += 1) {
    const start = i * integrity.blockSize;
    const block = body.subarray(start, Math.min(start + integrity.blockSize, body.length));
    if (typeof integrity.blocks[i] !== 'string') return `block ${i} hash is not a string`;
    if (!matchesDigest(block, integrity.blocks[i])) return `block ${i} hash mismatch`;
  }
  return null;
}

// Full sweep: every packaged entry that claims integrity must pass it.
export function sweepArchive(buf) {
  const { header, headerBlock, dataStart } = parseArchiveHeader(buf);
  const failures = [];
  let checked = 0;
  let unpacked = 0;
  let links = 0;
  const visit = (node, prefix) => {
    if (!node || typeof node !== 'object' || !node.files) return;
    for (const [name, value] of Object.entries(node.files)) {
      const full = prefix === '' ? name : `${prefix}/${name}`;
      if (value.files) {
        visit(value, full);
        continue;
      }
      if (value.unpacked) {
        unpacked += 1;
        continue;
      }
      if (typeof value.link === 'string') {
        links += 1;
        continue;
      }
      if (!value.integrity) {
        failures.push(`${full}: missing integrity metadata`);
        continue;
      }
      const offset = Number(value.offset);
      const size = value.size;
      if (
        typeof value.offset !== 'string' ||
        !/^\d+$/.test(value.offset) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        dataStart + offset + size > buf.length
      ) {
        failures.push(`${full}: invalid archive offset or size`);
        continue;
      }
      checked += 1;
      const body = buf.subarray(dataStart + offset, dataStart + offset + size);
      const error = validateEntryIntegrity(body, value.integrity);
      if (error !== null) failures.push(`${full}: ${error}`);
    }
  };
  visit(header, '');
  return { headerHash: pureSha256(headerBlock), checked, unpacked, links, failures };
}
