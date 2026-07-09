import {
  createBranchGroups,
  getRemoteCheckoutName,
  isBranchActionDisabled,
} from '../src/components/git/gitBranchModel.ts';
import type { GitBranch } from '../src/types';

/***********************测试辅助函数*********************/

function assertEq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

/***********************远程分支检出名称*********************/

{
  assertEq(getRemoteCheckoutName('origin/feature/git-panel'), 'feature/git-panel', '远程分支应去掉远程仓库前缀');
  assertEq(getRemoteCheckoutName('upstream/main'), 'main', '任意远程名称都应去掉首段前缀');
  assertEq(getRemoteCheckoutName('main'), 'main', '非远程格式应保持原名称');
}

/***********************分支分组与排序*********************/

{
  const branches: GitBranch[] = [
    { name: 'origin/main', is_remote: true, is_current: false, ahead: 0, behind: 0 },
    { name: 'feature/a', is_remote: false, is_current: false, ahead: 2, behind: 0 },
    { name: 'main', is_remote: false, is_current: true, ahead: 0, behind: 1, upstream: 'origin/main' },
    { name: 'origin/feature/a', is_remote: true, is_current: false, ahead: 0, behind: 0 },
  ];

  const groups = createBranchGroups(branches, '');

  assertEq(groups.current?.name, 'main', '当前分支应单独置顶');
  assertEq(groups.locals.map(branch => branch.name).join(','), 'feature/a', '本地分支列表不应重复包含当前分支');
  assertEq(groups.remotes.map(branch => branch.name).join(','), 'origin/feature/a,origin/main', '远程分支应按名称排序');
}

/***********************分支操作禁用规则*********************/

{
  const current: GitBranch = { name: 'main', is_remote: false, is_current: true, ahead: 0, behind: 0 };
  const local: GitBranch = { name: 'dev', is_remote: false, is_current: false, ahead: 0, behind: 0 };
  const remote: GitBranch = { name: 'origin/dev', is_remote: true, is_current: false, ahead: 0, behind: 0 };

  assertEq(isBranchActionDisabled(current, 'switch'), true, '当前分支不能再次切换');
  assertEq(isBranchActionDisabled(current, 'delete'), true, '当前分支不能删除');
  assertEq(isBranchActionDisabled(remote, 'delete'), true, '远程分支不能直接删除');
  assertEq(isBranchActionDisabled(remote, 'rename'), true, '远程分支不能重命名');
  assertEq(isBranchActionDisabled(local, 'rename'), false, '普通本地分支允许重命名');
}

console.log('gitBranchModel tests passed');
