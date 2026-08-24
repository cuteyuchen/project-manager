import assert from 'node:assert/strict';
import { createPersistenceSaveQueue } from '../src/utils/persistenceQueue.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

{
  const firstWrite = deferred<void>();
  const writes: string[] = [];
  const queue = createPersistenceSaveQueue(async (serialized) => {
    writes.push(serialized);
    if (serialized === 'first') await firstWrite.promise;
  });

  const firstSave = queue.enqueue('first');
  const finalSave = queue.enqueue('final');
  firstWrite.resolve();
  await Promise.all([firstSave, finalSave]);

  assert.deepEqual(writes, ['first', 'final'], '排队中的最终状态必须在首个写入结束后落盘');
}

{
  let attempts = 0;
  const queue = createPersistenceSaveQueue(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('write failed');
  });

  await assert.rejects(queue.enqueue('retry-me'), /write failed/);
  await queue.enqueue('retry-me');

  assert.equal(attempts, 2, '失败后的同一份数据必须可以重试保存');
}

{
  let writes = 0;
  const queue = createPersistenceSaveQueue(async () => {
    writes += 1;
  });

  queue.markPersisted('current');
  await queue.enqueue('current');

  assert.equal(writes, 0, '已经确认落盘的数据不应重复写入');
}

console.log('persistence queue tests passed');
