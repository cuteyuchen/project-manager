import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function isExactGitRoot(projectPath: string): boolean {
  try {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const requested = realpathSync(projectPath);
    const actualRoot = realpathSync(repoRoot);
    return process.platform === 'win32'
      ? requested.toLowerCase() === actualRoot.toLowerCase()
      : requested === actualRoot;
  } catch {
    return false;
  }
}

const fixture = mkdtempSync(join(tmpdir(), 'project-manager-git-root-'));
try {
  execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
  const child = join(fixture, 'packages', 'child');
  mkdirSync(child, { recursive: true });

  assert.equal(isExactGitRoot(fixture), true, '仓库根目录应识别为 Git 仓库');
  assert.equal(isExactGitRoot(child), false, '未初始化 Git 的子项目不应继承父仓库状态');
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
