import assert from 'node:assert/strict';
import { buildAiAttempts, isRetriableAiError } from '../src/utils/aiFallback.ts';
import { MAX_AI_FALLBACK_SLOTS, type Settings } from '../src/types.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/***********************测试用配置*********************/

function settings(overrides: Partial<Settings>): Settings {
  return {
    editorPath: 'code',
    defaultTerminal: 'cmd',
    locale: 'zh',
    themeMode: 'auto',
    autoUpdate: true,
    ...overrides,
  } as Settings;
}

const service = (baseUrl: string, apiKey: string, model: string) => ({
  apiType: 'chat_completions' as const,
  baseUrl,
  apiKey,
  model,
});

/***********************模式 A：单渠道多模型*********************/
// 一套 baseUrl/apiKey，依次换模型

{
  const attempts = buildAiAttempts(settings({
    gitAiFallbackMode: 'single_channel',
    gitAiSingleChannel: {
      service: service('https://api.openai.com/v1', 'sk-a', 'gpt-4o-mini'),
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    },
  }));

  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(a => a.model), ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'], '应按配置顺序回退');
  assert(attempts.every(a => a.apiKey === 'sk-a'), '单渠道模式下所有尝试共用同一把 key');
  assert(attempts.every(a => a.baseUrl === 'https://api.openai.com/v1'), '共用同一个 baseUrl');
  assert(attempts[0].label.includes('api.openai.com'), '标签应含渠道信息，便于回退时告知用户');
  assert(attempts[0].label.includes('gpt-4o-mini'), '标签应含模型名');
}

// 空模型、超出上限都要被处理掉
{
  const attempts = buildAiAttempts(settings({
    gitAiFallbackMode: 'single_channel',
    gitAiSingleChannel: {
      service: service('https://api.openai.com/v1', 'sk-a', 'm1'),
      models: ['m1', '', '  ', 'm2', 'm3', 'm4'],
    },
  }));
  assert.equal(attempts.length, MAX_AI_FALLBACK_SLOTS, '应截断到上限');
  assert.deepEqual(attempts.map(a => a.model), ['m1', 'm2', 'm3'], '空模型应被跳过');
}

// 缺 baseUrl / apiKey 就是「没配好」，返回空列表
assert.equal(
  buildAiAttempts(settings({
    gitAiFallbackMode: 'single_channel',
    gitAiSingleChannel: { service: service('', 'sk-a', 'm1'), models: ['m1'] },
  })).length,
  0,
  '缺 baseUrl 应视为未配置',
);
assert.equal(
  buildAiAttempts(settings({
    gitAiFallbackMode: 'single_channel',
    gitAiSingleChannel: { service: service('https://x.com', '', 'm1'), models: ['m1'] },
  })).length,
  0,
  '缺 apiKey 应视为未配置',
);

/***********************模式 B：多渠道多模型*********************/
// 最多 3 套各自独立的 baseUrl/apiKey/model

{
  const attempts = buildAiAttempts(settings({
    gitAiFallbackMode: 'multi_channel',
    gitAiChannels: [
      { ...service('https://api.openai.com/v1', 'sk-a', 'gpt-4o-mini'), id: '1' },
      { ...service('https://api.deepseek.com', 'sk-b', 'deepseek-chat'), id: '2' },
      { ...service('https://relay.example.com', 'sk-c', 'qwen-max'), id: '3' },
    ],
  }));

  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(a => a.apiKey), ['sk-a', 'sk-b', 'sk-c'], '每个渠道用自己的 key');
  assert.deepEqual(
    attempts.map(a => a.model),
    ['gpt-4o-mini', 'deepseek-chat', 'qwen-max'],
    '每个渠道用自己的模型',
  );
}

// 关掉的槽位跳过但配置保留
{
  const attempts = buildAiAttempts(settings({
    gitAiFallbackMode: 'multi_channel',
    gitAiChannels: [
      { ...service('https://a.com', 'sk-a', 'm1'), id: '1', enabled: false },
      { ...service('https://b.com', 'sk-b', 'm2'), id: '2', enabled: true },
    ],
  }));
  assert.equal(attempts.length, 1, '停用的渠道应被跳过');
  assert.equal(attempts[0].apiKey, 'sk-b');
}

// 配置不全的渠道跳过
{
  const attempts = buildAiAttempts(settings({
    gitAiFallbackMode: 'multi_channel',
    gitAiChannels: [
      { ...service('https://a.com', 'sk-a', ''), id: '1' },
      { ...service('https://b.com', 'sk-b', 'm2'), id: '2' },
    ],
  }));
  assert.equal(attempts.length, 1, '缺模型的渠道应被跳过');
}

/***********************两种模式互斥*********************/
// 「只能选一种模式」：选了多渠道就不该把单渠道的模型也算进来

{
  const both = settings({
    gitAiFallbackMode: 'multi_channel',
    gitAiSingleChannel: {
      service: service('https://api.openai.com/v1', 'sk-a', 'm1'),
      models: ['m1', 'm2', 'm3'],
    },
    gitAiChannels: [{ ...service('https://b.com', 'sk-b', 'only'), id: '1' }],
  });
  const attempts = buildAiAttempts(both);
  assert.equal(attempts.length, 1, '两种模式不叠加');
  assert.equal(attempts[0].model, 'only');

  const asSingle = buildAiAttempts({ ...both, gitAiFallbackMode: 'single_channel' });
  assert.equal(asSingle.length, 3, '切回单渠道模式应用它自己的模型列表');
}

// 缺省模式为单渠道
{
  const attempts = buildAiAttempts(settings({
    gitAiSingleChannel: {
      service: service('https://api.openai.com/v1', 'sk-a', 'm1'),
      models: ['m1'],
    },
  }));
  assert.equal(attempts.length, 1, '未指定模式时应按单渠道处理');
}

/***********************错误分类*********************/
// 可回退的：换个槽位有可能成功

assert.equal(isRetriableAiError(new Error('AI API request failed (429 Too Many Requests)')), true, '限流应回退');
assert.equal(isRetriableAiError(new Error('AI API request failed (500 Internal Server Error)')), true, '5xx 应回退');
assert.equal(isRetriableAiError(new Error('AI API request failed (503 Service Unavailable)')), true, '5xx 应回退');
assert.equal(isRetriableAiError(new Error('Failed to fetch')), true, '网络失败应回退');
assert.equal(isRetriableAiError(new Error('AI API returned empty content.')), true, '返回空内容应回退');
// 404 通常是「模型不存在」，换下一个模型正是要做的事
assert.equal(isRetriableAiError(new Error('AI API request failed (404 Not Found)')), true, '模型不存在应换模型');

// 不可回退的：配置/权限问题，换模型也是同一把 key
assert.equal(isRetriableAiError(new Error('AI API request failed (401 Unauthorized)')), false, 'key 无效不该白等三轮');
assert.equal(isRetriableAiError(new Error('AI API request failed (403 Forbidden)')), false, '无权限不该回退');
assert.equal(isRetriableAiError(new Error('AI API request failed (400 Bad Request)')), false, '请求格式错误不该回退');

/***********************旧版兼容配置回写*********************/

const settingsView = readFileSync(resolve(process.cwd(), 'src/views/Settings.vue'), 'utf8');
assert(
  /gitAiPrimaryService: activePrimary/.test(settingsView)
  && /gitAiBaseUrl: activePrimary\.baseUrl/.test(settingsView)
  && /gitAiModel: activePrimary\.model/.test(settingsView),
  '保存多槽位配置时应把当前模式的第一个尝试回写到旧版单服务字段',
);

console.log('aiFallback tests passed');
