// Cross-platform file copy step after `vite build --mode utools`.
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist-utools');

function copy(relativePath) {
    const source = path.join(rootDir, relativePath);
    const target = path.join(distDir, path.basename(relativePath));
    fs.copyFileSync(source, target);
    console.log(`  ✓ ${relativePath} -> ${path.relative(rootDir, target)}`);
}

for (const file of [
    'utools/plugin.json',
    'utools/preload.js',
    'public/logo.png',
    'utools/package.json',
]) copy(file);
