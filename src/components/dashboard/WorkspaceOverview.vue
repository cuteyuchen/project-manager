<script setup lang="ts">
/**
 * 项目总览面板：展示项目统计、分类项目清单和启动组入口。
 */
import type { Project, WorkspaceProfile, ProjectHealthSnapshot } from '../../types';
import { useProjectStore } from '../../stores/project';
import { useI18n } from 'vue-i18n';
import HealthBadge from './HealthBadge.vue';

type OverviewCategoryTone = 'slate' | 'emerald' | 'amber' | 'red' | 'rose' | 'blue';

interface OverviewProjectCategory {
  key: string;
  label: string;
  count: number;
  tone: OverviewCategoryTone;
  icon: string;
  projects: Project[];
}

const { t } = useI18n();
const projectStore = useProjectStore();

const props = defineProps<{
  /** 健康汇总 */
  summary: {
    total: number;
    running: number;
    dirty: number;
    unhealthy: number;
    missing: number;
  };
  /** 项目分类清单 */
  categories: OverviewProjectCategory[];
  /** 启动组列表 */
  profiles: WorkspaceProfile[];
  /** 获取项目健康等级 */
  healthLevel: (snapshot: ProjectHealthSnapshot | undefined) => 'healthy' | 'warn' | 'error' | 'unknown';
  /** 获取项目健康快照 */
  getHealth: (projectId: string) => ProjectHealthSnapshot | undefined;
}>();

const emit = defineEmits<{
  selectProject: [id: string];
  runProfile: [profile: WorkspaceProfile];
  stopProfile: [profile: WorkspaceProfile];
}>();

/***********************分类展示样式*********************/
const toneTextClass: Record<OverviewCategoryTone, string> = {
  slate: 'text-slate-700 dark:text-slate-200',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  red: 'text-red-500 dark:text-red-400',
  rose: 'text-rose-500 dark:text-rose-400',
  blue: 'text-blue-600 dark:text-blue-400',
};

const toneIconClass: Record<OverviewCategoryTone, string> = {
  slate: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  red: 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400',
  rose: 'bg-rose-50 text-rose-500 dark:bg-rose-500/10 dark:text-rose-400',
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
};

const statCards = [
  { key: 'total', labelKey: 'dashboard.overviewTotal', valueKey: 'total', tone: 'slate' },
  { key: 'running', labelKey: 'dashboard.overviewRunning', valueKey: 'running', tone: 'emerald' },
  { key: 'dirty', labelKey: 'dashboard.overviewDirty', valueKey: 'dirty', tone: 'amber' },
  { key: 'unhealthy', labelKey: 'dashboard.overviewUnhealthy', valueKey: 'unhealthy', tone: 'red' },
  { key: 'missing', labelKey: 'dashboard.overviewMissing', valueKey: 'missing', tone: 'rose' },
] as const;

function getSummaryValue(valueKey: typeof statCards[number]['valueKey']): number {
  return props.summary[valueKey];
}

function isProjectRunning(projectId: string): boolean {
  return (projectStore.runningProjectCount[projectId] ?? 0) > 0;
}

/***********************启动组状态*********************/
function isProfileRunning(profile: WorkspaceProfile): boolean {
  return profile.items.some((item) => {
    const runId = `${item.projectId}:${item.nameOrCommandId}`;
    return !!projectStore.runningStatus[runId];
  });
}
</script>

<template>
  <div class="workspace-overview h-full min-h-0 overflow-y-auto p-5 custom-scrollbar">
    <!-- 标题 -->
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-slate-700 dark:text-slate-200">
        {{ t('dashboard.overviewTitle') }}
      </h2>
      <div class="text-xs text-slate-400 dark:text-slate-500">
        {{ t('dashboard.overviewProjectCount', { count: summary.total }) }}
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
      <div
        v-for="card in statCards"
        :key="card.key"
        class="stat-card app-card p-3"
      >
        <div class="text-[10px] text-slate-400 dark:text-slate-500 mb-1">
          {{ t(card.labelKey) }}
        </div>
        <div class="text-xl font-bold" :class="toneTextClass[card.tone]">
          {{ getSummaryValue(card.valueKey) }}
        </div>
      </div>
    </div>

    <!-- 分类项目清单 -->
    <div class="overview-category-grid grid grid-cols-1 xl:grid-cols-2 gap-3 mb-6">
      <section
        v-for="category in categories"
        :key="category.key"
        class="overview-section app-card overflow-hidden"
      >
        <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--app-border)]">
          <div
            class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            :class="toneIconClass[category.tone]"
          >
            <div :class="category.icon" class="text-sm" />
          </div>
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
              {{ category.label }}
            </h3>
            <p class="text-[10px] text-slate-400 dark:text-slate-500">
              {{ t('dashboard.overviewProjectCount', { count: category.count }) }}
            </p>
          </div>
        </div>

        <div v-if="category.projects.length > 0" class="overview-project-list custom-scrollbar">
          <button
            v-for="project in category.projects"
            :key="project.id"
            class="overview-project-row"
            @click="emit('selectProject', project.id)"
          >
            <div class="overview-project-icon">
              <div class="i-mdi-folder-outline text-sm" />
            </div>
            <div class="overview-project-main">
              <div class="overview-project-name">
                {{ project.name }}
              </div>
              <div class="overview-project-path">
                {{ project.path }}
              </div>
            </div>
            <div class="overview-project-status">
              <HealthBadge
                :snapshot="getHealth(project.id)"
                :level="healthLevel(getHealth(project.id))"
              />
              <div
                v-if="isProjectRunning(project.id)"
                class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse"
              />
              <div class="overview-project-locate i-mdi-crosshairs-gps" />
            </div>
          </button>
        </div>

        <div v-else class="overview-category-empty">
          {{ t('dashboard.overviewCategoryEmpty') }}
        </div>
      </section>
    </div>

    <!-- 启动组 -->
    <section v-if="profiles.length > 0" class="mb-6">
      <h3 class="text-sm font-medium text-slate-600 dark:text-slate-300 mb-2">
        <div class="i-mdi-rocket-launch-outline text-xs inline mr-1" />
        {{ t('dashboard.profilesTitle') }}
      </h3>
      <div class="space-y-1.5">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="app-card flex items-center gap-2 px-3 py-2"
        >
          <div class="i-mdi-play-circle-outline text-sm text-slate-400 shrink-0" />
          <span class="text-sm text-slate-700 dark:text-slate-200 truncate flex-1">{{ profile.name }}</span>
          <span class="text-[10px] text-slate-400">{{ profile.items.length }} {{ t('dashboard.profileItems') }}</span>

          <!-- 运行中数量 -->
          <span
            v-if="isProfileRunning(profile)"
            class="text-[10px] text-emerald-500 flex items-center gap-0.5"
          >
            <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          </span>

          <!-- 运行/停止按钮 -->
          <button
            v-if="!isProfileRunning(profile)"
            class="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
            @click="emit('runProfile', profile)"
          >
            {{ t('dashboard.profileRun') }}
          </button>
          <button
            v-else
            class="text-[11px] px-2 py-0.5 rounded bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
            @click="emit('stopProfile', profile)"
          >
            {{ t('dashboard.profileStopAll') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 无数据的空状态提示 -->
    <div
      v-if="summary.total === 0"
      class="text-center py-10 text-slate-300 dark:text-slate-600"
    >
      <div class="i-mdi-monitor-dashboard text-6xl opacity-30 mx-auto mb-3" />
      <p class="text-sm font-medium">{{ t('dashboard.selectProjectHint') }}</p>
      <p class="text-xs opacity-50 mt-1">{{ t('dashboard.selectProjectDesc') }}</p>
    </div>
  </div>
</template>

<style scoped>
.workspace-overview {
  min-height: 0;
  scrollbar-gutter: stable;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--app-text-muted) 52%, transparent);
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--app-text-muted) 74%, transparent);
}

.overview-category-grid {
  align-items: stretch;
  grid-auto-rows: minmax(0, auto);
}

.overview-section {
  --overview-section-max-height: clamp(320px, calc(100vh - 340px), 560px);

  display: flex;
  min-height: 220px;
  max-height: var(--overview-section-max-height);
  min-width: 0;
  flex-direction: column;
}

.overview-project-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding: 8px;
}

.overview-category-empty {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
  color: var(--app-text-muted);
  font-size: 12px;
}

.overview-project-row {
  appearance: none;
  display: flex;
  width: 100%;
  min-height: 54px;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--app-surface-soft);
  padding: 8px 10px;
  text-align: left;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

.overview-project-icon {
  display: flex;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: color-mix(in srgb, var(--app-text-muted) 12%, transparent);
  color: var(--app-text-secondary);
}

.overview-project-main {
  min-width: 0;
  flex: 1;
}

.overview-project-name {
  overflow: hidden;
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-project-path {
  overflow: hidden;
  color: var(--app-text-muted);
  font-size: 10px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.overview-project-status {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.overview-project-locate {
  color: var(--app-text-muted);
  font-size: 13px;
  transition: color 0.15s ease, transform 0.15s ease;
}

.overview-project-row:hover {
  border-color: color-mix(in srgb, var(--app-primary) 26%, transparent);
  background: var(--app-surface);
  box-shadow: var(--app-shadow-sm);
  transform: translateY(-1px);
}

.overview-project-row:hover .overview-project-icon {
  background: var(--app-primary-soft);
  color: var(--app-primary);
}

.overview-project-row:hover .overview-project-locate {
  color: var(--app-primary);
  transform: scale(1.06);
}

@media (max-width: 768px) {
  .workspace-overview {
    padding: 14px;
  }

  .overview-section {
    --overview-section-max-height: 420px;

    min-height: 180px;
  }

  .overview-project-row {
    min-height: 50px;
    gap: 8px;
    padding: 8px;
  }

  .overview-project-icon {
    width: 26px;
    height: 26px;
  }
}
</style>
