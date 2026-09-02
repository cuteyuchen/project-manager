import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const {
  assertReleaseVersion,
  assertTagAvailable,
  assertVersionConsistency,
  readReadmeVersion,
  extractReleaseNotes,
  assertUnreleasedReady,
  snapshotFiles,
  assertLocalReleaseContext,
  remoteTagExists,
} = require('../scripts/release-utils.cjs') as {
  assertReleaseVersion: (version: string) => string;
  assertTagAvailable: (rootDir: string, version: string) => string;
  assertVersionConsistency: (rootDir?: string, expectedVersion?: string | null) => unknown;
  readReadmeVersion: (content: string) => string | null;
  extractReleaseNotes: (content: string, version: string) => string;
  assertUnreleasedReady: (content: string) => string;
  snapshotFiles: (rootDir: string, relativePaths: string[]) => Map<string, Buffer | null>;
  assertLocalReleaseContext: (rootDir: string, expectedVersion?: string | null) => {
    branch: string;
    head: string;
    originMain: string;
  };
  remoteTagExists: (rootDir: string, tag: string) => boolean;
};
const { rollbackRelease } = require('../scripts/release-prepare.cjs') as {
  rollbackRelease: (
    rootDir: string,
    snapshot: Map<string, Buffer | null>,
    originalHead: string,
    tag: string,
    commitCreated: boolean,
    tagCreated: boolean,
  ) => void;
};

assert.equal(assertReleaseVersion('1.7.0'), '1.7.0');
assert.throws(() => assertReleaseVersion('1.7'), /Invalid release version/);
assert.throws(() => assertReleaseVersion('v1.7.0'), /Invalid release version/);

const changelog = '# Changelog\n\n## Unreleased\n\n- Keep this content.\n\n## v1.7.0 - 2026-09-01\n\n- Release note.\n\n## v1.6.2\n\n- Older note.\n';
assert.match(extractReleaseNotes(changelog, '1.7.0'), /^## v1\.7\.0/m);
assert.equal(extractReleaseNotes(changelog, '9.9.9'), '');
assert.equal(extractReleaseNotes('# Changelog\n\n## v9.9.9\n\n## v1.6.2\n', '9.9.9'), '');
assert.equal(assertUnreleasedReady(changelog), '- Keep this content.');
assert.throws(() => assertUnreleasedReady('# Changelog\n\n## Unreleased\n\n## v1.0.0\n'), /no meaningful content/);
assert.throws(() => assertReleaseVersion('01.2.3'), /Invalid release version/);
assert.equal(readReadmeVersion('历史版本 v0.1.0\n\n当前版本：`v1.6.2`\n'), '1.6.2');
assert.equal(readReadmeVersion('当前版本：`v1.6.2`\n\n### v1.5.0'), '1.6.2');
assert.equal(readReadmeVersion('### v1.6.2\n'), null);

const root = process.cwd();
assertVersionConsistency(root, '1.6.2');

const mismatchRoot = mkdtempSync(join(tmpdir(), 'project-manager-version-'));
try {
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
    const target = join(mismatchRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(root, relativePath)));
  }
  const packagePath = join(mismatchRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string };
  packageJson.version = '9.9.9';
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  assert.throws(() => assertVersionConsistency(mismatchRoot), /inconsistent/);
  assert.throws(() => assertVersionConsistency(root, '1.7.0'), /inconsistent/);

  packageJson.version = '1.7';
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  assert.throws(() => assertVersionConsistency(mismatchRoot), /Invalid release version/);
} finally {
  rmSync(mismatchRoot, { recursive: true, force: true });
}

const taggedRoot = mkdtempSync(join(tmpdir(), 'project-manager-tag-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: taggedRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: taggedRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: taggedRoot });
  writeFileSync(join(taggedRoot, 'marker.txt'), 'release test\n');
  execFileSync('git', ['add', 'marker.txt'], { cwd: taggedRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: taggedRoot });
  execFileSync('git', ['tag', 'v1.7.0'], { cwd: taggedRoot });
  assert.throws(() => assertTagAvailable(taggedRoot, '1.7.0'), /already exists locally/);
} finally {
  rmSync(taggedRoot, { recursive: true, force: true });
}

const snapshot = snapshotFiles(root, ['package.json']);
assert(snapshot.get('package.json') instanceof Buffer);

const rollbackRoot = mkdtempSync(join(tmpdir(), 'project-manager-rollback-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: rollbackRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rollbackRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: rollbackRoot });
  writeFileSync(join(rollbackRoot, 'marker.txt'), 'before\n');
  execFileSync('git', ['add', 'marker.txt'], { cwd: rollbackRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: rollbackRoot });
  const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rollbackRoot, encoding: 'utf8' }).trim();
  const rollbackSnapshot = snapshotFiles(rollbackRoot, ['marker.txt']);
  writeFileSync(join(rollbackRoot, 'marker.txt'), 'after\n');
  execFileSync('git', ['add', 'marker.txt'], { cwd: rollbackRoot });
  rollbackRelease(rollbackRoot, rollbackSnapshot, originalHead, 'v9.9.9', false, false);
  assert.equal(readFileSync(join(rollbackRoot, 'marker.txt'), 'utf8'), 'before\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: rollbackRoot, encoding: 'utf8' }), '');
} finally {
  rmSync(rollbackRoot, { recursive: true, force: true });
}

const localContextRoot = mkdtempSync(join(tmpdir(), 'project-manager-local-context-'));
const bareRemoteRoot = mkdtempSync(join(tmpdir(), 'project-manager-local-remote-'));
try {
  execFileSync('git', ['init', '--bare', '-q', bareRemoteRoot]);
  execFileSync('git', ['init', '-q'], { cwd: localContextRoot, stdio: 'ignore' });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: localContextRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: localContextRoot });
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: localContextRoot });
  writeFileSync(join(localContextRoot, 'marker.txt'), 'context\n');
  execFileSync('git', ['add', 'marker.txt'], { cwd: localContextRoot });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: localContextRoot });
  execFileSync('git', ['remote', 'add', 'origin', bareRemoteRoot], { cwd: localContextRoot });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: localContextRoot });
  const context = assertLocalReleaseContext(localContextRoot);
  assert.equal(context.branch, 'main');
  assert.equal(context.head, context.originMain);
  assert.equal(remoteTagExists(localContextRoot, 'v1.7.0'), false);
  execFileSync('git', ['tag', 'v1.7.0'], { cwd: localContextRoot });
  execFileSync('git', ['push', '-q', 'origin', 'v1.7.0'], { cwd: localContextRoot });
  assert.equal(remoteTagExists(localContextRoot, 'v1.7.0'), true);
  writeFileSync(join(localContextRoot, 'marker.txt'), 'dirty\n');
  assert.throws(() => assertLocalReleaseContext(localContextRoot), /working tree must be clean/i);
} finally {
  rmSync(localContextRoot, { recursive: true, force: true });
  rmSync(bareRemoteRoot, { recursive: true, force: true });
}

console.log('releaseVersion tests passed');
