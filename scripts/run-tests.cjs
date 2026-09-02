const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const testDir = path.join(rootDir, 'tests');
const tsxCli = path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!fs.existsSync(tsxCli)) {
    console.error(`Missing local tsx CLI: ${tsxCli}. Run npm ci first.`);
    process.exit(1);
}
const testFiles = fs.readdirSync(testDir)
    .filter(file => file.endsWith('.test.ts'))
    .sort()
    .map(file => path.join(testDir, file));

let failed = 0;
for (const testFile of testFiles) {
    console.log(`==> ${path.basename(testFile)}`);
    const result = spawnSync(process.execPath, [tsxCli, testFile], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: false,
    });
    if (result.error) {
        console.error(`FAILED: ${path.basename(testFile)} (${result.error.message})`);
        failed = 1;
    } else if (result.status !== 0) {
        console.error(`FAILED: ${path.basename(testFile)} (exit ${result.status})`);
        failed = 1;
    }
}

if (failed) process.exitCode = 1;
