<script setup lang="ts">
/**
 * 健康状态徽标：在项目卡片右上角显示小圆点。
 *
 * 颜色只反映「环境异常」（影响能不能用）：
 * 绿=正常、黄=环境告警、红=环境错误、灰=未知。
 * Git 未提交改动 / 未初始化 Git 属于状态提示，不改变圆点颜色，
 * 只在 tooltip 里以弱化样式列出，避免与「Git 改动」计数各说各话。
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProjectHealthSnapshot, ProjectHealthIssue } from '../../types';

const props = defineProps<{
  snapshot?: ProjectHealthSnapshot;
  level: 'healthy' | 'warn' | 'error' | 'unknown';
}>();

const { t } = useI18n();

/** 圆点颜色 class */
const dotClass = computed(() => {
  switch (props.level) {
    case 'healthy': return 'bg-emerald-400';
    case 'warn': return 'bg-amber-400';
    case 'error': return 'bg-red-400';
    default: return 'bg-slate-300 dark:bg-slate-600';
  }
});

/** 环境异常：影响使用的真实问题 */
const environmentIssues = computed<ProjectHealthIssue[]>(() => {
  if (!props.snapshot) return [];
  return props.snapshot.issues.filter(
    (issue: ProjectHealthIssue) => issue.code !== 'not_git' && issue.code !== 'git_dirty',
  );
});

/** 状态提示：只是当前工作区状态，不算异常 */
const statusHints = computed<ProjectHealthIssue[]>(() => {
  if (!props.snapshot) return [];
  return props.snapshot.issues.filter(
    (issue: ProjectHealthIssue) => issue.code === 'not_git' || issue.code === 'git_dirty',
  );
});

/** 是否显示 tooltip */
const showTooltip = computed(
  () => environmentIssues.value.length > 0 || statusHints.value.length > 0,
);
</script>

<template>
  <el-tooltip v-if="showTooltip" placement="top" :show-after="200">
    <template #content>
      <div class="app-text-meta max-w-56 space-y-0.5">
        <div
          v-for="(issue, idx) in environmentIssues"
          :key="`env-${idx}`"
          class="flex items-center gap-1"
        >
          <div
            class="w-1.5 h-1.5 shrink-0 rounded-full"
            :class="issue.level === 'error' ? 'bg-red-400' : 'bg-amber-400'"
          />
          <span>{{ issue.message }}</span>
        </div>

        <div
          v-if="statusHints.length > 0"
          class="text-slate-400 dark:text-slate-500"
          :class="{ 'mt-1 border-t border-slate-500/20 pt-1': environmentIssues.length > 0 }"
        >
          <div class="mb-0.5">{{ t('dashboard.healthDirtyHint') }}</div>
          <div v-for="(issue, idx) in statusHints" :key="`hint-${idx}`" class="flex items-center gap-1">
            <div class="w-1.5 h-1.5 shrink-0 rounded-full bg-slate-400/60" />
            <span>{{ issue.message }}</span>
          </div>
        </div>
      </div>
    </template>
    <div class="health-badge-dot" :class="dotClass" />
  </el-tooltip>
  <div v-else class="health-badge-dot" :class="dotClass" />
</template>

<style scoped>
.health-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
