#!/usr/bin/env node
// Applies / reverts the desktop-persistence patch for DSH's sidebar browser guests.
//
// Usage:
//   node patch/cli.mjs check   --asar "<path to app.asar>"
//   node patch/cli.mjs apply   --asar "<path to app.asar>" --apply
//   node patch/cli.mjs restore --asar "<path to app.asar>" --apply
//
// Safety model
//  * `check` only reads.
//  * `apply`/`restore` do nothing without the literal `--apply` flag.
//  * Writing requires the file to be unlocked, which in practice means DSH is not
//    running.  A locked file fails loudly instead of half-patching.
//  * A timestamped backup sits next to the original before anything is replaced.
//  * The replacement is written to a temporary file in the same directory and then
//    moved over the original, so an interrupted write cannot leave a torn archive.
//  * The result is re-verified in memory (entry digest + full header sweep) before
//    the move; on any failure the original file is left untouched.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { sweepArchive } from './asar.mjs';
import { PatchError, TARGET_ENTRY, planPatch } from './patcher.mjs';

const USAGE = `usage:
  node patch/cli.mjs check   --asar <app.asar>
  node patch/cli.mjs apply   --asar <app.asar> --apply
  node patch/cli.mjs restore --asar <app.asar> --apply`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, asar: null, apply: false, help: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--apply') options.apply = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--asar') {
      options.asar = rest[i + 1] ?? null;
      i += 1;
    } else if (token.startsWith('--asar=')) options.asar = token.slice('--asar='.length);
    else throw new PatchError(`unknown argument: ${token}`);
  }
  return options;
}

// A writable handle is the only reliable "not in use" probe on Windows: the running
// app holds app.asar open.  A read-only success proves nothing, so both are tried.
function assertUnlocked(file) {
  let handle;
  try {
    handle = openSync(file, 'r+');
  } catch (error) {
    const reason = error?.code === 'EACCES' || error?.code === 'EPERM' ? 'access denied (read-only or in use)' : String(error?.message ?? error);
    throw new PatchError(
      `cannot open ${file} for writing: ${reason}.\n` +
        'Close DeepSeek Harness completely (and any process holding resources/app.asar), then retry from an elevated shell.',
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function atomicReplace(file, bytes) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: statSync(file).mode });
    renameSync(temporary, file);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw new PatchError(`failed to replace ${file}: ${error?.message ?? error}`);
  }
}

function describe(asar) {
  const sweep = sweepArchive(asar);
  return sweep;
}

function check(asarPath) {
  const asar = readFileSync(asarPath);
  const sweep = describe(asar);
  console.log(`archive        : ${asarPath}`);
  console.log(`bytes          : ${asar.length}`);
  console.log(`header sha256  : ${sweep.headerHash}`);
  console.log(`entries checked: ${sweep.checked} (unpacked ${sweep.unpacked}, links ${sweep.links})`);
  console.log(`integrity      : ${sweep.failures.length === 0 ? 'all packaged entries verified' : `${sweep.failures.length} failure(s)`}`);
  for (const line of sweep.failures.slice(0, 10)) console.log(`  - ${line}`);
  if (sweep.failures.length) throw new PatchError('archive failed full integrity verification');
  const planned = planPatch(asar);
  if (planned === null) {
    console.log('patch state    : already applied (no change)');
  } else {
    console.log(`patch state    : not applied; would edit ${TARGET_ENTRY}, ${planned.changedBytes} payload bytes`);
    console.log(`patched header : ${createHash('sha256').update(planned.asar.subarray(16, 16 + planned.asar.readUInt32LE(12))).digest('hex')}`);
  }
  return planned;
}

function apply(asarPath) {
  const asar = readFileSync(asarPath);
  const originalVerification = sweepArchive(asar);
  if (originalVerification.failures.length) {
    throw new PatchError(`archive failed full integrity verification: ${originalVerification.failures.slice(0, 3).join('; ')}`);
  }
  const planned = planPatch(asar);
  if (planned === null) {
    console.log('already patched; nothing to do');
    return 0;
  }
  const verification = sweepArchive(planned.asar);
  if (verification.failures.length !== 0) {
    throw new PatchError(`patched archive failed verification: ${verification.failures.slice(0, 3).join('; ')}`);
  }
  assertUnlocked(asarPath);
  const backup = `${asarPath}.bak-${timestamp()}`;
  if (existsSync(backup)) throw new PatchError(`backup already exists: ${backup}`);
  writeFileSync(backup, asar, { mode: statSync(asarPath).mode });
  console.log(`backup         : ${backup}`);
  atomicReplace(asarPath, planned.asar);
  console.log(`patched        : ${asarPath}`);
  console.log(`changed bytes  : ${planned.changedBytes} in ${TARGET_ENTRY}`);
  console.log(`new header     : ${verification.headerHash}`);
  console.log('Restart DeepSeek Harness, then open the Douyin panel once and sign in.');
  return 0;
}

function restore() {
  throw new PatchError('automatic restore disabled: backups cannot be reliably bound to the current archive; no files were changed');
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help || !options.command) {
      console.log(USAGE);
      return options?.help ? 0 : 2;
    }
    if (!options.asar) throw new PatchError('--asar <path to app.asar> is required');
    const asarPath = resolve(options.asar);
    if (!existsSync(asarPath)) throw new PatchError(`not found: ${asarPath}`);
    if (statSync(asarPath).isDirectory()) throw new PatchError(`expected a file, got a directory: ${asarPath}`);

    switch (options.command) {
      case 'check':
        check(asarPath);
        return 0;
      case 'apply':
        if (!options.apply) {
          check(asarPath);
          console.log('\nread-only preview; re-run with --apply to modify the archive');
          return 0;
        }
        return apply(asarPath);
      case 'restore':
        return restore();
      default:
        throw new PatchError(`unknown command: ${options.command}\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof PatchError) {
      console.error(`error: ${error.message}`);
      return 1;
    }
    console.error(`unexpected failure: ${error?.stack ?? error}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
