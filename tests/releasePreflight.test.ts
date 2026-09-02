import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { parseArgs: parsePreflightArgs } = require('../scripts/release-preflight.cjs') as {
  parseArgs: (argv: string[]) => { tag: string | null; ci: boolean; strictLocal: boolean };
};
const { prepareRelease } = require('../scripts/release-prepare.cjs') as {
  prepareRelease: (options: { rootDir: string; version: string; dryRun?: boolean }) => { dryRun: boolean; version: string; tag: string };
};
const { publishRelease } = require('../scripts/release-publish.cjs') as {
  publishRelease: (options: { rootDir: string; version: string; dryRun?: boolean }) => { dryRun: boolean; version: string; tag: string };
};

const publishSource = readFileSync(join(process.cwd(), 'scripts/release-publish.cjs'), 'utf8');
assert(
  publishSource.indexOf("label: 'push release commit and tag atomically'")
    < publishSource.indexOf("label: 'ZTools plugin publish'"),
  'external plugin publish must happen after the atomic commit/tag push',
);

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
assert(releaseWorkflow.includes("description: 'Existing vX.Y.Z tag to build and release'"));
assert(releaseWorkflow.includes('RELEASE_TAG'));
assert(releaseWorkflow.includes('releaseBody: ${{ needs.preflight.outputs.release_notes }}'));
assert(!releaseWorkflow.includes('## v1.6.2'));
assert.deepEqual(parsePreflightArgs(['--tag', 'v1.7.0', '--ci']), {
  tag: 'v1.7.0',
  ci: true,
  strictLocal: false,
});
assert.throws(() => parsePreflightArgs(['--tag']), /requires/);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'project-manager-prepare-'));
execFileSync('git', ['init', '-q'], { cwd: fixtureRoot, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixtureRoot });
execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixtureRoot });
for (const relativePath of [
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
]) {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(process.cwd(), relativePath), target);
}
writeFileSync(join(fixtureRoot, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Fixture release note.\n');
execFileSync('git', ['add', '.'], { cwd: fixtureRoot });
execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixtureRoot });

const before = readFileSync(join(fixtureRoot, 'CHANGELOG.md'));
const result = prepareRelease({ rootDir: fixtureRoot, version: '9.9.9', dryRun: true });
assert.deepEqual(result, { version: '9.9.9', tag: 'v9.9.9', dryRun: true });
assert.deepEqual(readFileSync(join(fixtureRoot, 'CHANGELOG.md')), before);
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: fixtureRoot, encoding: 'utf8' }), '');
assert.throws(() => prepareRelease({ rootDir: fixtureRoot, version: 'not-semver', dryRun: true }), /Invalid release version/);
assert.equal(statSync(fixtureRoot).isDirectory(), true);
rmSync(fixtureRoot, { recursive: true, force: true });

const publishRoot = mkdtempSync(join(tmpdir(), 'project-manager-publish-dry-run-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: publishRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: publishRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: publishRoot });
  for (const relativePath of [
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
  ]) {
    const target = join(publishRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(process.cwd(), relativePath), target);
  }
  execFileSync('git', ['add', '.'], { cwd: publishRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: publishRoot });
  const before = readFileSync(join(publishRoot, 'package.json'), 'utf8');
  const result = publishRelease({ rootDir: publishRoot, version: '9.9.9', dryRun: true });
  assert.deepEqual(result, { version: '9.9.9', tag: 'v9.9.9', dryRun: true });
  assert.equal(readFileSync(join(publishRoot, 'package.json'), 'utf8'), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: publishRoot, encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['tag', '--list', 'v9.9.9'], { cwd: publishRoot, encoding: 'utf8' }), '');
} finally {
  rmSync(publishRoot, { recursive: true, force: true });
}

const rollbackRoot = mkdtempSync(join(tmpdir(), 'project-manager-prepare-rollback-'));
const rollbackRemote = mkdtempSync(join(tmpdir(), 'project-manager-prepare-rollback-remote-'));
try {
  execFileSync('git', ['init', '--bare', '-q', rollbackRemote]);
  execFileSync('git', ['init', '-q'], { cwd: rollbackRoot, stdio: 'ignore' });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: rollbackRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rollbackRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rollbackRoot });

  const releaseFiles = [
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
  for (const relativePath of releaseFiles) {
    const target = join(rollbackRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(process.cwd(), relativePath), target);
  }

  execFileSync('git', ['add', '.'], { cwd: rollbackRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: rollbackRoot });
  execFileSync('git', ['remote', 'add', 'origin', rollbackRemote], { cwd: rollbackRoot });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: rollbackRoot });

  const before = new Map(releaseFiles.map(relativePath => [
    relativePath,
    readFileSync(join(rollbackRoot, relativePath)),
  ]));
  const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: rollbackRoot,
    encoding: 'utf8',
  }).trim();
  const previousExitCode = process.exitCode;
  const result = prepareRelease({
    rootDir: rollbackRoot,
    version: '9.9.9',
    runCheckedFn: () => {
      throw new Error('synthetic cargo check failure');
    },
  });
  process.exitCode = previousExitCode;

  assert.equal(result, null);
  for (const [relativePath, content] of before) {
    assert.deepEqual(readFileSync(join(rollbackRoot, relativePath)), content, `${relativePath} was not restored`);
  }
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: rollbackRoot, encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rollbackRoot, encoding: 'utf8' }).trim(), originalHead);
  assert.equal(execFileSync('git', ['tag', '--list', 'v9.9.9'], { cwd: rollbackRoot, encoding: 'utf8' }), '');
} finally {
  process.exitCode = undefined;
  rmSync(rollbackRoot, { recursive: true, force: true });
  rmSync(rollbackRemote, { recursive: true, force: true });
}

console.log('releasePreflight tests passed');
