import assert from 'node:assert/strict';
import {
  installGlobalErrorCapture,
  isResizeObserverDeliveryError,
} from '../src/utils/globalErrorCapture.ts';
import { getLatestCapturedError } from '../src/utils/errorDetails.ts';

/***********************分类器纯逻辑*********************/
const deliveryMessage = 'ResizeObserver loop completed with undelivered notifications.';
const limitMessage = 'ResizeObserver loop limit exceeded';

assert.equal(isResizeObserverDeliveryError(deliveryMessage, 'window.error'), true);
assert.equal(isResizeObserverDeliveryError(new Error(deliveryMessage), 'window.error'), true);
assert.equal(isResizeObserverDeliveryError(limitMessage, 'window.error'), true);
assert.equal(isResizeObserverDeliveryError(new Error(limitMessage), 'window.error'), true);
assert.equal(
  isResizeObserverDeliveryError('ResizeObserver loop completed with undelivered notifications', 'window.error'),
  true,
);

// 其它来源不静默（Vue / unhandledrejection 仍应上报）
assert.equal(isResizeObserverDeliveryError(deliveryMessage, 'vue'), false);
assert.equal(isResizeObserverDeliveryError(deliveryMessage, 'unhandledrejection'), false);

// 名字相似但不是标准 notification 的错误不能被吞
for (const message of [
  'ResizeObserver failed to initialize',
  'ResizeObserver callback crashed',
  'My ResizeObserver loop problem',
  'TypeError: Cannot read properties of undefined',
]) {
  assert.equal(isResizeObserverDeliveryError(message, 'window.error'), false, message);
}

/***********************捕获链路（mock window）*********************/
type Listener = (event: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

(globalThis as unknown as { window: unknown }).window = {
  addEventListener(type: string, fn: Listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  },
  removeEventListener(type: string, fn: Listener) {
    listeners.get(type)?.delete(fn);
  },
};

function dispatch(type: string, event: unknown): void {
  for (const fn of listeners.get(type) ?? []) fn(event);
}

function installCollector() {
  const reported: Array<{ error: unknown; source: string }> = [];
  const controller = installGlobalErrorCapture((error, source) => {
    reported.push({ error, source });
  });
  return { reported, controller };
}

/***********************RO delivery 不上报、不覆盖 latest、不污染限流*********************/
{
  const { reported, controller } = installCollector();
  const sentinel = new Error('sentinel real error');
  controller.capture(sentinel, 'window.error');
  const latestAfterReal = getLatestCapturedError();
  assert.equal(reported.length, 1);

  // event.error 形式
  dispatch('error', { error: new Error(deliveryMessage), message: deliveryMessage });
  // event.message 形式（error 为空）
  dispatch('error', { error: null, message: deliveryMessage });
  // Firefox 文案
  dispatch('error', { error: new Error(limitMessage), message: limitMessage });
  dispatch('error', { error: undefined, message: limitMessage });

  assert.equal(reported.length, 1, 'RO delivery 不应触发用户上报');
  assert.deepEqual(getLatestCapturedError(), latestAfterReal, 'RO delivery 不应覆盖 latestCapturedError');

  // RO 未占限流额度：真实错误仍可继续上报
  const realError2 = new Error('second real error');
  controller.capture(realError2, 'window.error');
  assert.equal(reported.length, 2);
  assert.equal(getLatestCapturedError()?.error, realError2);
  controller.stop();
}

/***********************RO 不污染 rate limiter（独立实例、连续真实错误可满额）*********************/
{
  const { reported, controller } = installCollector();
  for (let i = 0; i < 8; i += 1) {
    dispatch('error', { error: new Error(deliveryMessage), message: deliveryMessage });
    dispatch('error', { error: null, message: limitMessage });
  }
  assert.equal(reported.length, 0);

  // maxEvents=3：若 RO 占用额度，这三条不会全部成功
  controller.capture(new Error('real-1'), 'window.error');
  controller.capture(new Error('real-2'), 'window.error');
  controller.capture(new Error('real-3'), 'window.error');
  assert.equal(reported.length, 3, 'RO delivery 不应污染 error rate limiter');
  controller.stop();
}

/***********************普通 window.error 仍然报告*********************/
{
  const { reported, controller } = installCollector();
  const typeError = new TypeError('Cannot read properties of undefined');
  controller.capture(typeError, 'window.error');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].error, typeError);
  assert.equal(reported[0].source, 'window.error');
  assert.equal(getLatestCapturedError()?.error, typeError);
  controller.stop();
}

/***********************名字相似的 ResizeObserver 错误不能吞*********************/
{
  const { reported, controller } = installCollector();
  for (const message of [
    'ResizeObserver failed to initialize',
    'ResizeObserver callback crashed',
    'My ResizeObserver loop problem',
  ]) {
    controller.capture(new Error(message), 'window.error');
  }
  assert.equal(reported.length, 3, '业务向 ResizeObserver 异常必须照常上报');
  controller.stop();
}

/***********************Vue / unhandledrejection 不回归*********************/
{
  const { reported, controller } = installCollector();
  controller.capture(new Error('vue render failed'), 'vue');
  controller.capture(new Error('unhandled rejection'), 'unhandledrejection');
  assert.equal(reported.length, 2);
  assert.equal(reported[0].source, 'vue');
  assert.equal(reported[1].source, 'unhandledrejection');

  // RO 文案经 vue / unhandledrejection 入口也不应被误吞（仅 window.error 分类）
  controller.capture(deliveryMessage, 'unhandledrejection');
  assert.equal(reported.length, 3);
  controller.stop();
}

assert.equal(listeners.get('error')?.size ?? 0, 0);
assert.equal(listeners.get('unhandledrejection')?.size ?? 0, 0);

console.log('globalErrorCapture tests passed');
