import assert from 'node:assert/strict';
import {
  CONSOLE_RENDER_WINDOW_SIZE,
  MAX_SESSION_LOG_LINES,
  buildSessionLogExportText,
  filterLogEntries,
  formatLogEntriesPlainText,
  getRenderWindow,
  nextMatchIndex,
  searchLogEntries,
  stripAnsi,
  trimLogEntries,
} from '../src/utils/consoleLogs.ts';
import type { RunLogEntry } from '../src/types.ts';

const entries: RunLogEntry[] = Array.from({ length: 2_000 }, (_, index) => ({
  sequence: index,
  stream: index % 3 === 0 ? 'stderr' : index % 3 === 1 ? 'system' : 'stdout',
  text: index === 3
    ? '\u001b[31m中文 Build failed\u001b[0m'
    : `line ${index} ${index % 10 === 0 ? 'Needle' : 'ordinary'}`,
}));

/*********************** ANSI and text projection ***********************/
assert.equal(stripAnsi('plain text'), 'plain text');
assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
assert.equal(stripAnsi('\u001b[1;38;5;42mcomplex\u001b[0m'), 'complex');
assert.equal(stripAnsi('\u001b]8;;https://example.test/a\u0007link\u001b]8;;\u0007'), 'link');
assert.equal(stripAnsi('url https://example.test/a?x=1 中文'), 'url https://example.test/a?x=1 中文');
assert.equal(formatLogEntriesPlainText(entries.slice(0, 4), 'partial\u001b[32m!\u001b[0m'), 'line 0 Needle\nline 1 ordinary\nline 2 ordinary\n中文 Build failed\npartial!');

/*********************** stream filters and full in-memory search ***********************/
assert.equal(filterLogEntries(entries, 'stdout').every(entry => entry.stream === 'stdout'), true);
assert.equal(filterLogEntries(entries, 'stderr').every(entry => entry.stream === 'stderr'), true);
assert.equal(filterLogEntries(entries, 'system').every(entry => entry.stream === 'system'), true);
assert.equal(filterLogEntries(entries, 'all').length, entries.length);

assert.deepEqual(searchLogEntries(entries, ''), []);
assert.equal(searchLogEntries(entries, 'NEEDLE').length, 200);
assert.equal(searchLogEntries(entries, '中文')[0].sequence, 3);
assert.equal(searchLogEntries(entries, 'failed')[0].sequence, 3);
assert.equal(searchLogEntries(entries, 'needle', 'stdout').every(match => entries[match.entryIndex].stream === 'stdout'), true);
assert.equal(searchLogEntries(entries, 'needle', 'stderr').every(match => entries[match.entryIndex].stream === 'stderr'), true);
assert.equal(searchLogEntries(entries, 'needle', 'system').every(match => entries[match.entryIndex].stream === 'system'), true);

assert.equal(nextMatchIndex(3, -1, 'next'), 0);
assert.equal(nextMatchIndex(3, -1, 'previous'), 2);
assert.equal(nextMatchIndex(3, 2, 'next'), 0);
assert.equal(nextMatchIndex(3, 0, 'previous'), 2);
assert.equal(nextMatchIndex(0, 0, 'next'), -1);

/*********************** render window and stable sequence ***********************/
const latestWindow = getRenderWindow(entries);
assert.equal(latestWindow.items.length, CONSOLE_RENDER_WINDOW_SIZE);
assert.equal(latestWindow.start, 1_500);
assert.equal(latestWindow.items[0].sequence, 1_500);

const topWindow = getRenderWindow(entries, CONSOLE_RENDER_WINDOW_SIZE, 0);
assert.equal(topWindow.start, 0);
assert.equal(topWindow.items[0].sequence, 0);

const focusedWindow = getRenderWindow(entries, CONSOLE_RENDER_WINDOW_SIZE, 3);
assert(focusedWindow.items.some(entry => entry.sequence === 3), 'an early search match must enter the render DOM window');
assert.equal(focusedWindow.items.length, CONSOLE_RENDER_WINDOW_SIZE);

const trimmed = trimLogEntries(entries, MAX_SESSION_LOG_LINES);
assert.equal(trimmed.length, entries.length, 'under-cap logs should remain intact');
assert.equal(trimmed[0].sequence, 0);
const overCap = trimLogEntries(Array.from({ length: 2_400 }, (_, index) => ({
  sequence: index,
  stream: 'stdout' as const,
  text: `line ${index}`,
})), MAX_SESSION_LOG_LINES);
assert.equal(overCap.length, MAX_SESSION_LOG_LINES);
assert.equal(overCap[0].sequence, 400);
assert.equal(overCap[overCap.length - 1].sequence, 2_399);

/*********************** copy/export covers all retained entries ***********************/
const copied = formatLogEntriesPlainText(entries);
assert(copied.includes('line 0 Needle'));
assert(copied.includes('line 1,999 ordinary') || copied.includes('line 1999 ordinary'));
assert(!copied.includes('\u001b['));

const exported = buildSessionLogExportText({
  project: 'Demo',
  command: 'build',
  status: 'Failed',
  started: '2026-09-01 12:00',
  ended: '2026-09-01 12:01',
  duration: '1m',
  exitCode: '1',
  node: 'v20.19.1',
  runtime: 'C:/node/node.exe',
  packageManager: 'npm',
  cwd: 'C:/demo',
}, entries, 'active partial');
assert(exported.includes('Status: Failed'));
assert(exported.includes('--- Output ---'));
assert(exported.includes('line 0 Needle'));
assert(exported.includes('line 1,999 ordinary') || exported.includes('line 1999 ordinary'));
assert(!exported.includes('\u001b['));
assert(exported.includes('active partial'));

console.log('consoleLogSearch tests passed');
