// The persistence patch for DSH's desktop browser guests.
//
// DSH's upstream `DesktopBrowserGuests.acquire()` always hands a plugin a random,
// non-persistent partition (`session.fromPartition('dsh-sidebar-browser-<uuid>')`),
// so every cookie dies with the process.  The patch changes exactly two regions of
// `lib/main.js` inside app.asar:
//
//   A. acquire(): only the exact sidebar and legacy webview workspace names
//      also prepare a session stored on disk under
//      `<DSH_HOME>/browser/persistent/<workspace>` via `session.fromPath(dir, {cache:false})`.
//      The directory is named after the workspace, so two installs (the published
//      `dsh-douyin-sidebar` and an older `dsh-douyin-webview`) never share cookies:
//      each starts from its own empty store and can be reset independently.
//      `dsh-douyin-webview` is the one exception and keeps the historical `douyin`
//      directory, so an already logged-in personal build survives this upgrade.
//      Every other workspace keeps the upstream random partition behaviour.
//   B. will-attach-webview: hand that stored session to the guest through
//      `preferences.session`, so the guest actually uses it.
//
// Both regions are replaced with byte-for-byte equal length text (padded with
// comment filler) because the ASAR header block has a fixed size and every entry
// offset is relative to it.  The per-entry SHA256 records are then recomputed in
// place: the digests are fixed-width hex, so the header JSON length cannot move.
//
// Everything here is pure: no file is read or written.  The caller (cli.mjs) owns
// I/O, backups and the "is DSH still running" gate.
import { sha256, parseArchiveHeader, validateEntryIntegrity } from './asar.mjs';

export const TARGET_ENTRY = 'lib/main.js';
/**
 * Only the exact sidebar and webview workspace names get an on-disk session.
 * The directory under `<DSH_HOME>/browser/persistent/`
 * is named after the workspace itself.  One directory per plugin is the point: a
 * fresh install starts logged out, and resetting one plugin cannot disturb another.
 * The pre-rename personal build (`dsh-douyin-webview`) keeps its historical `douyin`
 * directory so that upgrading does not log its user out.
 */
export const PERSISTENT_PREFIX = 'dsh-douyin-';
export const LEGACY_DIRECTORIES = { 'dsh-douyin-webview': 'douyin' };

/** Marker strings that only exist after the patch.  Used for idempotency. */
export const APPLIED_MARKERS = ['session.fromPath(d, { cache: false })', 'preferences.session = lease.stored'];

export class PatchError extends Error {}

const fail = (message) => {
  throw new PatchError(message);
};

// ------------------------------------------------------------------ region A
const A_START = '/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */\n';

// Region A's `persistent()` body.  The workspace prefix and the legacy directory
// aliases come from the constants above, so there is exactly one place that decides
// which workspaces persist and where.  Any edit that makes the region longer than the
// original is refused by fit() with a byte count, so the fixed-width constraint cannot
// be violated silently.
const ALIASES = JSON.stringify(LEGACY_DIRECTORIES);
const A_BODY = [
  '/** Guests. */\n',
  'var DesktopBrowserGuests = class {\n',
  '\thostUrl;\n',
  '\tpartitions = /* @__PURE__ */ new Map();\n',
  '\tleases = /* @__PURE__ */ new Map();\n',
  '\tconstructor(hostUrl) {\n',
  '\t\tthis.hostUrl = hostUrl;\n',
  '\t}\n',
  '\tacquire(owner, workspace) {\n',
  '\t\tif (typeof workspace !== "string" || workspace.length === 0 || workspace.length > 4096) throw new Error("desktop browser: a workspace storage identity is required");\n',
  '\t\tlet partition = this.partitions.get(workspace);\n',
  '\t\tif (partition === void 0) {\n',
  '\t\t\tpartition = `dsh-sidebar-browser-${randomUUID()}`;\n',
  '\t\t\tthis.configureSession(session.fromPartition(partition));\n',
  '\t\t\tthis.partitions.set(workspace, partition);\n',
  '\t\t}\n',
  '\t\tconst lease = randomUUID();\n',
  '\t\tthis.leases.set(lease, { owner, partition, attached: false, stored: this.persistent(workspace) });\n',
  '\t\treturn { lease, partition };\n',
  '\t}\n',
  '\tpersistent(workspace) {\n',
  '\t\tif (!["dsh-douyin-sidebar","dsh-douyin-webview"].includes(workspace))return;\n',
  '\t\tconst m = this.stored ??= new Map();\n',
  '\t\tlet s = m.get(workspace);\n',
  '\t\tif (s) return s;\n',
  `\t\tconst dir = ${ALIASES}[workspace] ?? workspace;\n`,
  '\t\tconst d = join(resolveDshHome(), "browser/persistent", dir);\n',
  '\t\tmkdirSync(d, { recursive: true });\n',
  '\t\ts = session.fromPath(d, { cache: false });\n',
  '\t\tthis.configureSession(s);\n',
  '\t\tm.set(workspace, s);\n',
  '\t\treturn s;\n',
  '\t}\n',
].join('');

// ------------------------------------------------------------------ region B
const B_START =
  '\t\t\tObject.assign(preferences, {\n' +
  '\t\t\t\tpartition: lease.partition,\n' +
  '\t\t\t\tnodeIntegration: false,\n' +
  '\t\t\t\tnodeIntegrationInWorker: false,\n' +
  '\t\t\t\tnodeIntegrationInSubFrames: false,\n' +
  '\t\t\t\tcontextIsolation: true,\n' +
  '\t\t\t\tsandbox: true,\n' +
  '\t\t\t\twebSecurity: true,\n' +
  '\t\t\t\tallowRunningInsecureContent: false,\n' +
  '\t\t\t\twebviewTag: false,\n' +
  '\t\t\t\tplugins: false,\n' +
  '\t\t\t\tnavigateOnDragDrop: false,\n' +
  '\t\t\t\tdisableDialogs: true,\n' +
  '\t\t\t\tdevTools: !app.isPackaged\n' +
  '\t\t\t});\n' +
  '\t\t\tparams.httpreferrer = "";\n';

const B_BODY = [
  '\t\t\tObject.assign(preferences, {partition: lease.partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: !app.isPackaged});\n',
  '\t\t\tif (lease.stored) preferences.session = lease.stored;\n',
  '\t\t\tparams.httpreferrer = "";\n',
].join('');

function filler(length, indent) {
  if (length === 0) return '';
  if (length < indent.length + 4) fail(`padding of ${length} bytes is too small for a comment line`);
  return `${indent}//${' '.repeat(length - indent.length - 3)}\n`;
}

function fit(body, originalLength, indent, label) {
  const used = Buffer.byteLength(body);
  if (used > originalLength) {
    fail(`region ${label} grew by ${used - originalLength} bytes; this DSH build is not supported`);
  }
  const result = body + filler(originalLength - used, indent);
  if (Buffer.byteLength(result) !== originalLength) fail(`region ${label} is not length neutral`);
  return result;
}

export function entryOf(header) {
  let node = header;
  for (const part of TARGET_ENTRY.split('/')) {
    node = node?.files?.[part];
    if (!node) fail(`${TARGET_ENTRY} was not found in the archive header`);
  }
  if (node.files) fail(`${TARGET_ENTRY} resolves to a directory`);
  return node;
}

export function readEntry(asar) {
  const { header, headerBlock, dataStart } = parseArchiveHeader(asar);
  const node = entryOf(header);
  if (
    node.unpacked ||
    node.link ||
    typeof node.offset !== 'string' ||
    !/^\d+$/.test(node.offset) ||
    !Number.isSafeInteger(Number(node.offset)) ||
    !Number.isSafeInteger(node.size) ||
    node.size < 0
  ) {
    fail('invalid target entry');
  }
  const start = dataStart + Number(node.offset);
  if (!Number.isSafeInteger(start + node.size) || start + node.size > asar.length) {
    fail('target outside archive');
  }
  const checkTree = (dir) => {
    if (!dir || typeof dir !== 'object' || !dir.files || typeof dir.files !== 'object' || Array.isArray(dir.files)) {
      fail('invalid directory');
    }
    for (const other of Object.values(dir.files)) {
      if (!other || typeof other !== 'object' || Array.isArray(other)) fail('invalid entry');
      if (other.files) {
        checkTree(other);
        continue;
      }
      if (other === node || other.unpacked || typeof other.link === 'string') continue;
      if (
        typeof other.offset !== 'string' ||
        !/^\d+$/.test(other.offset) ||
        !Number.isSafeInteger(Number(other.offset)) ||
        !Number.isSafeInteger(other.size) ||
        other.size < 0
      ) {
        fail('invalid other entry');
      }
      const begin = dataStart + Number(other.offset);
      const end = begin + other.size;
      if (!Number.isSafeInteger(end) || end > asar.length) fail('other entry outside archive');
      if (begin < start + node.size && start < end) fail('overlapping archive entries');
    }
  };
  checkTree(header);
  return { header, headerBlock, dataStart, node, start, body: asar.subarray(start, start + node.size) };
}

/**
 * Compute the patched archive in memory.
 * @returns {null | {asar: Buffer, integrity: object, changedBytes: number}} null when already patched.
 */
export function planPatch(asar) {
  const { headerBlock, node, start, body } = readEntry(asar);
  const spans = locateIntegrity(headerBlock);
  const strict = validateEntryIntegrity(body, node.integrity);
  if (strict !== null) fail(`${TARGET_ENTRY} already fails its own integrity check: ${strict}`);

  const source = body.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(body)) fail(`${TARGET_ENTRY} is not UTF-8 clean; refusing a text edit`);

  const counts = APPLIED_MARKERS.map((marker) => source.split(marker).length - 1);
  if (counts.some((n) => n > 1)) fail('duplicate applied marker');
  if (counts.every((n) => n === 1)) {
    if (sha256(body) !== '2c48061e36d9852f3ad8abf97ecab56f52d0b3642f2da64b5ca9b2bf64637568' || source.split(A_BODY).length !== 2 || source.split(B_BODY).length !== 2) {
      fail('unrecognized applied patch');
    }
    return null;
  }
  if (APPLIED_MARKERS.some((marker) => source.includes(marker))) {
    fail(`${TARGET_ENTRY} carries a partial patch; restore from backup before retrying`);
  }

  const aStart = source.indexOf(A_START);
  if (aStart === -1) fail('region A marker missing; this DSH build is not supported');
  if (source.indexOf(A_START, aStart + 1) !== -1) fail('region A marker is ambiguous');

  const acquireAt = source.indexOf('\tacquire(owner, workspace) {', aStart);
  if (acquireAt === -1) fail('acquire() not found inside region A');
  const closing = source.indexOf('\n\t}\n', acquireAt);
  if (closing < 0) fail('acquire() end missing');
  const acquireEnd = closing + 4;
  const aOriginal = source.slice(aStart, acquireEnd);
  // SHA-256 of the exact supported upstream region, including all whitespace.
  // Anchors alone are insufficient: an upstream acquire() might have new logic.
  if (sha256(Buffer.from(aOriginal, 'utf8')) !== 'e39551c1b2dfb77622679c3d21417eaccca9396d8a89e4be95b520b785e77189') {
    fail('region A differs from the supported upstream build');
  }
  const aReplacement = fit(A_BODY, Buffer.byteLength(aOriginal), '\t', 'A');

  const bAt = source.indexOf(B_START);
  if (bAt === -1) fail('region B (guest preferences) not found; this DSH build is not supported');
  if (source.indexOf(B_START, bAt + 1) !== -1) fail('region B is ambiguous');
  const bReplacement = fit(B_BODY, Buffer.byteLength(B_START), '\t\t\t', 'B');
  // Region checks alone cannot recognize changes elsewhere in an unknown build.
  if (sha256(body) !== 'f42ed25b0b844a63e515a3aff93dee89b781dae7fcbbbbfc93e04d95ad399ec1') {
    fail('lib/main.js differs from the supported upstream build');
  }

  if (bAt < acquireEnd) fail('regions overlap or are out of order');
  const patched =
    source.slice(0, aStart) +
    aReplacement +
    source.slice(acquireEnd, bAt) +
    bReplacement +
    source.slice(bAt + B_START.length);

  const patchedBody = Buffer.from(patched, 'utf8');
  if (patchedBody.length !== body.length) fail('patched payload changed length; aborting');

  const integrity = {
    algorithm: 'SHA256',
    hash: sha256(patchedBody),
    blockSize: node.integrity.blockSize,
    blocks: [],
  };
  for (let offset = 0; offset < patchedBody.length; offset += integrity.blockSize) {
    integrity.blocks.push(
      sha256(patchedBody.subarray(offset, Math.min(offset + integrity.blockSize, patchedBody.length))),
    );
  }
  if (integrity.blocks.length !== node.integrity.blocks.length) fail('block count changed unexpectedly');
  const selfCheck = validateEntryIntegrity(patchedBody, integrity);
  if (selfCheck !== null) fail(`computed integrity does not validate: ${selfCheck}`);

  return finish(asar, { spans, node, start, body, patchedBody, integrity });
}

// Strict token walk: keeps the original JSON byte positions, including whitespace
// and key order.  The archive header is never re-serialized.
function locateIntegrity(headerBlock) {
  const text = headerBlock.toString('utf8');
  if (!Buffer.from(text).equals(headerBlock)) fail('header is not UTF-8 clean');
  JSON.parse(text); // validate the whole grammar before token walking
  const prefix = ['files', 'lib', 'files', 'main.js', 'integrity'];
  const spans = { blocks: [] };
  let pos = 0;
  const ws = () => {
    while (/[\t\r\n ]/.test(text[pos] ?? '\0')) pos++;
  };
  function stringToken() {
    const start = pos;
    if (text[pos++] !== '"') fail('expected JSON string');
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '\\') {
        pos++;
        continue;
      }
      if (c === '"') return { start, end: pos, value: JSON.parse(text.slice(start, pos)) };
    }
    fail('unterminated JSON string');
  }
  function walk(path, depth) {
    if (depth > 200) fail('JSON nesting too deep');
    ws();
    const c = text[pos];
    if (c === '{') {
      pos++;
      ws();
      const keys = new Set();
      if (text[pos] === '}') {
        pos++;
        return;
      }
      for (;;) {
        ws();
        const key = stringToken().value;
        if (keys.has(key)) fail('duplicate JSON key');
        keys.add(key);
        ws();
        if (text[pos++] !== ':') fail('invalid JSON object');
        walk([...path, key], depth + 1);
        ws();
        const ch = text[pos++];
        if (ch === '}') return;
        if (ch !== ',') fail('invalid JSON object');
      }
    }
    if (c === '[') {
      pos++;
      ws();
      let i = 0;
      if (text[pos] === ']') {
        pos++;
        return;
      }
      for (;;) {
        walk([...path, i++], depth + 1);
        ws();
        const ch = text[pos++];
        if (ch === ']') return;
        if (ch !== ',') fail('invalid JSON array');
      }
    }
    if (c === '"') {
      const tok = stringToken();
      if (prefix.every((p, i) => path[i] === p)) {
        const suffix = path.slice(prefix.length);
        const isHash = suffix.length === 1 && suffix[0] === 'hash';
        const isBlock = suffix.length === 2 && suffix[0] === 'blocks' && Number.isInteger(suffix[1]);
        if (isHash || isBlock) {
          // Escaped digests are valid JSON but cannot be replaced in place.
          if (!/^"[a-f0-9]{64}"$/.test(text.slice(tok.start, tok.end))) fail('unsupported digest encoding');
          const span = 16 + Buffer.byteLength(text.slice(0, tok.start + 1));
          if (isHash) spans.hash = span;
          else spans.blocks[suffix[1]] = span;
        }
      }
      return;
    }
    while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
  }
  walk([], 0);
  ws();
  if (pos !== text.length) fail('trailing JSON data');
  if (spans.hash === undefined) fail('missing hash span');
  return spans;
}

function finish(asar, { spans, node, start, body, patchedBody, integrity }) {
  if (spans.blocks.length !== integrity.blocks.length || spans.blocks.some((v) => v === undefined)) {
    fail('missing block span');
  }
  const result = Buffer.from(asar);
  const put = (at, oldHash, next) => {
    if (result.toString('ascii', at, at + 64) !== oldHash) fail('digest span mismatch');
    result.write(next, at, 64, 'ascii');
  };
  put(spans.hash, node.integrity.hash, integrity.hash);
  integrity.blocks.forEach((hash, i) => put(spans.blocks[i], node.integrity.blocks[i], hash));
  patchedBody.copy(result, start);
  const checked = readEntry(result);
  const verdict = validateEntryIntegrity(checked.body, checked.node.integrity);
  if (verdict !== null || !checked.body.equals(patchedBody) || result.length !== asar.length) {
    fail(`output verification failed: ${verdict}`);
  }
  let changedBytes = 0;
  for (let i = 0; i < body.length; i++) if (body[i] !== patchedBody[i]) changedBytes++;
  return { asar: result, integrity, changedBytes };
}
