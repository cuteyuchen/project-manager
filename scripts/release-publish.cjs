const {
    ROOT_DIR,
    assertReleaseVersion,
    tagForVersion,
    assertVersionConsistency,
    assertWorkingTreeClean,
    assertTagAvailable,
    localTagExists,
    remoteTagExists,
    assertMainBranch,
    readGitOutput,
    runGit,
    runNpmScript,
} = require('./release-utils.cjs');

function parseArgs(argv) {
    let version = null;
    let dryRun = false;
    let skipPlugins = false;
    for (const arg of argv) {
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg === '--skip-plugins') {
            skipPlugins = true;
            continue;
        }
        if (arg.startsWith('--')) throw new Error(`Unknown release publish argument: ${arg}`);
        if (version) throw new Error(`Only one release version is allowed: ${version}, ${arg}`);
        version = arg;
    }
    return { version, dryRun, skipPlugins };
}

function assertPreparedRelease(rootDir, version) {
    const normalizedVersion = assertReleaseVersion(version);
    const tag = tagForVersion(normalizedVersion);
    assertWorkingTreeClean(rootDir);
    assertMainBranch(rootDir);
    const consistency = assertVersionConsistency(rootDir, normalizedVersion);
    if (!localTagExists(rootDir, tag)) {
        throw new Error(`Prepared tag ${tag} does not exist locally. Run release:prepare first.`);
    }

    const head = readGitOutput(rootDir, ['rev-parse', 'HEAD'], 'read prepared HEAD');
    const tagHead = readGitOutput(rootDir, ['rev-list', '-n', '1', tag], `read ${tag} target`);
    if (head !== tagHead) throw new Error(`${tag} does not point to HEAD.`);
    return { version: normalizedVersion, tag, consistency };
}

function publishRelease({ rootDir = ROOT_DIR, version, dryRun = false, skipPlugins = false } = {}) {
    const normalizedVersion = assertReleaseVersion(version);
    const tag = tagForVersion(normalizedVersion);

    if (dryRun) {
        assertVersionConsistency(rootDir);
        assertTagAvailable(rootDir, normalizedVersion);
        console.log(`\nDry run: would publish v${normalizedVersion}.`);
        console.log('  No prepared commit is required for dry-run.');
        console.log('  No push, tag creation, GitHub release, or plugin publish will run.');
        return { version: normalizedVersion, tag, dryRun: true };
    }

    const prepared = assertPreparedRelease(rootDir, normalizedVersion);
    if (remoteTagExists(rootDir, prepared.tag)) {
        throw new Error(`Tag ${prepared.tag} already exists on origin.`);
    }

    // Re-run the complete gate before the atomic push. This is intentionally the
    // final local verification point before the remote can see the release tag.
    runNpmScript('release:preflight', ['--tag', prepared.tag, '--ci'], {
        cwd: rootDir,
        label: 'release preflight before publish',
    });

    // release:preflight has already built both plugins. Keep all local gates
    // before the remote side effect, then publish external plugins afterwards.
    runGit(['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${prepared.tag}`], {
        cwd: rootDir,
        label: 'push release commit and tag atomically',
    });

    if (!skipPlugins) {
        runNpmScript('publish:ztools', [], { cwd: rootDir, label: 'ZTools plugin publish' });
    }

    console.log(`\nRelease publish complete for ${prepared.tag}.`);
    console.log('GitHub Actions will create the signed GitHub Release from this tag.');
    if (skipPlugins) console.log('Plugin publish was explicitly skipped.');
    return prepared;
}

function runPublishCli(argv = process.argv.slice(2)) {
    try {
        const options = parseArgs(argv);
        if (!options.version) throw new Error('Usage: npm run release:publish -- <version> [--dry-run] [--skip-plugins]');
        return publishRelease({ rootDir: ROOT_DIR, ...options });
    } catch (error) {
        console.error(`\nRelease publish failed: ${error.message}`);
        process.exitCode = 1;
        return null;
    }
}

if (require.main === module) runPublishCli();

module.exports = { parseArgs, assertPreparedRelease, publishRelease, runPublishCli };
