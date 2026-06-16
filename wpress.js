#!/usr/bin/env node
'use strict';

/**
 * wpress.js — a small, dependency-free CLI for working with All-in-One WP
 * Migration `.wpress` archives.
 *
 * Commands:
 *   list         List every file stored in the archive.
 *   extract      Extract the whole archive to a directory.
 *   extract-file Extract one or more individual files (by name or glob).
 *
 * The .wpress format is a flat, sequential container:
 *   [header block][file bytes][header block][file bytes]...[empty header = EOF]
 *
 * Each header block is 4377 bytes, laid out as:
 *   offset    0, len  255  filename       (null-terminated ASCII)
 *   offset  255, len   14  file size      (ASCII integer)
 *   offset  269, len   12  mtime          (ASCII integer, unix seconds)
 *   offset  281, len 4096  prefix / path  (null-terminated ASCII)
 *
 * An all-zero header block signals end of archive.
 */

const fs = require('fs');
const path = require('path');

// Exit quietly when a downstream pipe closes early (e.g. `wpress list | head`).
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

const HEADER_SIZE = 4377;

const OFFSET = {
  name: { start: 0, end: 255 },
  size: { start: 255, end: 269 },
  mtime: { start: 269, end: 281 },
  prefix: { start: 281, end: 4377 },
};

const EOF_BLOCK = Buffer.alloc(HEADER_SIZE, 0);
const READ_CHUNK = 512 * 1024; // 512 KiB read buffer for copying file bodies

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

/** Read a null-terminated ASCII string out of a slice of the header. */
function readString(headerBuffer, { start, end }) {
  const slice = headerBuffer.slice(start, end);
  const nullIndex = slice.indexOf(0x00);
  const text = nullIndex === -1 ? slice : slice.slice(0, nullIndex);
  return text.toString('utf8');
}

/**
 * Parse a 4377-byte header block into a descriptor.
 * Returns null when the block is the EOF marker.
 */
function parseHeader(headerBuffer) {
  if (headerBuffer.length < HEADER_SIZE || headerBuffer.equals(EOF_BLOCK)) {
    return null;
  }

  const name = readString(headerBuffer, OFFSET.name);

  // End of archive. The classic marker is an all-zero block, but
  // All-in-One WP Migration also writes a footer block with an empty
  // filename (its size field holds the total archive size). No real
  // file has an empty name, so treat any empty-name block as EOF.
  if (name === '') {
    return null;
  }

  const size = parseInt(readString(headerBuffer, OFFSET.size), 10) || 0;
  const mtime = parseInt(readString(headerBuffer, OFFSET.mtime), 10) || 0;
  const prefix = readString(headerBuffer, OFFSET.prefix);

  // The path inside the archive. Prefix already contains the directory.
  const relativePath = prefix === '.' ? name : path.posix.join(prefix, name);

  return { name, size, mtime, prefix, relativePath };
}

// ---------------------------------------------------------------------------
// Low-level archive reader
// ---------------------------------------------------------------------------

/** Read exactly `length` bytes from `fd` starting at `position`. */
function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const n = fs.readSync(fd, buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (n === 0) break; // hit EOF early
    bytesRead += n;
  }
  return bytesRead === length ? buffer : buffer.slice(0, bytesRead);
}

/**
 * Walk the archive, yielding one entry per stored file.
 * Each entry: { ...header, dataOffset } where dataOffset is the byte position
 * of the file's contents within the archive.
 */
function* iterateEntries(fd) {
  const stats = fs.fstatSync(fd);
  let position = 0;

  while (position + HEADER_SIZE <= stats.size) {
    const headerBuffer = readExact(fd, HEADER_SIZE, position);
    const header = parseHeader(headerBuffer);
    if (!header) break; // EOF block

    position += HEADER_SIZE;
    yield { ...header, dataOffset: position };
    position += header.size; // skip past the file body
  }
}

// A synchronous sleep, used to back off when a pipe is momentarily full.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

/**
 * Write a whole buffer to a fd, even when that fd is a non-blocking pipe.
 * Node marks stdout non-blocking when piped, so fs.writeSync can short-write
 * or throw EAGAIN; loop, backing off briefly on EAGAIN.
 */
function writeFullSync(fd, buffer, offset, length) {
  let written = 0;
  while (written < length) {
    try {
      written += fs.writeSync(fd, buffer, offset + written, length - written);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        sleepMs(2);
        continue;
      }
      throw err;
    }
  }
}

/** Copy `size` bytes from `srcFd` at `position` into `destFd`. */
function copyBytes(srcFd, position, size, destFd) {
  let remaining = size;
  let cursor = position;
  const buffer = Buffer.alloc(Math.min(READ_CHUNK, size || 1));

  while (remaining > 0) {
    const want = Math.min(remaining, buffer.length);
    const got = fs.readSync(srcFd, buffer, 0, want, cursor);
    if (got === 0) break;
    writeFullSync(destFd, buffer, 0, got);
    cursor += got;
    remaining -= got;
  }
}

// ---------------------------------------------------------------------------
// Glob / name matching
// ---------------------------------------------------------------------------

/**
 * Turn a glob into a RegExp. Patterns are matched against the full archive
 * path (anchored), so they behave like `unzip`/`tar`:
 *   "*"      matches any run of characters except "/"
 *   "?"      matches a single non-"/" character
 *   "**"     matches across "/" (any depth)
 *   "** then /"  matches zero or more leading directories, so a leading
 *                double-star before index.php matches both "index.php" and
 *                "a/b/index.php"
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // **/  -> optional leading dirs
          i += 2;
        } else {
          re += '.*'; // **   -> anything, crossing /
          i += 1;
        }
      } else {
        re += '[^/]*'; // *    -> within one path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does an entry match the user-supplied pattern? Patterns are anchored at the
 * archive root, like `unzip`:
 *   - exact path:        "index.php"            -> only the root index.php
 *   - directory subtree: "uploads/2022"         -> everything beneath it
 *   - glob:              "uploads/2022/*.pdf"   -> PDFs in that one folder
 *   - recursive glob:    "**\/index.php"         -> every index.php, any depth
 */
function entryMatches(entry, pattern) {
  const rel = entry.relativePath;

  if (pattern.includes('*') || pattern.includes('?')) {
    return globToRegExp(pattern).test(rel);
  }

  if (rel === pattern) return true;

  const dir = pattern.replace(/\/+$/, '');
  return rel.startsWith(`${dir}/`);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEntry(srcFd, entry, destPath) {
  ensureDir(path.dirname(destPath));
  const destFd = fs.openSync(destPath, 'w');
  try {
    copyBytes(srcFd, entry.dataOffset, entry.size, destFd);
  } finally {
    fs.closeSync(destFd);
  }
  if (entry.mtime) {
    const when = new Date(entry.mtime * 1000);
    try {
      fs.utimesSync(destPath, when, when);
    } catch (_) {
      /* mtime is best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Format the mtime column for long listings. */
function formatDate(mtime) {
  return mtime
    ? new Date(mtime * 1000).toISOString().slice(0, 19).replace('T', ' ')
    : '-'.padEnd(19);
}

/** Print one row, honoring the -l/--long flag. */
function listRow(label, size, mtime, opts, extra) {
  if (!opts.long) {
    process.stdout.write(`${label}\n`);
    return;
  }
  process.stdout.write(
    `${formatBytes(size).padStart(10)}  ${formatDate(mtime)}  ${label}${extra || ''}\n`
  );
}

function cmdList(input, subPath, opts) {
  // Normalize the path filter to a posix prefix with no leading/trailing slash.
  const base = (subPath || '').replace(/^\/+|\/+$/g, '');
  const fd = fs.openSync(input, 'r');
  try {
    // Recursive mode: flat dump of every file (optionally scoped to `base`).
    if (opts.recursive) {
      let count = 0;
      let total = 0;
      for (const entry of iterateEntries(fd)) {
        if (base && entry.relativePath !== base && !entry.relativePath.startsWith(`${base}/`)) {
          continue;
        }
        count++;
        total += entry.size;
        listRow(entry.relativePath, entry.size, entry.mtime, opts);
      }
      process.stderr.write(`\n${count} files, ${formatBytes(total)} total\n`);
      return;
    }

    // Default mode: list only the immediate children of `base`, like `ls`.
    const dirs = new Map(); // dirName -> { size, files }
    const files = []; // { name, size, mtime }
    let matchedAny = false;

    for (const entry of iterateEntries(fd)) {
      let rel = entry.relativePath;

      if (base) {
        if (rel === base) {
          // The path points directly at a file.
          files.push({ name: path.posix.basename(rel), size: entry.size, mtime: entry.mtime });
          matchedAny = true;
          continue;
        }
        if (!rel.startsWith(`${base}/`)) continue;
        rel = rel.slice(base.length + 1);
      }
      matchedAny = true;

      const slash = rel.indexOf('/');
      if (slash === -1) {
        files.push({ name: rel, size: entry.size, mtime: entry.mtime });
      } else {
        const dirName = rel.slice(0, slash);
        const d = dirs.get(dirName) || { size: 0, files: 0 };
        d.size += entry.size;
        d.files += 1;
        dirs.set(dirName, d);
      }
    }

    if (!matchedAny && base) {
      process.stderr.write(`No such path in archive: ${base}\n`);
      process.exitCode = 1;
      return;
    }

    // Directories first (alphabetical), then files (alphabetical) — like `ls`.
    const dirNames = [...dirs.keys()].sort();
    files.sort((a, b) => a.name.localeCompare(b.name));

    for (const name of dirNames) {
      const d = dirs.get(name);
      listRow(`${name}/`, d.size, null, opts, `  (${d.files} file${d.files === 1 ? '' : 's'})`);
    }
    for (const f of files) {
      listRow(f.name, f.size, f.mtime, opts);
    }

    const totalSize =
      [...dirs.values()].reduce((s, d) => s + d.size, 0) +
      files.reduce((s, f) => s + f.size, 0);
    process.stderr.write(
      `\n${dirNames.length} dir(s), ${files.length} file(s)` +
        `${base ? ` in ${base}/` : ''}, ${formatBytes(totalSize)}\n`
    );
  } finally {
    fs.closeSync(fd);
  }
}

function cmdExtract(input, output, opts) {
  if (fs.existsSync(output)) {
    const entries = fs.readdirSync(output);
    if (entries.length > 0 && !opts.force) {
      throw new Error(
        `Output directory "${output}" already exists and is not empty. Use --force to extract anyway.`
      );
    }
  }
  ensureDir(output);

  const fd = fs.openSync(input, 'r');
  try {
    let count = 0;
    for (const entry of iterateEntries(fd)) {
      const destPath = path.join(output, entry.relativePath);
      writeEntry(fd, entry, destPath);
      count++;
      process.stderr.write(`\rExtracted ${count} files...`);
    }
    process.stderr.write(`\rExtracted ${count} files to "${output}"\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function cmdExtractFile(input, patterns, opts) {
  const output = opts.output || '.';

  // Optional explicit allow-list of exact archive paths (one per line).
  let fromSet = null;
  if (opts.from) {
    const text = fs.readFileSync(opts.from, 'utf8');
    fromSet = new Set(text.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean));
  }

  const fd = fs.openSync(input, 'r');
  try {
    let matched = 0;
    let totalSize = 0;
    for (const entry of iterateEntries(fd)) {
      const hit =
        (fromSet && fromSet.has(entry.relativePath)) ||
        patterns.some((p) => entryMatches(entry, p));
      if (!hit) continue;

      // Flat mode drops the directory structure; default preserves it.
      const destRel = opts.flat ? entry.name : entry.relativePath;
      const destPath = path.join(output, destRel);
      matched++;
      totalSize += entry.size;

      if (opts.dryRun) {
        process.stdout.write(`${entry.relativePath}  (${formatBytes(entry.size)})\n`);
      } else {
        writeEntry(fd, entry, destPath);
        process.stderr.write(`Extracted ${entry.relativePath} -> ${destPath}\n`);
      }
    }
    if (matched === 0) {
      process.stderr.write(`No files matched: ${patterns.join(', ')}\n`);
      process.exitCode = 1;
    } else if (opts.dryRun) {
      process.stderr.write(`\n${matched} file(s) would be extracted, ${formatBytes(totalSize)}.\n`);
    } else {
      process.stderr.write(`\nExtracted ${matched} file(s), ${formatBytes(totalSize)}.\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function cmdCat(input, patterns) {
  const fd = fs.openSync(input, 'r');
  try {
    let matched = 0;
    for (const entry of iterateEntries(fd)) {
      if (!patterns.some((p) => entryMatches(entry, p))) continue;
      matched++;
      try {
        copyBytes(fd, entry.dataOffset, entry.size, 1); // fd 1 = stdout
      } catch (err) {
        if (err.code === 'EPIPE') return; // downstream closed (e.g. | head)
        throw err;
      }
    }
    if (matched === 0) {
      process.stderr.write(`No files matched: ${patterns.join(', ')}\n`);
      process.exitCode = 1;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function cmdManifest(input, subPath) {
  const base = (subPath || '').replace(/^\/+|\/+$/g, '');
  const fd = fs.openSync(input, 'r');
  try {
    for (const entry of iterateEntries(fd)) {
      if (base && entry.relativePath !== base && !entry.relativePath.startsWith(`${base}/`)) {
        continue;
      }
      // Machine-readable: "<bytes>\t<path>" — one file per line.
      process.stdout.write(`${entry.size}\t${entry.relativePath}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// tar streaming (for piping over ssh without staging to disk)
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

/** A numeric tar header field: zero-padded octal of `width-1` digits + NUL. */
function octalField(num, width) {
  return Buffer.from(`${num.toString(8).padStart(width - 1, '0')}\0`, 'latin1');
}

/** Build one 512-byte tar (ustar) header block. */
function tarHeader(name, size, mtime, typeflag) {
  const h = Buffer.alloc(TAR_BLOCK, 0);
  const nameBuf = Buffer.from(name, 'utf8').slice(0, 100);
  nameBuf.copy(h, 0);
  octalField(0o644, 8).copy(h, 100); // mode
  octalField(0, 8).copy(h, 108); // uid
  octalField(0, 8).copy(h, 116); // gid
  octalField(size, 12).copy(h, 124); // size
  octalField(mtime || 0, 12).copy(h, 136); // mtime
  h.write(typeflag, 156, 'latin1'); // typeflag
  h.write('ustar\0', 257, 'latin1'); // magic
  h.write('00', 263, 'latin1'); // version

  // Checksum: sum of all bytes with the checksum field treated as spaces.
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** Write a buffer to stdout (fd 1), translating a closed pipe into a clean exit. */
function writeStdout(buf) {
  try {
    writeFullSync(1, buf, 0, buf.length);
  } catch (err) {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  }
}

/** Pad the current entry up to the next 512-byte boundary. */
function tarPad(size) {
  const rem = size % TAR_BLOCK;
  if (rem !== 0) writeStdout(Buffer.alloc(TAR_BLOCK - rem, 0));
}

function cmdTar(input, patterns, opts) {
  const strip = (opts.strip || '').replace(/\/+$/, '');
  const fd = fs.openSync(input, 'r');
  try {
    let matched = 0;
    for (const entry of iterateEntries(fd)) {
      if (!patterns.some((p) => entryMatches(entry, p))) continue;

      // Rewrite the stored path to the name we want inside the tar stream.
      let name = entry.relativePath;
      if (strip) {
        if (name === strip) continue; // the directory itself, no file body
        if (name.startsWith(`${strip}/`)) name = name.slice(strip.length + 1);
      }
      if (name === '') continue;
      matched++;

      // Names longer than 100 bytes need a GNU long-name (‘L’) entry first.
      if (Buffer.byteLength(name, 'utf8') > 100) {
        const longData = Buffer.from(`${name}\0`, 'utf8');
        writeStdout(tarHeader('././@LongLink', longData.length, 0, 'L'));
        writeStdout(longData);
        tarPad(longData.length);
      }

      writeStdout(tarHeader(name, entry.size, entry.mtime, '0'));
      // Stream the file body straight from the archive to stdout.
      try {
        copyBytes(fd, entry.dataOffset, entry.size, 1);
      } catch (err) {
        if (err.code === 'EPIPE') return;
        throw err;
      }
      tarPad(entry.size);
    }

    if (matched === 0) {
      process.stderr.write(`No files matched: ${patterns.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    // Two zero blocks mark end-of-archive.
    writeStdout(Buffer.alloc(TAR_BLOCK * 2, 0));
    process.stderr.write(`Streamed ${matched} file(s) as tar.\n`);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Tiny argument parser & CLI dispatch
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Flags that take a value.
      if (key === 'output' || key === 'out') {
        flags.output = argv[++i];
      } else if (key === 'strip') {
        flags.strip = argv[++i];
      } else if (key === 'from') {
        flags.from = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (key === 'o') {
        flags.output = argv[++i];
      } else if (key === 'l') {
        flags.long = true;
      } else if (key === 'f') {
        flags.force = true;
      } else if (key === 'R') {
        flags.recursive = true;
      } else if (key === 'n') {
        flags['dry-run'] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const USAGE = `wpress — work with All-in-One WP Migration .wpress archives

Usage:
  wpress list <archive.wpress> [path] [-l|--long] [-R|--recursive]
  wpress cat <archive.wpress> <name|path> [more...]
  wpress tar <archive.wpress> <name|dir> [more...] [--strip prefix]   (tar -> stdout)
  wpress manifest <archive.wpress> [path]                             ("<bytes>\\t<path>" lines)
  wpress extract <archive.wpress> [output-dir] [-f|--force]
  wpress extract-file <archive.wpress> <name|glob> [more...] [-o out-dir] [--flat]

Commands:
  list           Browse the archive like "ls": shows the immediate contents
                 of the archive root, or of [path] if given. Subfolders are
                 listed once with a trailing "/" and a file count.
                   path             List inside this folder (e.g. uploads/2022).
                   -l, --long       Show size and modification time.
                   -R, --recursive  List every file in every folder (flat).

  cat            Print a file's contents to stdout (raw bytes). Matching
                 follows the same rules as extract-file; if several files
                 match they are concatenated.

  tar            Stream matching files to stdout as a tar archive, without
                 staging anything to disk. Ideal for piping over ssh:
                   wpress tar bk.wpress uploads --strip uploads \\
                     | ssh user@host 'tar -x -C /var/www/.../uploads'
                   --strip prefix  Remove this leading path from tar entry
                                   names (so a directory's CONTENTS land in
                                   the target dir).

  extract        Extract the entire archive.
                   output-dir   Defaults to the archive name without .wpress
                   -f, --force  Extract even if the output dir is non-empty.

  extract-file   Extract individual files or whole directories. Patterns are
                 anchored at the archive root (like unzip):
                   - an exact path   index.php       (only the root index.php)
                   - a directory     uploads/2022    (extracts the whole tree)
                   - a glob          uploads/2022/*.pdf   (* within a folder,
                                     ? one char)
                   - recursive glob  **/index.php    (every index.php, any depth)
                 Options:
                   -o, --output     Destination dir (default: current dir).
                   --flat           Ignore archive folders; write files flat.
                   --from FILE      Extract the exact paths listed in FILE
                                    (one per line); combinable with patterns.
                   -n, --dry-run    Show what would be extracted, write nothing.

  manifest       Print "<bytes><TAB><path>" for every file (optionally under
                 a path). Machine-readable; used for size-budgeted batching.

Examples:
  wpress list backup.wpress
  wpress list backup.wpress uploads/2022 -l
  wpress list backup.wpress -R | grep wp-config
  wpress cat backup.wpress wp-config.php
  wpress extract backup.wpress ./site --force
  wpress extract-file backup.wpress 'database.sql'
  wpress extract-file backup.wpress 'uploads/*.jpg' -o ./images
  wpress extract-file backup.wpress wp-config.php --flat -o ./tmp
`;

function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const { positionals, flags } = parseArgs(rest);
  const input = positionals[0];

  if (!input) {
    throw new Error('Missing <archive.wpress> argument. Run "wpress help".');
  }
  if (!fs.existsSync(input)) {
    throw new Error(`Archive not found: ${input}`);
  }
  if (fs.statSync(input).isDirectory()) {
    const guess = `${input}.wpress`;
    const hint = fs.existsSync(guess) ? ` Did you mean "${guess}"?` : '';
    throw new Error(
      `"${input}" is a directory, not a .wpress archive.${hint}`
    );
  }

  switch (command) {
    case 'list':
    case 'ls':
      cmdList(input, positionals[1], { long: !!flags.long, recursive: !!flags.recursive });
      break;

    case 'extract':
    case 'x': {
      const output =
        positionals[1] || path.basename(input).replace(/\.wpress$/i, '') || 'wpress-out';
      cmdExtract(input, output, { force: !!flags.force });
      break;
    }

    case 'cat': {
      const patterns = positionals.slice(1);
      if (patterns.length === 0) {
        throw new Error('cat needs at least one <name|path>. Run "wpress help".');
      }
      cmdCat(input, patterns);
      break;
    }

    case 'manifest':
      cmdManifest(input, positionals[1]);
      break;

    case 'tar': {
      const patterns = positionals.slice(1);
      if (patterns.length === 0) {
        throw new Error('tar needs at least one <name|dir>. Run "wpress help".');
      }
      cmdTar(input, patterns, { strip: flags.strip });
      break;
    }

    case 'extract-file':
    case 'xf': {
      const patterns = positionals.slice(1);
      if (patterns.length === 0 && !flags.from) {
        throw new Error('extract-file needs a <name|glob> or --from <file>. Run "wpress help".');
      }
      cmdExtractFile(input, patterns, {
        output: flags.output,
        flat: !!flags.flat,
        from: flags.from,
        dryRun: !!flags['dry-run'] || !!flags.n,
      });
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run "wpress help".`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}
