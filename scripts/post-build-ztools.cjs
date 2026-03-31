// Cross-platform file copy step after `vite build --mode ztools`
// Replaces Windows-only `copy` commands in the build:ztools npm script.
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist-ztools');

function copy(src, dst) {
    fs.copyFileSync(src, dst);
    console.log(`  ✓ ${path.relative(rootDir, src)} → ${path.relative(rootDir, dst)}`);
}

copy(path.join(rootDir, 'ztools', 'plugin.json'), path.join(distDir, 'plugin.json'));
copy(path.join(rootDir, 'ztools', 'preload.js'),  path.join(distDir, 'preload.js'));
copy(path.join(rootDir, 'public', 'logo.png'),    path.join(distDir, 'logo.png'));
copy(path.join(rootDir, 'ztools', 'package.json'), path.join(distDir, 'package.json'));
