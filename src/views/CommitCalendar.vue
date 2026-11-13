<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useCommitCalendar } from '../composables/useCommitCalendar';
import { formatCommitCalendarEntry, hasWeekendCommits, resolveDayCommitItems } from '../utils/commitCalendar';
import type { CommitCalendarItem } from '../utils/commitCalendar';

const { t, locale } = useI18n();

/***********************提交日历数据*********************/

const {
  loading,
  loaded,
  range,
  skippedProjects,
  calendarDays,
  totalCommits,
  canGoNextMonth,
  isViewingCurrentMonth,
  refresh,
  goPrevMonth,
  goNextMonth,
  goCurrentMonth,
} = useCommitCalendar();

const weekdays = computed(() => {
  if (locale.value.startsWith('zh')) {
    return ['一', '二', '三', '四', '五', '六', '日'];
  }
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
});

const skippedSummary = computed(() => {
  if (skippedProjects.value.length === 0) return '';
  return t('commitCalendar.skippedSummary', { count: skippedProjects.value.length });
});
const skippedExpanded = ref(false);
const SKIPPED_PREVIEW_LIMIT = 8;
const visibleSkippedProjects = computed(() => (
  skippedExpanded.value ? skippedProjects.value : skippedProjects.value.slice(0, SKIPPED_PREVIEW_LIMIT)
));
const hiddenSkippedCount = computed(() => Math.max(0, skippedProjects.value.length - visibleSkippedProjects.value.length));
watch(skippedProjects, () => { skippedExpanded.value = false; });

const shouldCompressWeekend = computed(() => !hasWeekendCommits(calendarDays.value));

const calendarGridColumns = computed(() => (
  shouldCompressWeekend.value
    ? 'repeat(5, minmax(160px, 1fr)) 56px 56px'
    : 'repeat(7, minmax(0, 1fr))'
));

const calendarGridStyle = computed(() => {
  const weekCount = Math.max(1, Math.ceil(calendarDays.value.length / 7));
  const minRowHeight = 112;
  return {
    gridTemplateColumns: calendarGridColumns.value,
    gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))`,
    minHeight: `${weekCount * minRowHeight}px`,
  };
});

function getSkipReasonText(reason: string): string {
  return t(`commitCalendar.skipReasons.${reason}`);
}

function formatCommitTime(date: string): string {
  return new Date(date).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatCommitDateTime(date: string): string {
  return new Date(date).toLocaleString('zh-CN', { hour12: false });
}

/***********************提交详情与复制*********************/

const selectedCommit = shallowRef<CommitCalendarItem | null>(null);
/** 弹窗左侧展示的「当天全部提交」，切换选中项时保持不变 */
const detailDayItems = shallowRef<CommitCalendarItem[]>([]);
const selectedCommitDetailMessage = shallowRef('');
const detailLoading = shallowRef(false);
const detailListEl = shallowRef<HTMLElement | null>(null);
let detailRequestId = 0;

const detailVisible = computed({
  get: () => selectedCommit.value !== null,
  set: (value: boolean) => {
    if (!value) {
      detailRequestId += 1;
      selectedCommit.value = null;
      detailDayItems.value = [];
      selectedCommitDetailMessage.value = '';
      detailLoading.value = false;
    }
  },
});

const selectedCommitMessageText = computed(() => {
  if (!selectedCommit.value) return '';
  return selectedCommitDetailMessage.value || selectedCommit.value.message;
});

function formatDetailDay(date: string): string {
  const target = new Date(date);
  const pad = (value: number) => String(value).padStart(2, '0');
  const weekday = target.toLocaleDateString(locale.value.startsWith('zh') ? 'zh-CN' : 'en-US', {
    weekday: 'short',
  });
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${weekday}`;
}

/** 概览列表只显示提交标题，完整内容在右侧展示 */
function commitTitle(message: string): string {
  return message.split('\n')[0].trim();
}

function isDetailActive(item: CommitCalendarItem): boolean {
  const current = selectedCommit.value;
  return !!current && current.hash === item.hash && current.projectId === item.projectId;
}

function openCommitDetail(item: CommitCalendarItem): void {
  detailDayItems.value = resolveDayCommitItems(calendarDays.value, item);
  selectedCommit.value = item;
  selectedCommitDetailMessage.value = '';
  void loadCommitDetail(item);
  void revealActiveDetailItem();
}

/** 点击左侧概览切换右侧详情 */
function selectDetailCommit(item: CommitCalendarItem): void {
  if (isDetailActive(item)) return;
  selectedCommit.value = item;
  selectedCommitDetailMessage.value = '';
  void loadCommitDetail(item);
}

/** 从日历较靠后的日期打开时，把当前提交滚进可视区域 */
async function revealActiveDetailItem(): Promise<void> {
  await nextTick();
  detailListEl.value
    ?.querySelector<HTMLElement>('.commit-detail-item.is-active')
    ?.scrollIntoView({ block: 'nearest' });
}

async function loadCommitDetail(item: CommitCalendarItem): Promise<void> {
  const requestId = detailRequestId + 1;
  detailRequestId = requestId;
  detailLoading.value = true;

  try {
    const detail = await api.gitCommitDetail(item.projectPath, item.hash);
    if (detailRequestId === requestId && isDetailActive(item)) {
      selectedCommitDetailMessage.value = detail.message;
    }
  } catch (error) {
    if (detailRequestId === requestId) {
      ElMessage.error(t('commitCalendar.loadDetailFailed', { error: String(error) }));
    }
  } finally {
    if (detailRequestId === requestId) {
      detailLoading.value = false;
    }
  }
}

async function copySelectedCommit(): Promise<void> {
  if (!selectedCommitMessageText.value) return;
  try {
    await navigator.clipboard.writeText(selectedCommitMessageText.value);
    ElMessage.success(t('commitCalendar.copySuccess'));
  } catch (error) {
    ElMessage.error(t('commitCalendar.copyFailed', { error: String(error) }));
  }
}

/***********************生命周期加载*********************/

function refreshIfNeeded(): void {
  if (!loaded.value && !loading.value) {
    void refresh();
  }
}

onMounted(refreshIfNeeded);
onActivated(refreshIfNeeded);
</script>

<template>
  <div class="app-page">
    <div class="app-page-header">
      <div class="app-content-container">
      <div class="app-page-header-main">
        <div class="app-page-heading">
          <div class="flex items-center gap-2">
            <div class="i-mdi-calendar-month text-xl text-blue-500" />
            <h2 class="app-page-title !mt-0">
              {{ t('commitCalendar.title') }}
            </h2>
          </div>
          <p class="app-page-description">
            {{ t('commitCalendar.subtitle', { month: range.title, count: totalCommits }) }}
          </p>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <!-- 月份切换：仅允许当前月及之前 -->
          <div class="commit-calendar-month-nav flex items-center gap-0.5 rounded-md border border-slate-200/70 dark:border-slate-700/50 bg-white/60 dark:bg-slate-900/40 p-0.5">
            <button
              type="button"
              class="month-nav-btn"
              :disabled="loading"
              :title="t('commitCalendar.prevMonth')"
              @click="goPrevMonth"
            >
              <div class="i-mdi-chevron-left text-base" />
            </button>
            <span class="app-text-control min-w-18 px-1 text-center font-semibold tabular-nums text-slate-700 dark:text-slate-200">
              {{ range.title }}
            </span>
            <button
              type="button"
              class="month-nav-btn"
              :disabled="loading || !canGoNextMonth"
              :title="canGoNextMonth ? t('commitCalendar.nextMonth') : t('commitCalendar.nextMonthDisabled')"
              @click="goNextMonth"
            >
              <div class="i-mdi-chevron-right text-base" />
            </button>
          </div>

          <button
            v-if="!isViewingCurrentMonth"
            type="button"
            class="month-current-btn"
            :disabled="loading"
            :title="t('commitCalendar.backToCurrentMonth')"
            @click="goCurrentMonth"
          >
            <span>{{ t('commitCalendar.thisMonth') }}</span>
          </button>

          <button
            class="app-primary-action !min-h-8 !rounded-md !px-3 !py-1.5"
            :disabled="loading"
            @click="refresh()"
          >
            <div class="i-mdi-refresh text-sm" :class="{ 'animate-spin': loading }" />
            <span>{{ t('common.refresh') }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="skippedSummary"
        class="app-alert-warning app-page-header-extra app-text-control px-3 py-2"
      >
        <div class="font-medium">{{ skippedSummary }}</div>
        <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 overflow-hidden">
          <span v-for="project in visibleSkippedProjects" :key="project.projectId" class="max-w-56 truncate" :title="`${project.projectName}：${getSkipReasonText(project.reason)}`">
            {{ project.projectName }}：{{ getSkipReasonText(project.reason) }}
          </span>
        </div>
        <button
          v-if="skippedProjects.length > SKIPPED_PREVIEW_LIMIT"
          type="button"
          class="app-text-control mt-2 font-semibold text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
          :aria-expanded="skippedExpanded"
          @click="skippedExpanded = !skippedExpanded"
        >
          {{ skippedExpanded ? t('commitCalendar.collapseSkipped') : t('commitCalendar.expandSkipped', { count: hiddenSkippedCount }) }}
        </button>
      </div>
      </div>
    </div>

    <div
      class="app-card-soft shrink-0 grid !rounded-none border-x-0 border-t-0"
      :style="{ gridTemplateColumns: calendarGridColumns }"
    >
      <div
        v-for="day in weekdays"
        :key="day"
        class="h-8 flex items-center justify-center app-text-meta font-semibold text-slate-500 dark:text-slate-400"
      >
        {{ day }}
      </div>
    </div>

    <div v-if="loading && !loaded" class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
      <div class="i-mdi-loading animate-spin text-xl mr-2" />
      {{ t('common.loading') }}
    </div>

    <div v-else class="relative flex-1 min-h-0 overflow-auto">
      <div
        class="commit-calendar-grid grid gap-px p-px"
        :style="calendarGridStyle"
      >
        <div
          v-for="day in calendarDays"
          :key="day.date"
          class="flex min-w-0 flex-col overflow-hidden p-2"
          :class="day.inCurrentMonth ? 'commit-day-current' : 'commit-day-muted'"
        >
          <div class="flex items-center justify-between gap-2">
            <span
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 app-text-caption font-semibold"
              :class="day.inCurrentMonth ? 'text-slate-600 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600'"
            >
              {{ day.day }}
            </span>
            <span
              v-if="day.items.length > 0"
              class="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 app-text-caption font-semibold text-blue-600 dark:text-blue-300"
            >
              {{ day.items.length }}
            </span>
          </div>

          <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 commit-day-scroll">
            <button
              v-for="item in day.items"
              :key="item.projectId + item.hash"
              type="button"
              class="commit-entry-btn"
              :title="formatCommitCalendarEntry(item)"
              @click="openCommitDetail(item)"
            >
              <span class="commit-entry-project">{{ item.projectName }}</span>
              <span class="commit-entry-message">{{ item.message }}</span>
              <span class="commit-entry-time">（{{ formatCommitTime(item.date) }}）</span>
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="loaded && totalCommits === 0"
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-center"
      >
        <div class="app-card px-5 py-4">
          <div class="i-mdi-calendar-blank-outline text-3xl mx-auto mb-2 text-slate-300 dark:text-slate-600" />
          <div class="text-sm font-medium text-slate-500 dark:text-slate-300">{{ t('commitCalendar.empty') }}</div>
          <div class="app-text-meta mt-1 text-slate-400 dark:text-slate-500">{{ t('commitCalendar.emptyHint') }}</div>
        </div>
      </div>
    </div>

    <el-dialog
      v-model="detailVisible"
      :title="t('commitCalendar.detailTitle')"
      width="min(860px, 92vw)"
      append-to-body
      align-center
      class="commit-calendar-dialog"
    >
      <div v-if="selectedCommit" class="commit-detail-layout">
        <!-- 左侧：当天所有提交概览，点击切换右侧详情 -->
        <aside class="commit-detail-day" :title="t('commitCalendar.dayCommits')">
          <div class="commit-detail-day-head">
            <div class="i-mdi-calendar-today shrink-0 text-sm text-blue-500" />
            <span class="commit-detail-day-date">{{ formatDetailDay(selectedCommit.date) }}</span>
            <span class="commit-detail-day-count">{{ detailDayItems.length }}</span>
          </div>

          <div ref="detailListEl" class="commit-detail-day-list">
            <button
              v-for="item in detailDayItems"
              :key="item.projectId + item.hash"
              type="button"
              class="commit-detail-item"
              :class="{ 'is-active': isDetailActive(item) }"
              :aria-current="isDetailActive(item) ? 'true' : undefined"
              :title="formatCommitCalendarEntry(item)"
              @click="selectDetailCommit(item)"
            >
              <div class="commit-detail-item-head">
                <span class="commit-detail-item-time">{{ formatCommitTime(item.date) }}</span>
                <span class="commit-detail-item-project">{{ item.projectName }}</span>
                <span class="commit-detail-item-hash">{{ item.shortHash }}</span>
              </div>
              <div class="commit-detail-item-message">{{ commitTitle(item.message) }}</div>
            </button>
          </div>
        </aside>

        <!-- 右侧：当前选中提交的详情 -->
        <section class="commit-detail-body app-text-body text-slate-600 dark:text-slate-300">
          <div class="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2">
            <span class="app-text-meta text-slate-400 dark:text-slate-500">{{ t('commitCalendar.project') }}</span>
            <span class="font-medium text-slate-700 dark:text-slate-100">{{ selectedCommit.projectName }}</span>
            <span class="app-text-meta text-slate-400 dark:text-slate-500">{{ t('commitCalendar.time') }}</span>
            <span>{{ formatCommitDateTime(selectedCommit.date) }}</span>
            <span class="app-text-meta text-slate-400 dark:text-slate-500">{{ t('git.hash') }}</span>
            <span class="font-mono">{{ selectedCommit.shortHash }}</span>
          </div>

          <div class="mt-3 flex min-h-0 flex-1 flex-col">
            <div class="app-text-meta mb-1 text-slate-400 dark:text-slate-500">{{ t('git.commitMessage') }}</div>
            <div
              v-if="detailLoading"
              class="app-code-block app-text-code flex min-h-24 items-center justify-center"
            >
              <div class="i-mdi-loading animate-spin mr-1.5" />
              {{ t('common.loading') }}
            </div>
            <pre v-else class="app-code-block app-text-code m-0 max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2">{{ selectedCommitMessageText }}</pre>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="flex justify-end gap-2">
          <el-button @click="detailVisible = false">{{ t('common.close') }}</el-button>
          <el-button type="primary" :loading="detailLoading" @click="copySelectedCommit">
            {{ t('commitCalendar.copy') }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.month-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-secondary, #64748b);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.month-nav-btn:hover:not(:disabled) {
  background: var(--app-primary-soft, #dbeafe);
  color: var(--app-primary, #2563eb);
}

.month-nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.month-current-btn {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--app-border, #e2e8f0);
  background: var(--app-surface-soft, #f8fafc);
  color: var(--app-text-secondary, #475569);
  font-size: var(--app-font-control);
  line-height: var(--app-line-height-control);
  cursor: pointer;
}

.month-current-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-primary, #2563eb) 30%, transparent);
  color: var(--app-primary, #2563eb);
  background: var(--app-primary-soft, #dbeafe);
}

.month-current-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.commit-calendar-grid {
  height: 100%;
  background: var(--app-border);
}

.commit-day-current {
  background: var(--app-surface);
}

.commit-day-muted {
  background: var(--app-surface-soft);
  color: var(--app-text-muted);
}

.commit-entry-btn {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  padding: 2px 4px;
  text-align: left;
  font-size: var(--app-font-control);
  line-height: 18px;
  color: var(--app-text-secondary);
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    color var(--app-duration-fast) var(--app-ease);
}

.commit-entry-btn:hover {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.commit-entry-project {
  max-width: 36%;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}

.commit-entry-message {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-entry-time {
  flex: 0 0 auto;
  color: var(--app-text-muted);
}

.commit-day-scroll::-webkit-scrollbar {
  width: 4px;
}

.commit-day-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 999px;
}

/***********************提交详情：左侧当天概览 + 右侧详情*********************/

.commit-detail-layout {
  display: flex;
  gap: 16px;
  min-height: 260px;
  max-height: 60vh;
}

.commit-detail-day {
  display: flex;
  flex: 0 0 248px;
  min-width: 0;
  flex-direction: column;
  padding-right: 12px;
  border-right: 1px solid var(--app-border);
}

.commit-detail-day-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 8px;
  border-bottom: 1px solid var(--app-border);
}

.commit-detail-day-date {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--app-font-control);
  font-weight: 600;
  color: var(--app-text-secondary);
}

.commit-detail-day-count {
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--app-primary-soft);
  padding: 0 6px;
  font-size: var(--app-font-caption);
  font-weight: 600;
  line-height: 18px;
  color: var(--app-primary);
}

.commit-detail-day-list {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  overflow-y: auto;
  padding-right: 4px;
}

.commit-detail-item {
  display: flex;
  width: 100%;
  min-width: 0;
  appearance: none;
  flex-direction: column;
  gap: 2px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 6px 8px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--app-duration-fast) var(--app-ease),
    border-color var(--app-duration-fast) var(--app-ease);
}

.commit-detail-item:hover {
  background: var(--app-surface-soft);
}

.commit-detail-item.is-active {
  border-color: color-mix(in srgb, var(--app-primary) 30%, transparent);
  background: var(--app-primary-soft);
}

.commit-detail-item-head {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  font-size: var(--app-font-caption);
  line-height: 16px;
}

.commit-detail-item-time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--app-text-muted);
}

.commit-detail-item-project {
  flex: 0 1 auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--app-text-secondary);
}

.commit-detail-item-hash {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--app-text-muted);
}

.commit-detail-item-message {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--app-font-control);
  line-height: 18px;
  color: var(--app-text-secondary);
}

.commit-detail-item.is-active .commit-detail-item-message {
  color: var(--app-primary);
}

.commit-detail-body {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  overflow-y: auto;
}

.commit-detail-day-list::-webkit-scrollbar {
  width: 4px;
}

.commit-detail-day-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 56%, transparent);
  border-radius: 999px;
}
</style>
