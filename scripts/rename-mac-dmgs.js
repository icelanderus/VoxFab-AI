#!/usr/bin/env node
/**
 * After electron-builder, rename DMG + blockmap from ...-macOS-${arch} to human-readable names.
 * Usage: node scripts/rename-mac-dmgs.js arm64 | x64
 */
'use strict';

const fs = require('fs');
const path = require('path');

const arch = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const v = pkg.version;
const dist = path.join(__dirname, '..', 'dist');

const dest = {
  arm64: `VoxFab-AI-${v}-macOS-Apple-Silicon-M1-M2-M3`,
  x64: `VoxFab-AI-${v}-macOS-Intel-x64`
}[arch];

if (!dest) {
  console.error('Usage: node scripts/rename-mac-dmgs.js arm64|x64');
  process.exit(1);
}

const srcBase = `VoxFab-AI-${v}-macOS-${arch}`;

for (const ext of ['.dmg', '.dmg.blockmap']) {
  const from = path.join(dist, srcBase + ext);
  const to = path.join(dist, dest + ext);
  if (fs.existsSync(from)) {
    if (fs.existsSync(to)) fs.unlinkSync(to);
    fs.renameSync(from, to);
    console.log('Renamed', path.basename(from), '→', path.basename(to));
  }
}
