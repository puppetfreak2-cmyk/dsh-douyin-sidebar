// SHA-256 in two independent implementations.
//
// Why this exists
// ---------------
// The safety gate of the patcher ("is this archive healthy?") cannot rest on a
// single native digest.  On this machine (Node v24.21.0, Windows) a full sweep of
// the live 213 MB archive intermittently reported one or two *unrelated* entries
// as failing — a different set each round, roughly one bad digest per 36,000
// entry checks, always in a small entry.  Re-hashing the very same bytes
// immediately afterwards always agreed with the stored hash, and hammering one
// entry 20,000 times in a vacuum never disagreed.  A 256 MB memory-integrity
// test (write pattern, re-read, compare) was clean, so the bytes are not
// decaying; the disagreement is in the native hashing path when many distinct
// buffers are hashed back to back.
//
// Electron itself validates the archive with Chromium's BoringSSL, not with
// Node's crypto, so this quirk does not make a patched archive unlaunchable.
// It does make a native-only verifier unreliable in both directions: it can
// refuse a healthy archive (harmless but confusing) or, if the check is skipped,
// accept a damaged one.  So:
//   * `pureSha256` is a dependency-free FIPS 180-4 implementation that never
//     touches native crypto, and is self-tested against published vectors;
//   * `digestOf` uses native when it reproduces itself and pure JS when it does not;
//   * `matchesDigest` accepts a match from either implementation, and only reports
//     a mismatch after native twice *and* pure JS have all disagreed.
// Net effect: a flaky native digest can no longer fail a healthy archive, and a
// real corruption is still caught — by a code path that never showed the flakiness.
import { createHash } from 'node:crypto';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * SHA-256 computed entirely in JavaScript: no native crypto, no CPU SHA extensions.
 * Used only to adjudicate the rare disputed digest, so clarity beats speed.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string} lowercase hex digest
 */
export function pureSha256(bytes) {
  const length = bytes.length;
  const blocks = ((length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(blocks);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const bits = length * 8;
  view.setUint32(blocks - 8, Math.floor(bits / 0x100000000));
  view.setUint32(blocks - 4, bits >>> 0);

  const h = Uint32Array.from(IV);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < blocks; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) out += h[i].toString(16).padStart(8, '0');
  return out;
}

/** Fast native digest. Untrusted on its own — see the note at the top. */
export const nativeSha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Authoritative digest: native when it reproduces itself, pure JS when it does not.
 *
 * @param {Buffer} data
 * @returns {string} lowercase hex digest
 */
export function digestOf(data) {
  const first = nativeSha256(data);
  const second = nativeSha256(Buffer.from(data));
  return first === second ? first : pureSha256(data);
}

/**
 * Does this data match a recorded digest?
 *
 * Native first (fast, correct in ~all cases).  Only when native disagrees does the
 * pure-JS implementation get a vote — twice-native-says-no is precisely the
 * situation where native has been observed to lie, so a mismatch is confirmed in
 * JavaScript before being reported.
 *
 * @param {Buffer} data
 * @param {string} expected lowercase hex digest
 * @returns {boolean}
 */
export function matchesDigest(data, expected) {
  if (nativeSha256(data) === expected) return true;
  if (nativeSha256(Buffer.from(data)) === expected) return true;
  return pureSha256(data) === expected;
}

/** Known-answer test vectors, used by the test suite and by `check`. */
export const SHA256_VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];

/** Verify the pure implementation against published vectors. */
export function selfTest() {
  for (const [input, expected] of SHA256_VECTORS) {
    const got = pureSha256(Buffer.from(input, 'utf8'));
    if (got !== expected) return `pureSha256(${JSON.stringify(input.slice(0, 12))}) = ${got}, expected ${expected}`;
    if (nativeSha256(Buffer.from(input, 'utf8')) !== expected) return `nativeSha256 disagrees on a known vector`;
  }
  return null;
}
