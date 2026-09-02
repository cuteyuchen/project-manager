import assert from 'node:assert/strict';
import { createLifecycleGuard, flushBeforeLifecycle } from '../src/utils/lifecycle.ts';

{
  const calls: string[] = [];
  const result = await flushBeforeLifecycle(
    async () => calls.push('data'),
    async () => calls.push('history'),
    async () => 'cancel',
  );
  assert.equal(result, 'saved');
  assert.deepEqual(calls, ['data', 'history']);
}

{
  let attempts = 0;
  const result = await flushBeforeLifecycle(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk unavailable');
    },
    async () => undefined,
    async () => 'retry',
  );
  assert.equal(result, 'saved');
  assert.equal(attempts, 2);
}

{
  const result = await flushBeforeLifecycle(
    async () => { throw new Error('data failure'); },
    async () => undefined,
    async () => 'cancel',
  );
  assert.equal(result, 'cancel');
}

{
  const result = await flushBeforeLifecycle(
    async () => { throw new Error('data failure'); },
    async () => undefined,
    async () => 'continue',
  );
  assert.equal(result, 'continue');
}

const guard = createLifecycleGuard();
assert.equal(guard.tryEnter(), true);
assert.equal(guard.tryEnter(), false);
assert.equal(guard.isActive(), true);
guard.leave();
assert.equal(guard.tryEnter(), true);
console.log('appLifecycle tests passed');
