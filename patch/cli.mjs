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
//  * The original and replacement are checked, backup and temporary file are read
//    back, and the target is compared again immediately before rename. The installed
//    bytes are read back and checked after rename. These checks are not a lock or an
//    atomic compare-and-replace; another process can still race the final comparison.
//  * A failure after replacement may leave a changed archive; there is no auto-rollback.
//  * `restore` binds a backup to the installed archive by result: re-running the
//    deterministic patch on the backup must reproduce the installed bytes exactly.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

// This is only a permission/in-use probe, not a lock and not proof the app is closed.
function assertWritable(file) {
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

// Hooks are for deterministic offline simulation; the CLI never supplies them.
export function replaceVerified(file, original, replacement, backup, hooks = {}) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  let tempCreated = false;
  let replaced = false;
  try {
    const mode = statSync(file).mode;
    writeFileSync(backup, original, { mode, flag: 'wx' });
    hooks.afterBackup?.({ file, backup, temporary });
    if (!readFileSync(backup).equals(original)) throw new Error('backup readback differs from original');
    const fd = openSync(temporary, 'wx', mode);
    tempCreated = true;
    try { writeFileSync(fd, replacement); } finally { closeSync(fd); }
    hooks.afterTemporary?.({ file, backup, temporary });
    const staged = readFileSync(temporary);
    if (!staged.equals(replacement) || sweepArchive(staged).failures.length) throw new Error('temporary archive verification failed');
    hooks.beforeCompare?.({ file, backup, temporary });
    if (!readFileSync(file).equals(original)) throw new Error('target changed since it was read; refusing replacement');
    hooks.afterCompare?.({ file, backup, temporary });
    renameSync(temporary, file);
    tempCreated = false;
    replaced = true;
    hooks.afterRename?.({ file, backup, temporary });
    const installed = readFileSync(file);
    if (!installed.equals(replacement) || sweepArchive(installed).failures.length) throw new Error('installed archive verification failed');
  } catch (error) {
    throw new PatchError(`replacement failed ${replaced ? 'after rename; the archive may already be changed' : 'before rename; target was not replaced by this process'}; backup may exist at ${backup}: ${error?.message ?? error}`);
  } finally {
    if (tempCreated) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
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
  assertWritable(asarPath);
  const backup = `${asarPath}.bak-${timestamp()}`;
  replaceVerified(asarPath, asar, planned.asar, backup);
  console.log(`backup         : ${backup} (read back and compared)`);
  console.log(`patched        : ${asarPath}`);
  console.log(`changed bytes  : ${planned.changedBytes} in ${TARGET_ENTRY}`);
  console.log(`new header     : ${verification.headerHash}`);
  console.log('Restart DeepSeek Harness, then open the Douyin panel once and sign in.');
  return 0;
}

function restore(asarPath) {
  const current = readFileSync(asarPath);

  // Restore is only meaningful on a patched archive.  planPatch is deterministic,
  // so "still patchable" means "not patched".
  if (planPatch(current) !== null) {
    throw new PatchError(`restore: ${asarPath} is not patched by this tool; nothing to restore`);
  }

  // A backup is bound to the installed archive by result, not by name or date:
  // re-running the deterministic patch on the backup must reproduce the exact
  // bytes that are installed right now.  A stale or foreign backup cannot pass.
  const dir = dirname(asarPath);
  const prefix = `${basename(asarPath)}.bak-`;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();

  const bound = [];
  for (const name of candidates) {
    const path = join(dir, name);
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    if (!bytes.length) continue;
    let planned = null;
    try {
      planned = planPatch(bytes);
    } catch {
      continue;
    }
    if (planned === null) continue; // already patched, cannot be the pre-image
    if (!planned.asar.equals(current)) continue;
    bound.push({ name, path, bytes });
  }

  if (bound.length === 0) {
    throw new PatchError(
      `restore: no backup in ${dir} reproduces the installed archive byte for byte; ` +
        'refusing to guess which backup belongs here (no files were changed)',
    );
  }

  const chosen = bound[0];
  const sweep = sweepArchive(chosen.bytes);
  if (sweep.failures.length) {
    throw new PatchError(`restore: backup ${chosen.name} failed integrity verification: ${sweep.failures.slice(0, 3).join('; ')}`);
  }

  console.log(`backup to use  : ${chosen.name}`);
  console.log(`  verified     : re-patching it reproduces the installed archive exactly`);
  console.log(`  header sha256: ${sweep.headerHash}`);
  console.log(`  entries      : ${sweep.checked} (unpacked ${sweep.unpacked}, links ${sweep.links})`);
  if (bound.length > 1) {
    console.log(`  note         : ${bound.length} backups match; using the newest`);
  }
  console.log(`restoring      : ${asarPath}`);

  assertWritable(asarPath);
  const safety = `${asarPath}.bak-${timestamp()}`;
  replaceVerified(asarPath, current, chosen.bytes, safety);
  console.log(`kept a copy of the patched archive at: ${safety}`);
  console.log('Restore DeepSeek Harness: the persistent sidebar session will no longer be used.');
  return 0;
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
        if (!options.apply) {
          console.log('restore is a write operation; re-run with --apply to restore the archive');
          return 0;
        }
        return restore(asarPath);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
