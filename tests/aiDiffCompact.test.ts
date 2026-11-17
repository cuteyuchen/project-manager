import assert from 'node:assert/strict';
import {
  compactDiffForAi,
  isContextOverflowError,
  AI_DIFF_TOTAL_BUDGET,
  AI_DIFF_PER_FILE_BUDGET,
} from '../src/utils/aiDiff.ts';

/***********************构造测试用 diff*********************/

function textSection(path: string, addedLines: number, lineLength = 40): string {
  const body = Array.from({ length: addedLines }, (_, i) => `+line ${i} ${'x'.repeat(lineLength)}`).join('\n');
  return `diff --git a/${path} b/${path}\nindex 1234567..89abcde 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${addedLines} @@\n${body}`;
}

function binarySection(path: string): string {
  return `diff --git a/${path} b/${path}\nindex aaa1111..bbb2222 100644\nBinary files a/${path} and b/${path} differ`;
}

/***********************小 diff：完整保留*********************/

{
  const raw = textSection('src/a.ts', 3);
  const result = compactDiffForAi(raw);
  assert(result.includes('Changed files (1):'), '应带文件清单');
  assert(result.includes('- src/a.ts (+3/-0)'), '清单应含增删行数');
  assert(result.includes('+line 2'), '小 diff 的 patch 应完整保留');
  assert(!result.includes('[Note:'), '未截断时不应出现截断说明');
  assert(!result.includes('truncated'), '未截断时不应出现截断标记');
}

// 空输入返回空串（调用方据此抛 no_staged）
assert.equal(compactDiffForAi(''), '');
assert.equal(compactDiffForAi('   \n  '), '');

/***********************大文件：单文件预算截断*********************/

{
  const raw = textSection('data/big.json', 2000);
  const result = compactDiffForAi(raw, { perFileBudget: 500, totalBudget: 10_000 });
  assert(result.includes('- data/big.json (+2000/-0)'), '清单应反映真实改动规模');
  assert(result.includes('diff truncated: this file has +2000/-0 lines in total'), '截断应标注该文件总行数');
  assert(result.includes('[Note:'), '截断后应提示模型依据清单补全');
  // patch 正文（去掉清单与说明）应被压在预算附近
  const patchStart = result.indexOf('diff --git');
  const patchEnd = result.indexOf('... [diff truncated');
  assert(patchStart >= 0 && patchEnd > patchStart, '应保留 patch 开头');
  assert(patchEnd - patchStart <= 500 + 1, '单文件 patch 不应超过预算');
}

/***********************多文件：总预算收敛*********************/

{
  const raw = Array.from({ length: 50 }, (_, i) => textSection(`src/file${i}.ts`, 100)).join('\n');
  const result = compactDiffForAi(raw, { totalBudget: 2000, perFileBudget: 500 });
  // 清单必须完整覆盖 50 个文件
  for (let i = 0; i < 50; i++) {
    assert(result.includes(`- src/file${i}.ts (+100/-0)`), `文件 ${i} 应出现在清单里`);
  }
  const patchCount = (result.match(/^diff --git /gm) || []).length;
  assert(patchCount < 50, '总预算放不下时应有文件被省略 patch');
  assert(patchCount >= 1, '至少应保留一个文件的 patch');
  assert(result.includes('[Note:'), '省略后应提示模型');
  // 输出整体受控：预算 + 清单 + 标记，远小于原始 diff
  assert(result.length < raw.length / 10, '压缩后应远小于原始 diff');
}

// 默认预算下，超大 diff 的输出也有上限
{
  const raw = Array.from({ length: 300 }, (_, i) => textSection(`pkg/mod${i}.js`, 500)).join('\n');
  const result = compactDiffForAi(raw);
  assert(result.length <= AI_DIFF_TOTAL_BUDGET + 300 * 60 + 2000, '默认预算下输出应受控');
  assert(result.includes('... and 200 more files'), '清单超过 100 条应折叠');
}

/***********************二进制文件：只留清单*********************/

{
  const raw = `${textSection('src/a.ts', 2)}\n${binarySection('assets/logo.png')}`;
  const result = compactDiffForAi(raw);
  assert(result.includes('- assets/logo.png (binary)'), '二进制文件应在清单中标注');
  assert(!result.includes('Binary files'), '不应把二进制 diff 内容发给模型');
  assert(result.includes('+line 1'), '同批次的文本文件 patch 应保留');
}

// GIT binary patch 形式同样识别
{
  const raw = `diff --git a/img.bin b/img.bin\nindex aaa..bbb 100644\nGIT binary patch\nliteral 1024\nzcmV?w0000000000`;
  const result = compactDiffForAi(raw);
  assert(result.includes('- img.bin (binary)'), 'GIT binary patch 应识别为二进制');
  assert(!result.includes('zcmV'), '二进制补丁内容不应保留');
}

// 纯二进制改动：只有清单也能生成提交信息
{
  const result = compactDiffForAi(binarySection('a.png'));
  assert(result.includes('Changed files (1):'), '纯二进制也应有清单');
  assert(!result.includes('diff --git'), '纯二进制不需要 patch 正文');
}

/***********************路径提取：新增 / 删除 / 重命名*********************/

{
  const deleted = `diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line1\n-line2`;
  const result = compactDiffForAi(deleted);
  assert(result.includes('- old.ts (+0/-2)'), '删除文件应取 --- 侧路径并统计删除行');
}

{
  const renamed = `diff --git a/old-name.ts b/new-name.ts\nsimilarity index 90%\nrename from old-name.ts\nrename to new-name.ts\nindex 1234567..89abcde 100644\n--- a/old-name.ts\n+++ b/new-name.ts\n@@ -1 +1 @@\n-old\n+new`;
  const result = compactDiffForAi(renamed);
  assert(result.includes('- new-name.ts (+1/-1)'), '重命名应取新路径');
}

/***********************降级预算*********************/

{
  const raw = Array.from({ length: 30 }, (_, i) => textSection(`src/f${i}.ts`, 200)).join('\n');
  const normal = compactDiffForAi(raw);
  const fallback = compactDiffForAi(raw, { totalBudget: 4000, perFileBudget: 800 });
  assert(fallback.length < normal.length, '降级预算应产生更小的输出');
  assert(fallback.length <= 4000 + 30 * 60 + 1000, '降级输出应受控');
  assert(normal.length <= AI_DIFF_TOTAL_BUDGET + 30 * 60 + 1000, '默认输出应受控');
  assert(AI_DIFF_PER_FILE_BUDGET < AI_DIFF_TOTAL_BUDGET, '单文件预算应小于总预算');
}

/***********************上下文溢出错误识别*********************/

assert(
  isContextOverflowError(new Error("AI API request failed (400 Bad Request): This model's maximum context length is 8192 tokens. However, your messages resulted in 20000 tokens.")),
  'OpenAI 风格的上下文溢出应命中',
);
assert(isContextOverflowError(new Error('input too long for model')), 'input too long 应命中');
assert(isContextOverflowError(new Error('Please reduce the length of the messages')), 'reduce the length 应命中');
assert(isContextOverflowError(new Error('request exceeds the model context window')), 'context window 应命中');
assert(isContextOverflowError('prompt is too long'), '字符串错误也应支持');
assert(!isContextOverflowError(new Error('AI API request failed (401 Unauthorized): invalid api key')), '鉴权错误不应命中');
assert(!isContextOverflowError(new Error('fetch timeout')), '网络错误不应命中');

console.log('aiDiffCompact.test.ts passed');