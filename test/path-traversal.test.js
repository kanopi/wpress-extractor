#!/usr/bin/env node
'use strict';

// Regression test: crafted archive entries must never be written outside
// the output directory ("Zip Slip", CWE-22).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'wpress.js');
const HEADER_SIZE = 4377;

function header(name, size, prefix) {
  const b = Buffer.alloc(HEADER_SIZE);
  b.write(name, 0, 'latin1');
  b.write(String(size), 255, 'latin1');
  b.write('0', 269, 'latin1');
  b.write(prefix, 281, 'latin1');
  return b;
}

function buildArchive(file, entries) {
  const parts = [];
  for (const [name, prefix, body] of entries) {
    const data = Buffer.from(body);
    parts.push(header(name, data.length, prefix), data);
  }
  parts.push(Buffer.alloc(HEADER_SIZE));
  fs.writeFileSync(file, Buffer.concat(parts));
}

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'buffer' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpress-test-'));
try {
  const work = path.join(tmp, 'a', 'b');
  fs.mkdirSync(work, { recursive: true });
  const archive = path.join(work, 'evil.wpress');
  buildArchive(archive, [
    ['ok.txt', 'safe', 'fine\n'],
    ['evil.txt', '../../escaped', 'PWNED\n'],
    ['../flat-escape.txt', '.', 'PWNED\n'],
    ['deep.txt', 'safe/../../../../escaped2', 'PWNED\n'],
  ]);

  // extract
  let r = run(['extract', archive, 'out'], work);
  assert.notStrictEqual(r.status, 0, 'extract should exit non-zero when skipping unsafe entries');
  assert.ok(fs.existsSync(path.join(work, 'out', 'safe', 'ok.txt')), 'safe entry extracted');
  assert.ok(!fs.existsSync(path.join(tmp, 'a', 'escaped')), 'prefix traversal blocked');
  assert.ok(!fs.existsSync(path.join(tmp, 'escaped2')), 'deep traversal blocked');
  assert.ok(!fs.existsSync(path.join(work, 'flat-escape.txt')), 'name traversal blocked');

  // extract-file (preserved paths and --flat)
  r = run(['extract-file', archive, '**', '-o', 'out2'], work);
  assert.notStrictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'a', 'escaped')));
  r = run(['extract-file', archive, '**', '--flat', '-o', 'out3'], work);
  assert.ok(!fs.existsSync(path.join(work, 'flat-escape.txt')), '--flat name traversal blocked');

  // tar: no entry name in the stream may be absolute or contain "..".
  r = run(['tar', archive, '**'], work);
  const out = r.stdout;
  for (let off = 0; off + 512 <= out.length; ) {
    const name = out.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    assert.ok(!name.split('/').includes('..') && !name.startsWith('/'), `unsafe tar name: ${name}`);
    const size = parseInt(out.toString('latin1', off + 124, off + 136), 8) || 0;
    off += 512 + Math.ceil(size / 512) * 512;
  }

  console.log('path-traversal: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
