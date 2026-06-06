'use strict';

// Postinstall: ensures the @solana/buffer-layout-utils override (which replaces
// the bigint-buffer vulnerable C addon with native Node.js BigInt) is resolvable
// at runtime. npm v10 creates a broken relative symlink for file: overrides on
// nested packages — this script copies the shim to the expected target location.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHIM_SRC = path.join(ROOT, 'local_modules', 'buffer-layout-utils');

// The symlink npm creates points ../../local_modules/buffer-layout-utils relative
// to node_modules/@solana/spl-token/node_modules/@solana/, which resolves to:
const SHIM_DEST = path.join(
  ROOT,
  'node_modules',
  '@solana',
  'spl-token',
  'local_modules',
  'buffer-layout-utils'
);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

if (!fs.existsSync(SHIM_SRC)) {
  // Local_modules missing — shim was removed or never present; nothing to do.
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, 'node_modules', '@solana', 'spl-token'))) {
  // spl-token not installed yet; npm install will handle it.
  process.exit(0);
}

copyDir(SHIM_SRC, SHIM_DEST);
console.log('[postinstall] @solana/buffer-layout-utils shim applied (native BigInt, no bigint-buffer)');
