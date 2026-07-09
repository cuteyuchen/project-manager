import { applyGeneratedCommitMessage } from '../src/components/git/aiCommitMessageTarget';

/***********************测试辅助函数*********************/

function assertEq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

/***********************AI 提交信息写回目标项目*********************/

{
  const commitMessages: Record<string, string> = {
    projectB: 'chore: 保留当前选中项目的草稿',
  };

  const requestProjectId = 'projectA';
  const currentProjectIdAfterSwitch = 'projectB';
  const generatedMessage = 'fix(git): 修复 AI 提交信息串写';

  const applied = applyGeneratedCommitMessage(commitMessages, requestProjectId, generatedMessage);

  assertEq(applied, true, '生成结果应成功写入发起请求的项目');
  assertEq(commitMessages[requestProjectId], generatedMessage, '生成结果应写入发起请求时的项目');
  assertEq(
    commitMessages[currentProjectIdAfterSwitch],
    'chore: 保留当前选中项目的草稿',
    '生成结果不应覆盖等待期间切换到的项目'
  );
}

/***********************空提交信息不写入*********************/

{
  const commitMessages: Record<string, string> = {
    projectA: 'feat: 原草稿',
  };

  const applied = applyGeneratedCommitMessage(commitMessages, 'projectA', '');

  assertEq(applied, false, '空生成结果应被忽略');
  assertEq(commitMessages.projectA, 'feat: 原草稿', '空生成结果不应覆盖已有草稿');
}

console.log('aiCommitMessageTarget tests passed');
