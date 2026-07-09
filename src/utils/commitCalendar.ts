import type { GitOwnCommit } from '../types';

export interface CommitCalendarItem extends GitOwnCommit {
  projectId: string;
  projectName: string;
  projectPath: string;
}

export interface CommitCalendarDay {
  date: string;
  day: number;
  inCurrentMonth: boolean;
  items: CommitCalendarItem[];
}

export interface CurrentMonthRange {
  year: number;
  month: number;
  startDate: string;
  endDate: string;
  title: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function resolveCurrentMonthRange(now = new Date()): CurrentMonthRange {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return {
    year: start.getFullYear(),
    month: start.getMonth(),
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
    title: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`,
  };
}

export function groupCommitCalendarItemsByDate(
  items: CommitCalendarItem[],
  startDate: string,
  endDate: string,
): Record<string, CommitCalendarItem[]> {
  const grouped: Record<string, CommitCalendarItem[]> = {};

  for (const item of items) {
    const date = formatLocalDate(new Date(item.date));
    if (date < startDate || date >= endDate) continue;
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(item);
  }

  for (const date of Object.keys(grouped)) {
    grouped[date].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  return grouped;
}

export function buildCommitCalendarDays(
  year: number,
  month: number,
  grouped: Record<string, CommitCalendarItem[]> = {},
): CommitCalendarDay[] {
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(firstDay);
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  gridStart.setDate(firstDay.getDate() - firstWeekday);

  const lastDay = new Date(year, month + 1, 0);
  const gridEnd = new Date(lastDay);
  const lastWeekday = (lastDay.getDay() + 6) % 7;
  gridEnd.setDate(lastDay.getDate() + (6 - lastWeekday));

  const days: CommitCalendarDay[] = [];
  const cursor = new Date(gridStart);

  while (cursor <= gridEnd) {
    const date = formatLocalDate(cursor);
    days.push({
      date,
      day: cursor.getDate(),
      inCurrentMonth: cursor.getMonth() === month,
      items: grouped[date] || [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

export function hasWeekendCommits(days: CommitCalendarDay[]): boolean {
  return days.some((day, index) => index % 7 >= 5 && day.items.length > 0);
}

export function formatCommitCalendarEntry(item: CommitCalendarItem): string {
  const date = new Date(item.date);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${item.projectName}：${item.message}（${time}）`;
}
