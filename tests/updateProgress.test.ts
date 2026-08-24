import {
  INITIAL_UPDATE_PROGRESS,
  reduceUpdateProgress,
} from '../src/utils/updateProgress';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

let state = reduceUpdateProgress(INITIAL_UPDATE_PROGRESS, {
  event: 'Started',
  data: { contentLength: 100 },
});
assert(state.percentage === 0, 'known-size downloads should start at 0%');
assert(!state.indeterminate, 'known-size downloads should be determinate');

state = reduceUpdateProgress(state, {
  event: 'Progress',
  data: { chunkLength: 40 },
});
assert(state.percentage === 40, 'progress should use the reported content length');

state = reduceUpdateProgress(state, { event: 'Finished' });
assert(state.percentage === 100, 'finished downloads should display 100%');
assert(state.phase === 'verifying', 'finished downloads should enter verification');

state = reduceUpdateProgress(INITIAL_UPDATE_PROGRESS, {
  event: 'Started',
  data: {},
});
assert(state.indeterminate, 'unknown-size downloads should be indeterminate');

state = reduceUpdateProgress(state, {
  event: 'Progress',
  data: { chunkLength: 1024 },
});
assert(state.percentage === 0, 'unknown-size downloads should not invent a percentage');

console.log('updateProgress tests passed');
