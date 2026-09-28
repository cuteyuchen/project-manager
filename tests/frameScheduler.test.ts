import assert from 'node:assert/strict';
import { createFrameScheduler } from '../src/utils/frameScheduler.ts';

/***********************同一帧多次 schedule 只应用最新值*********************/
const frames: Array<() => void> = [];
const cancelled: number[] = [];
let nextHandle = 1;

function requestFrame(cb: () => void): number {
  frames.push(cb);
  return nextHandle++;
}

function cancelFrame(handle: number): void {
  cancelled.push(handle);
}

function flushFrame(): void {
  const pending = frames.splice(0, frames.length);
  for (const cb of pending) cb();
}

const applied: number[] = [];
const scheduler = createFrameScheduler<number>((value) => applied.push(value), requestFrame, cancelFrame);

scheduler.schedule(100);
scheduler.schedule(760);
scheduler.schedule(1350);
assert.equal(frames.length, 1, '同一帧只应排队一次');
assert.equal(scheduler.isPending(), true);

flushFrame();
assert.deepEqual(applied, [1350], '只应用最新宽度');
assert.equal(scheduler.isPending(), false);

/***********************后续帧可再次调度*********************/
scheduler.schedule(759);
assert.equal(frames.length, 1);
flushFrame();
assert.deepEqual(applied, [1350, 759]);

/***********************cancel 后不残留 RAF、不应用值*********************/
scheduler.schedule(999);
assert.equal(scheduler.isPending(), true);
const handleBeforeCancel = nextHandle - 1;
scheduler.cancel();
assert.equal(scheduler.isPending(), false);
assert.ok(cancelled.includes(handleBeforeCancel), 'cancel 应调用 cancelFrame');
flushFrame();
assert.deepEqual(applied, [1350, 759], 'cancel 后不应再应用值');

// cancel 后仍可继续使用
scheduler.schedule(1350);
flushFrame();
assert.deepEqual(applied, [1350, 759, 1350]);

console.log('frameScheduler tests passed');
