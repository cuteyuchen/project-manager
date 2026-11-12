import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

/***********************AI 生成状态必须由 store 持有*********************/
// 组件会被页签切换卸载；loading 放组件里就会「切走再回来变成可点击」，
// 还能再发一次请求。这里锁住状态归属，避免以后又被改回局部 ref。

const root = process.cwd();
const gitStore = readFileSync(resolve(root, 'src/stores/git.ts'), 'utf8');
const commitArea = readFileSync(resolve(root, 'src/components/git/GitCommitArea.vue'), 'utf8');

assert(
  /const aiCommitGenerating = ref<Record<string, boolean>>\(\{\}\)/.test(gitStore),
  'AI 生成状态应按项目分桶保存在 git store',
);
assert(
  gitStore.includes('aiCommitControllers'),
  '取消令牌应保存在 git store，组件卸载不会丢',
);
assert(
  /aiCommitGenerating\.value\[projectId\] = true/.test(gitStore),
  '生成开始时应在第一个 await 之前同步置位，拦住重复点击',
);
assert(
  /delete aiCommitGenerating\.value\[projectId\]/.test(gitStore),
  '生成结束（成功/失败/取消）必须清理状态',
);
assert(
  gitStore.includes("throw new Error('ai_busy')"),
  '同一项目并发调用应被拒绝',
);
assert(
  gitStore.includes("throw new Error('ai_cancelled')"),
  '取消应统一成 ai_cancelled 错误码，调用方不用区分各渠道 AbortError',
);
assert(
  /signal: controller\.signal/.test(gitStore),
  '底层请求必须接收 store 持有的 AbortSignal',
);
assert(
  /function cancelAiCommitMessage\(projectId: string\)/.test(gitStore),
  'store 应暴露按项目取消的入口',
);
assert(
  /function isAiCommitMessageGenerating\(projectId: string\)/.test(gitStore),
  'store 应暴露按项目读取生成状态的方法',
);

/***********************组件只做展示与调用*********************/
assert(
  commitArea.includes('gitStore.isAiCommitMessageGenerating(props.project.id)'),
  '组件应从 store 读取生成状态，而不是维护副本',
);
assert(
  commitArea.includes('gitStore.cancelAiCommitMessage(props.project.id)'),
  '取消按钮应调用 store 的取消入口',
);
assert(
  !/const aiGenerating = (ref|shallowRef)\(/.test(commitArea),
  '组件不应再持有自己的 aiGenerating 状态',
);
assert(
  !/let aiAbortController/.test(commitArea),
  '组件不应再持有自己的 AbortController',
);

console.log('aiCommitGeneratingState tests passed');
