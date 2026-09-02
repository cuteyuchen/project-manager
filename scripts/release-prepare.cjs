const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
    ROOT_DIR,
    assertReleaseVersion,
    tagForVersion,
    snapshotFiles,
    restoreFiles,
    updateCargoLockVersion,
    updateChangelogForRelease,
    updateVersionFiles,
    runChecked,
    runNpmScript,
    runGit,
    assertLocalReleaseContext,
    assertVersionConsistency,
    assertUnreleasedReady,
    assertTagAvailable,
} = require('./release-utils.cjs');

function parseArgs(argv) {
    let version = null;
    let dryRun = false;
    for (const arg of argv) {
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg.startsWith('--')) throw new Error(`Unknown release prepare argument: ${arg}`);
        if (version) throw new Error(`Only one release version is allowed: ${version}, ${arg}`);
        version = arg;
    }
    return { version, dryRun };
}

function releaseFiles() {
    return [
        'package.json',
        'package-lock.json',
        'src-tauri/tauri.conf.json',
        'src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock',
        'utools/plugin.json',
        'utools/preload.js',
        'ztools/plugin.json',
        'ztools/preload.js',
        'README.md',
        'CHANGELOG.md',
    ];
}

function rollbackRelease(rootDir, snapshot, originalHead, tag, commitCreated, tagCreated, gitRunner = runGit) {
    try {
        if (tagCreated) gitRunner(['tag', '--delete', tag], { cwd: rootDir, label: `delete local tag ${tag}` });
    } catch (error) {
        console.error(`Rollback warning: could not delete local tag ${tag}: ${error.message}`);
    }
    try {
        if (commitCreated) {
            gitRunner(['reset', '--mixed', originalHead], { cwd: rootDir, label: 'restore release HEAD' });
        } else {
            gitRunner(['reset', '--mixed'], { cwd: rootDir, label: 'unstage release files' });
        }
    } catch (error) {
        console.error(`Rollback warning: could not restore the Git index: ${error.message}`);
    }
    restoreFiles(rootDir, snapshot);
}

function prepareRelease({
    rootDir = ROOT_DIR,
    version,
    dryRun = false,
    runCheckedFn = runChecked,
    runNpmScriptFn = runNpmScript,
    runGitFn = runGit,
} = {}) {
    const normalizedVersion = assertReleaseVersion(version);
    const tag = tagForVersion(normalizedVersion);
    if (!dryRun) assertLocalReleaseContext(rootDir, normalizedVersion);
    assertVersionConsistency(rootDir);
    if (dryRun) assertTagAvailable(rootDir, normalizedVersion);

    const changelogContent = fs.readFileSync(
        path.join(rootDir, 'CHANGELOG.md'),
        'utf8',
    );
    assertUnreleasedReady(changelogContent);

    if (dryRun) {
        console.log(`\nDry run: would prepare v${normalizedVersion}.`);
        console.log(`  Would update: ${releaseFiles().join(', ')}`);
        console.log('  Would run: cargo check, release preflight, local commit and local tag.');
        console.log('  No files, commit, tag, push, or plugin publish will be created.');
        return { version: normalizedVersion, tag, dryRun: true };
    }

    const snapshot = snapshotFiles(rootDir);
    const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
    }).trim();
    let commitCreated = false;
    let tagCreated = false;

    try {
        console.log(`\nPreparing v${normalizedVersion}...`);
        updateVersionFiles(rootDir, normalizedVersion);
        updateCargoLockVersion(rootDir, normalizedVersion);
        updateChangelogForRelease(rootDir, normalizedVersion);

        runCheckedFn('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'], {
            cwd: rootDir,
            label: 'cargo check (update Cargo.lock)',
        });
        runNpmScriptFn('release:preflight', ['--tag', tag, '--ci'], {
            cwd: rootDir,
            label: 'release preflight',
        });

        runGitFn(['add', '--', ...releaseFiles()], { cwd: rootDir, label: 'stage release files' });
        runGitFn(['commit', '-m', `chore(release): ${tag}`], { cwd: rootDir, label: 'create release commit' });
        commitCreated = true;
        runGitFn(['tag', tag], { cwd: rootDir, label: `create local tag ${tag}` });
        tagCreated = true;

        console.log('\nPreparation complete.');
        console.log(`  Commit: ${tag}`);
        console.log(`  Tag: ${tag} (local only)`);
        console.log('  Run release:publish to publish.');
        return { version: normalizedVersion, tag, dryRun: false };
    } catch (error) {
        console.error(`\nRelease preparation failed: ${error.message}`);
        rollbackRelease(rootDir, snapshot, originalHead, tag, commitCreated, tagCreated, runGitFn);
        process.exitCode = 1;
        return null;
    }
}

function runPrepareCli(argv = process.argv.slice(2)) {
    try {
        const options = parseArgs(argv);
        if (!options.version) throw new Error('Usage: npm run release:prepare -- <version> [--dry-run]');
        return prepareRelease({ rootDir: ROOT_DIR, ...options });
    } catch (error) {
        console.error(`\nRelease preparation failed: ${error.message}`);
        process.exitCode = 1;
        return null;
    }
}

if (require.main === module) runPrepareCli();

module.exports = { parseArgs, releaseFiles, rollbackRelease, prepareRelease, runPrepareCli };
