const fs = require('node:fs');
const path = require('node:path');
const {
    ROOT_DIR,
    assertSupportedNode,
    assertVersionConsistency,
    extractReleaseNotes,
    versionFromTag,
    runNpmScript,
    runChecked,
    assertLocalReleaseContext,
} = require('./release-utils.cjs');

function parseArgs(argv) {
    const result = { tag: null, ci: false, strictLocal: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--tag') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error('--tag requires a vX.Y.Z value.');
            result.tag = value;
        } else if (arg.startsWith('--tag=')) {
            result.tag = arg.slice('--tag='.length);
        } else if (arg === '--ci') {
            result.ci = true;
        } else if (arg === '--strict-local') {
            result.strictLocal = true;
        } else if (arg) {
            throw new Error(`Unknown release preflight argument: ${arg}`);
        }
    }
    return result;
}

function checkChangelog(rootDir, version) {
    const content = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
    if (!extractReleaseNotes(content, version)) {
        throw new Error(`CHANGELOG.md is missing a non-empty release section for v${version}.`);
    }
}

function runPreflight({ rootDir = ROOT_DIR, tag = null, ci = false, strictLocal = false } = {}) {
    assertSupportedNode();
    const expectedVersion = tag ? versionFromTag(tag) : null;
    const consistency = assertVersionConsistency(rootDir, expectedVersion);
    checkChangelog(rootDir, consistency.version);

    if (strictLocal && ci) {
        throw new Error('--strict-local cannot be combined with --ci. Local branch and remote checks are not CI checks.');
    }
    if (strictLocal) assertLocalReleaseContext(rootDir, expectedVersion);

    runNpmScript('build', [], { cwd: rootDir, label: 'frontend build' });
    runNpmScript('build:utools', [], { cwd: rootDir, label: 'uTools plugin build' });
    runNpmScript('build:ztools', [], { cwd: rootDir, label: 'ZTools plugin build' });
    runNpmScript('test:ts', [], { cwd: rootDir, label: 'TypeScript tests' });
    runChecked('cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check'], {
        cwd: rootDir,
        label: 'cargo fmt --check',
    });
    runChecked('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml'], {
        cwd: rootDir,
        label: 'cargo test',
    });

    return consistency;
}

if (require.main === module) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = runPreflight({
            rootDir: ROOT_DIR,
            tag: options.tag,
            ci: options.ci,
            strictLocal: options.strictLocal,
        });
        console.log(`\nRelease preflight passed for v${result.version}.`);
    } catch (error) {
        console.error(`\nRelease preflight failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, checkChangelog, runPreflight };
