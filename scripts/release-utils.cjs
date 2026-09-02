const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_TAG_PREFIX = 'v';

const VERSION_FILE_PATHS = [
    'package.json',
    'package-lock.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'utools/plugin.json',
    'utools/preload.js',
    'ztools/plugin.json',
    'ztools/preload.js',
    'README.md',
    'CHANGELOG.md',
];

function fail(message) {
    throw new Error(message);
}

function assertReleaseVersion(version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(version || ''))) {
        fail(`Invalid release version: ${version}. Expected x.y.z.`);
    }
    return String(version);
}

function versionFromTag(tag) {
    const value = String(tag || '').trim();
    if (!/^v?\d+\.\d+\.\d+$/.test(value)) {
        fail(`Invalid release tag: ${tag}. Expected vX.Y.Z.`);
    }
    return assertReleaseVersion(value.startsWith(RELEASE_TAG_PREFIX) ? value.slice(1) : value);
}

function tagForVersion(version) {
    return `${RELEASE_TAG_PREFIX}${assertReleaseVersion(version)}`;
}

function readText(rootDir, relativePath) {
    return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function writeTextIfChanged(rootDir, relativePath, content) {
    const filePath = path.join(rootDir, relativePath);
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (current === content) return false;
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
}

function readJson(rootDir, relativePath) {
    const filePath = path.join(rootDir, relativePath);
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        fail(`Failed to read ${relativePath}: ${error.message}`);
    }
}

function jsonText(value, indent) {
    return `${JSON.stringify(value, null, indent)}\n`;
}

function readCargoTomlVersion(content) {
    const match = content.match(/^\[package\][\s\S]*?^version\s*=\s*["']([^"']+)["']/m);
    return match ? match[1] : null;
}

function readCargoLockVersion(content) {
    const match = content.match(/\[\[package\]\]\s*\r?\nname\s*=\s*["']project-manager["']\s*\r?\nversion\s*=\s*["']([^"']+)["']/m);
    return match ? match[1] : null;
}

function readPreloadVersion(content) {
    const match = content.match(/getAppVersion\s*:\s*async\s*\(\s*\)\s*=>\s*\{\s*return\s+(["'])([^"']+)\1/m);
    return match ? match[2] : null;
}

function readReadmeVersion(content) {
    const match = content.match(/^当前版本：`v([^`]+)`\s*$/m);
    return match ? match[1] : null;
}

function readVersionSources(rootDir = ROOT_DIR) {
    const packageJson = readJson(rootDir, 'package.json');
    const packageLock = readJson(rootDir, 'package-lock.json');
    const tauriConfig = readJson(rootDir, 'src-tauri/tauri.conf.json');
    const utoolsPlugin = readJson(rootDir, 'utools/plugin.json');
    const ztoolsPlugin = readJson(rootDir, 'ztools/plugin.json');
    const cargoToml = readText(rootDir, 'src-tauri/Cargo.toml');
    const cargoLock = readText(rootDir, 'src-tauri/Cargo.lock');
    const utoolsPreload = readText(rootDir, 'utools/preload.js');
    const ztoolsPreload = readText(rootDir, 'ztools/preload.js');
    const readme = readText(rootDir, 'README.md');

    return [
        { name: 'package.json', value: packageJson.version },
        { name: 'package-lock.json', value: packageLock.version },
        { name: 'package-lock.json packages[\"\"].version', value: packageLock.packages?.['']?.version },
        { name: 'src-tauri/Cargo.toml', value: readCargoTomlVersion(cargoToml) },
        { name: 'src-tauri/Cargo.lock', value: readCargoLockVersion(cargoLock) },
        { name: 'src-tauri/tauri.conf.json', value: tauriConfig.version },
        { name: 'utools/plugin.json', value: utoolsPlugin.version },
        { name: 'utools/preload.js getAppVersion', value: readPreloadVersion(utoolsPreload) },
        { name: 'ztools/plugin.json', value: ztoolsPlugin.version },
        { name: 'ztools/preload.js getAppVersion', value: readPreloadVersion(ztoolsPreload) },
        { name: 'README.md 当前版本', value: readReadmeVersion(readme) },
    ];
}

function assertVersionConsistency(rootDir = ROOT_DIR, expectedVersion = null) {
    const sources = readVersionSources(rootDir);
    const missing = sources.filter(source => !source.value);
    if (missing.length) {
        fail(`Missing version source: ${missing.map(source => source.name).join(', ')}`);
    }

    const expected = assertReleaseVersion(expectedVersion || sources[0].value);
    const mismatches = sources.filter(source => String(source.value) !== expected);
    if (mismatches.length) {
        const details = sources.map(source => `${source.name}=${source.value}`).join(', ');
        fail(`Version sources are inconsistent; expected ${expected}. ${details}`);
    }
    return { version: expected, sources };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findHeadingEnd(content, start) {
    const nextHeading = /^##\s+/gm;
    nextHeading.lastIndex = start;
    const match = nextHeading.exec(content);
    return match ? match.index : content.length;
}

function meaningfulMarkdownContent(content) {
    return String(content)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^\s*#{1,6}\s+.*$/gm, '')
        .replace(/^\s*[-*_]\s*$/gm, '')
        .trim();
}

function releaseHeadingRegExp(version) {
    const normalizedVersion = assertReleaseVersion(version);
    return new RegExp(`^##\\s+v${escapeRegExp(normalizedVersion)}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm');
}

function hasReleaseSection(content, version) {
    return releaseHeadingRegExp(version).test(content);
}

function extractReleaseNotes(content, version) {
    const heading = releaseHeadingRegExp(version);
    const match = heading.exec(content);
    if (!match) return '';
    const section = content.slice(match.index, findHeadingEnd(content, match.index + match[0].length)).trim();
    return meaningfulMarkdownContent(section.slice(match[0].length)) ? section : '';
}

function extractUnreleasedContent(content) {
    const match = /^##\s+Unreleased\s*$/m.exec(content);
    if (!match) return '';
    const body = content.slice(match.index + match[0].length, findHeadingEnd(content, match.index + match[0].length));
    return body.trim();
}

function assertUnreleasedReady(content) {
    const body = extractUnreleasedContent(content);
    const meaningful = meaningfulMarkdownContent(body);
    if (!meaningful) fail('CHANGELOG.md has no meaningful content under ## Unreleased.');
    return body;
}

function updateJsonVersion(rootDir, relativePath, version, indent) {
    const value = readJson(rootDir, relativePath);
    value.version = version;
    return writeTextIfChanged(rootDir, relativePath, jsonText(value, indent));
}

function updatePackageLockVersion(rootDir, version) {
    const relativePath = 'package-lock.json';
    const value = readJson(rootDir, relativePath);
    if (!value.packages || !value.packages['']) {
        fail('Could not find the root package entry in package-lock.json.');
    }
    value.version = version;
    value.packages[''].version = version;
    return writeTextIfChanged(rootDir, relativePath, jsonText(value, 2));
}

function updateCargoTomlVersion(rootDir, version) {
    const relativePath = 'src-tauri/Cargo.toml';
    const content = readText(rootDir, relativePath);
    const updated = content.replace(
        /(^\[package\][\s\S]*?^version\s*=\s*["'])[^"']+(["'])/m,
        `$1${version}$2`,
    );
    if (updated === content) fail('Could not find [package] version in src-tauri/Cargo.toml.');
    return writeTextIfChanged(rootDir, relativePath, updated);
}

function updateCargoLockVersion(rootDir, version) {
    const relativePath = 'src-tauri/Cargo.lock';
    const content = readText(rootDir, relativePath);
    const updated = content.replace(
        /(\[\[package\]\]\s*\r?\nname\s*=\s*["']project-manager["']\s*\r?\nversion\s*=\s*["'])[^"']+(["'])/m,
        `$1${version}$2`,
    );
    if (updated === content) fail('Could not find project-manager package in src-tauri/Cargo.lock.');
    return writeTextIfChanged(rootDir, relativePath, updated);
}

function updatePreloadVersion(rootDir, relativePath, version) {
    const content = readText(rootDir, relativePath);
    const updated = content.replace(
        /(getAppVersion\s*:\s*async\s*\(\s*\)\s*=>\s*\{\s*return\s+(["']))[^"']+(["'])/m,
        `$1${version}$3`,
    );
    if (updated === content) fail(`Could not find getAppVersion in ${relativePath}.`);
    return writeTextIfChanged(rootDir, relativePath, updated);
}

function updateReadmeVersion(rootDir, version) {
    const relativePath = 'README.md';
    const content = readText(rootDir, relativePath);
    const updated = content.replace(/^(当前版本：`v)[^`]+(`)$/m, `$1${version}$2`);
    if (updated === content) fail('Could not find the current version line in README.md.');
    return writeTextIfChanged(rootDir, relativePath, updated);
}

function updateChangelogForRelease(rootDir, version, date = new Date().toISOString().slice(0, 10)) {
    const relativePath = 'CHANGELOG.md';
    const content = readText(rootDir, relativePath);
    const unreleased = assertUnreleasedReady(content);
    if (hasReleaseSection(content, version)) {
        fail(`CHANGELOG.md already contains a release section for v${version}.`);
    }

    const match = /^##\s+Unreleased\s*$/m.exec(content);
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findHeadingEnd(content, bodyStart);
    const replacement = `## Unreleased\n\n## v${version} - ${date}\n\n${unreleased}\n\n`;
    const updated = `${content.slice(0, match.index)}${replacement}${content.slice(bodyEnd).replace(/^\s+/, '')}`;
    writeTextIfChanged(rootDir, relativePath, updated);
    return updated;
}

function snapshotFiles(rootDir = ROOT_DIR, relativePaths = VERSION_FILE_PATHS) {
    return new Map(relativePaths.map(relativePath => {
        const filePath = path.join(rootDir, relativePath);
        return [relativePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null];
    }));
}

function restoreFiles(rootDir, snapshot) {
    for (const [relativePath, bytes] of snapshot) {
        const filePath = path.join(rootDir, relativePath);
        if (bytes === null) {
            if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
        } else {
            fs.writeFileSync(filePath, bytes);
        }
    }
}

function commandName(name) {
    if (process.platform === 'win32' && name === 'npm') return 'npm.cmd';
    return name;
}

function runChecked(command, args, options = {}) {
    const label = options.label || `${command} ${args.join(' ')}`;
    console.log(`  > ${command} ${args.join(' ')}`);
    let executable = commandName(command);
    let childArgs = args;
    let useShell = false;
    if (process.platform === 'win32' && command === 'npm' && process.env.npm_execpath) {
        // npm exposes its CLI entry point to lifecycle scripts. Calling it via
        // the current Node process avoids the .cmd shell shim and DEP0190.
        executable = process.execPath;
        childArgs = [process.env.npm_execpath, ...args];
    } else {
        useShell = process.platform === 'win32' && executable.endsWith('.cmd');
    }
    const result = spawnSync(executable, childArgs, {
        cwd: options.cwd || ROOT_DIR,
        stdio: 'inherit',
        // Windows exposes npm as a .cmd shim, which cannot be spawned with
        // shell:false. All npm arguments here are generated by this script.
        shell: useShell,
        env: options.env || process.env,
    });
    if (result.error) fail(`${label} failed to start: ${result.error.message}`);
    if (result.status !== 0) fail(`${label} failed with exit code ${result.status}.`);
    return result;
}

function runNpmScript(script, args = [], options = {}) {
    return runChecked('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], {
        ...options,
        label: options.label || `npm run ${script}`,
    });
}

function runGit(args, options = {}) {
    return runChecked('git', args, options);
}

function isWorkingTreeClean(rootDir = ROOT_DIR) {
    const result = spawnSync(commandName('git'), ['status', '--porcelain'], {
        cwd: rootDir,
        encoding: 'utf8',
        shell: false,
    });
    if (result.error || result.status !== 0) return false;
    return !result.stdout.trim();
}

function assertWorkingTreeClean(rootDir = ROOT_DIR) {
    if (!isWorkingTreeClean(rootDir)) fail('Working tree must be clean before a release operation.');
}

function readGitOutput(rootDir, args, label) {
    const result = spawnSync(commandName('git'), args, {
        cwd: rootDir,
        encoding: 'utf8',
        shell: false,
    });
    if (result.error) fail(`${label} failed to start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = String(result.stderr || '').trim();
        fail(`${label} failed${detail ? `: ${detail}` : ` with exit code ${result.status}`}.`);
    }
    return String(result.stdout || '').trim();
}

function assertMainBranch(rootDir = ROOT_DIR) {
    const branch = readGitOutput(rootDir, ['branch', '--show-current'], 'read current branch');
    if (branch !== 'main') {
        fail(`Local release operations must run from branch main (current: ${branch || 'detached HEAD'}).`);
    }
    return branch;
}

function assertLocalReleaseContext(rootDir = ROOT_DIR, expectedVersion = null) {
    assertWorkingTreeClean(rootDir);

    const branch = assertMainBranch(rootDir);

    const head = readGitOutput(rootDir, ['rev-parse', 'HEAD'], 'read local HEAD');
    const originMain = readGitOutput(rootDir, ['rev-parse', 'refs/remotes/origin/main'], 'read origin/main');
    if (head !== originMain) {
        fail(`Local HEAD is not synchronized with origin/main (HEAD ${head}, origin/main ${originMain}).`);
    }

    if (expectedVersion) assertTagAvailable(rootDir, expectedVersion);
    return { branch, head, originMain };
}

function localTagExists(rootDir, tag) {
    const result = spawnSync(commandName('git'), ['rev-parse', '--verify', `refs/tags/${tag}`], {
        cwd: rootDir,
        stdio: 'ignore',
        shell: false,
    });
    return result.status === 0;
}

function remoteTagExists(rootDir, tag, remote = 'origin') {
    const configuredRemote = spawnSync(commandName('git'), ['remote', 'get-url', remote], {
        cwd: rootDir,
        stdio: 'ignore',
        shell: false,
    });
    if (configuredRemote.error || configuredRemote.status !== 0) return false;

    const result = spawnSync(commandName('git'), ['ls-remote', '--exit-code', '--refs', remote, `refs/tags/${tag}`], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
    });
    if (result.error) fail(`Could not check remote tag ${tag}: ${result.error.message}`);
    if (result.status === 0) return true;

    // `ls-remote --exit-code` uses status 2 with empty stderr when the ref is
    // simply absent. Authentication, DNS, and transport failures must fail the
    // release gate instead of being mistaken for an available tag.
    if (result.status === 2 && !String(result.stderr || '').trim()) return false;
    const detail = String(result.stderr || '').trim();
    fail(`Could not check remote tag ${tag}${detail ? `: ${detail}` : ` (exit code ${result.status})`}.`);
}

function assertTagAvailable(rootDir, version) {
    const tag = tagForVersion(version);
    if (localTagExists(rootDir, tag)) fail(`Tag ${tag} already exists locally.`);
    if (remoteTagExists(rootDir, tag)) fail(`Tag ${tag} already exists on origin.`);
    return tag;
}

function assertSupportedNode() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major >= 22 || (major === 20 && minor >= 19))) {
        fail(`Unsupported Node.js ${process.version}; required Node 20.19+ or 22+.`);
    }
}

function updateVersionFiles(rootDir, version) {
    assertReleaseVersion(version);
    const changed = [];
    const mark = (relativePath, didChange) => { if (didChange) changed.push(relativePath); };
    mark('package.json', updateJsonVersion(rootDir, 'package.json', version, 2));
    mark('package-lock.json', updatePackageLockVersion(rootDir, version));
    mark('src-tauri/tauri.conf.json', updateJsonVersion(rootDir, 'src-tauri/tauri.conf.json', version, 2));
    mark('src-tauri/Cargo.toml', updateCargoTomlVersion(rootDir, version));
    mark('utools/plugin.json', updateJsonVersion(rootDir, 'utools/plugin.json', version, 4));
    mark('utools/preload.js', updatePreloadVersion(rootDir, 'utools/preload.js', version));
    mark('ztools/plugin.json', updateJsonVersion(rootDir, 'ztools/plugin.json', version, 4));
    mark('ztools/preload.js', updatePreloadVersion(rootDir, 'ztools/preload.js', version));
    mark('README.md', updateReadmeVersion(rootDir, version));
    return changed;
}

module.exports = {
    ROOT_DIR,
    VERSION_FILE_PATHS,
    assertReleaseVersion,
    versionFromTag,
    tagForVersion,
    readVersionSources,
    assertVersionConsistency,
    hasReleaseSection,
    extractReleaseNotes,
    extractUnreleasedContent,
    assertUnreleasedReady,
    updateCargoLockVersion,
    updatePackageLockVersion,
    updateChangelogForRelease,
    updateVersionFiles,
    snapshotFiles,
    restoreFiles,
    runChecked,
    runNpmScript,
    runGit,
    readGitOutput,
    isWorkingTreeClean,
    assertWorkingTreeClean,
    assertMainBranch,
    assertLocalReleaseContext,
    localTagExists,
    remoteTagExists,
    assertTagAvailable,
    assertSupportedNode,
    readReadmeVersion,
};
