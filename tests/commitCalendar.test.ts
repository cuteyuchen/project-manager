import {
  buildCommitCalendarDays,
  canGoToNextCalendarMonth,
  formatCommitCalendarEntry,
  groupCommitCalendarItemsByDate,
  hasWeekendCommits,
  isCurrentCalendarMonth,
  resolveCurrentMonthRange,
  resolveMonthRange,
  shiftCalendarMonth,
} from '../src/utils/commitCalendar';
import type { CommitCalendarItem } from '../src/utils/commitCalendar';

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(
      `ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
    );
  }
}

/** Build a timestamp whose displayed date/time is local to the test runner. */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute, 0).toISOString();
}

/***********************当前自然月范围*********************/

{
  const range = resolveCurrentMonthRange(new Date(localIso(2026, 7, 9, 12, 30)));

  assertEq(range.startDate, '2026-07-01', '本月开始日期应为自然月 1 号');
  assertEq(range.endDate, '2026-08-01', '结束日期应为下月 1 号');
  assertEq(range.year, 2026, '应保留本月年份');
  assertEq(range.month, 6, 'month 应使用 Date 的 0-based 月份');
}

/***********************任意月份范围与切换边界*********************/

{
  const june = resolveMonthRange(2026, 5);
  assertEq(june.startDate, '2026-06-01', '6 月开始日期');
  assertEq(june.endDate, '2026-07-01', '6 月结束日期为下月 1 号');
  assertEq(june.title, '2026-06', '标题应为 YYYY-MM');

  const prev = shiftCalendarMonth(2026, 0, -1);
  assertEq(prev.year, 2025, '1 月上翻应跨年');
  assertEq(prev.month, 11, '1 月上翻应为 12 月');

  const next = shiftCalendarMonth(2025, 11, 1);
  assertEq(next.year, 2026, '12 月下翻应跨年');
  assertEq(next.month, 0, '12 月下翻应为 1 月');

  const now = new Date(localIso(2026, 8, 12, 10, 0));
  assert(canGoToNextCalendarMonth(2026, 6, now), '从 7 月可切到 8 月（当前月）');
  assert(!canGoToNextCalendarMonth(2026, 7, now), '已在当前月 8 月时不可再下翻');
  assert(!canGoToNextCalendarMonth(2026, 8, now), '未来月不可再下翻');
  assert(isCurrentCalendarMonth(2026, 7, now), '2026-08 应为当前月');
  assert(!isCurrentCalendarMonth(2026, 6, now), '2026-07 不是当前月');
}

/***********************月历网格生成*********************/

{
  const days = buildCommitCalendarDays(2026, 6);

  assertEq(days.length, 35, '2026 年 7 月月历应补齐为 5 周');
  assertEq(days[0].date, '2026-06-29', '月历第一格应从所在周周一开始');
  assertEq(days[2].date, '2026-07-01', '7 月 1 日应落在第一周周三');
  assert(days[2].inCurrentMonth, '本月日期应标记为当前月');
  assertEq(days[34].date, '2026-08-02', '最后一格应补齐到下一周周日');
  assert(!days[34].inCurrentMonth, '补齐日期不应标记为当前月');
}

/***********************周末列压缩判断*********************/

{
  const weekdayOnlyDays = buildCommitCalendarDays(2026, 6, {
    '2026-07-06': [
      {
        projectId: 'project-a',
        projectName: 'Project A',
        projectPath: '/projects/a',
        hash: 'aaa111',
        shortHash: 'aaa111',
        author: 'Yuchen',
        email: 'yuchen@example.com',
        date: localIso(2026, 7, 6, 9, 5),
        message: 'feat: 工作日提交',
      },
    ],
  });
  assertEq(hasWeekendCommits(weekdayOnlyDays), false, '所有周六周日都无提交时应允许压缩周末列');

  const weekendDays = buildCommitCalendarDays(2026, 6, {
    '2026-07-12': [
      {
        projectId: 'project-a',
        projectName: 'Project A',
        projectPath: '/projects/a',
        hash: 'bbb222',
        shortHash: 'bbb222',
        author: 'Yuchen',
        email: 'yuchen@example.com',
        date: localIso(2026, 7, 12, 9, 5),
        message: 'fix: 周末提交',
      },
    ],
  });
  assertEq(hasWeekendCommits(weekendDays), true, '只要周六或周日有提交就不应压缩周末列');
}

/***********************提交按本地日期分组*********************/

{
  const items: CommitCalendarItem[] = [
    {
      projectId: 'project-a',
      projectName: 'Project A',
      projectPath: '/projects/a',
      hash: 'aaa111',
      shortHash: 'aaa111',
      author: 'Yuchen',
      email: 'yuchen@example.com',
      date: localIso(2026, 7, 9, 9, 5),
      message: 'feat: 添加提交日历',
    },
    {
      projectId: 'project-b',
      projectName: 'Project B',
      projectPath: '/projects/b',
      hash: 'bbb222',
      shortHash: 'bbb222',
      author: 'Yuchen',
      email: 'yuchen@example.com',
      date: localIso(2026, 7, 9, 18, 30),
      message: 'fix: 修复统计',
    },
    {
      projectId: 'project-c',
      projectName: 'Project C',
      projectPath: '/projects/c',
      hash: 'ccc333',
      shortHash: 'ccc333',
      author: 'Yuchen',
      email: 'yuchen@example.com',
      date: localIso(2026, 8, 1, 0, 1),
      message: 'chore: 跨月提交',
    },
  ];

  const grouped = groupCommitCalendarItemsByDate(items, '2026-07-01', '2026-08-01');

  assertEq(grouped['2026-07-09'].length, 2, '同一天提交应聚合到同一日期');
  assertEq(grouped['2026-07-09'][0].message, 'feat: 添加提交日历', '同日提交应按时间升序排序');
  assertEq(grouped['2026-08-01'], undefined, '结束日期当天不应被纳入本月');
}

/***********************日历显示文本*********************/

{
  const text = formatCommitCalendarEntry({
    projectId: 'project-a',
    projectName: 'Project A',
    projectPath: '/projects/a',
    hash: 'aaa111',
    shortHash: 'aaa111',
    author: 'Yuchen',
    email: 'yuchen@example.com',
    date: localIso(2026, 7, 9, 9, 5),
    message: 'feat: 添加提交日历',
  });

  assertEq(text, 'Project A：feat: 添加提交日历（09:05）', '显示格式应为 项目名：提交信息（HH:mm）');
}

console.log('commitCalendar tests passed');
