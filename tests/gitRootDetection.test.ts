import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function normalizeComparablePath(path: string): string {
  let normalized = path.trim().replace(/\0/g, '');
  if (process.platform !== 'win32') {
    return normalized.replace(/\/+$/, '') || '/';
  }

  normalized = normalized.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(normalized)) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (/^\\\\\?\\/i.test(normalized)) {
    normalized = normalized.slice(4);
  }

  if (!/^[A-Za-z]:\\$/.test(normalized)) {
    normalized = normalized.replace(/\\+$/, '');
  }
  return normalized.toLowerCase();
}

function resolveComparablePath(path: string): string {
  try {
    return normalizeComparablePath(realpathSync.native(path));
  } catch {
    return normalizeComparablePath(resolve(path));
  }
}

function inspectGitRoot(projectPath: string): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {
    fixture: projectPath,
    processPlatform: process.platform,
    exact: false,
  };

  try {
    const rawOutput = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const repoRoot = rawOutput.trim();
    diagnostics.repoRootRaw = JSON.stringify(rawOutput);
    diagnostics.repoRoot = repoRoot;
    diagnostics.resolveFixture = resolve(projectPath);
    diagnostics.resolveRepoRoot = resolve(repoRoot);
    try {
      diagnostics.realpathFixture = realpathSync(projectPath);
    } catch (error) {
      diagnostics.realpathFixture = `ERROR: ${String(error)}`;
    }
    try {
      diagnostics.realpathRepoRoot = realpathSync(repoRoot);
    } catch (error) {
      diagnostics.realpathRepoRoot = `ERROR: ${String(error)}`;
    }
    try {
      diagnostics.realpathNativeFixture = realpathSync.native(projectPath);
    } catch (error) {
      diagnostics.realpathNativeFixture = `ERROR: ${String(error)}`;
    }
    try {
      diagnostics.realpathNativeRepoRoot = realpathSync.native(repoRoot);
    } catch (error) {
      diagnostics.realpathNativeRepoRoot = `ERROR: ${String(error)}`;
    }
    diagnostics.requestedComparable = resolveComparablePath(projectPath);
    diagnostics.actualComparable = resolveComparablePath(repoRoot);
    diagnostics.exact = diagnostics.requestedComparable === diagnostics.actualComparable;
  } catch (error) {
    diagnostics.error = String(error);
  }

  return diagnostics;
}

function isExactGitRoot(projectPath: string): boolean {
  return inspectGitRoot(projectPath).exact === true;
}

const fixture = mkdtempSync(join(tmpdir(), 'project-manager-git-root-'));
try {
  execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
  const child = join(fixture, 'packages', 'child');
  mkdirSync(child, { recursive: true });

  const rootProbe = inspectGitRoot(fixture);
  if (!rootProbe.exact) {
    rootProbe.gitVersion = execFileSync('git', ['--version']).toString().trim();
    console.error(`[gitRootDetection] root probe failed:\n${JSON.stringify(rootProbe, null, 2)}`);
  }
  assert.equal(rootProbe.exact, true, '仓库根目录应识别为 Git 仓库');

  assert.equal(isExactGitRoot(child), false, '未初始化 Git 的子项目不应继承父仓库状态');

  if (process.platform === 'win32') {
    const comparable = resolveComparablePath(fixture);
    assert.equal(
      normalizeComparablePath(`\\\\?\\${fixture.replace(/\\/g, '/')}`),
      comparable,
      'Windows namespace path 应与普通路径视为同一目录',
    );
    assert.equal(
      normalizeComparablePath(fixture.replace(/\\/g, '/')),
      comparable,
      'Windows slash 形式应与反斜杠形式视为同一目录',
    );
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

const root = process.cwd();
const rustGit = readFileSync(resolve(root, 'src-tauri/src/git.rs'), 'utf8');
const utoolsPreload = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');

assert(/rev-parse", "--show-toplevel/.test(rustGit), 'Tauri Git 检测应读取仓库根目录');
assert(/requested_path == repo_root_path/.test(rustGit), 'Tauri Git 检测应比较请求目录与仓库根目录');
assert(/\['rev-parse', '--show-toplevel'\]/.test(utoolsPreload), '插件端 Git 检测应读取仓库根目录');

console.log('git root detection tests passed');
