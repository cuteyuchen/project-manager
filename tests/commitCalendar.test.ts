import {
  buildCommitCalendarDays,
  formatCommitCalendarEntry,
  groupCommitCalendarItemsByDate,
  hasWeekendCommits,
  resolveCurrentMonthRange,
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

/***********************当前自然月范围*********************/

{
  const range = resolveCurrentMonthRange(new Date('2026-07-09T12:30:00+08:00'));

  assertEq(range.startDate, '2026-07-01', '本月开始日期应为自然月 1 号');
  assertEq(range.endDate, '2026-08-01', '结束日期应为下月 1 号');
  assertEq(range.year, 2026, '应保留本月年份');
  assertEq(range.month, 6, 'month 应使用 Date 的 0-based 月份');
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
        date: '2026-07-06T09:05:00+08:00',
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
        date: '2026-07-12T09:05:00+08:00',
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
      date: '2026-07-09T09:05:00+08:00',
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
      date: '2026-07-09T18:30:00+08:00',
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
      date: '2026-08-01T00:01:00+08:00',
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
    date: '2026-07-09T09:05:00+08:00',
    message: 'feat: 添加提交日历',
  });

  assertEq(text, 'Project A：feat: 添加提交日历（09:05）', '显示格式应为 项目名：提交信息（HH:mm）');
}

console.log('commitCalendar tests passed');
