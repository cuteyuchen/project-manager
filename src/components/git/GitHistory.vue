<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import type { Project, GitCommit } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const selectedCommit = ref<GitCommit | null>(null);
const commits = computed(() => gitStore.history[props.project.id] || []);

async function selectCommit(commit: GitCommit) {
  selectedCommit.value = commit;
  await gitStore.getDiffCommit(props.project.path, commit.hash);
}

async function loadMore() {
  const current = commits.value.length;
  await gitStore.refreshHistory(props.project.id, props.project.path, current + 100);
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / 86400000);

    if (days === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function shortRefs(refs: string[]): string[] {
  return refs
    .map(r => r.replace('HEAD -> ', '').replace('origin/', ''))
    .filter(r => r && r !== 'HEAD');
}

// Clear selection on project change
watch(() => props.project.id, () => {
  selectedCommit.value = null;
  gitStore.clearDiff();
});
</script>

<template>
  <div class="h-full flex flex-col overflow-auto text-[11px]">
    <!-- No commits -->
    <div v-if="commits.length === 0" class="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 gap-1 p-4">
      <div class="i-mdi-source-commit text-2xl" />
      <span>{{ t('git.noCommits') }}</span>
    </div>

    <template v-else>
      <!-- Commit list -->
      <div
        v-for="commit in commits"
        :key="commit.hash"
        @click="selectCommit(commit)"
        class="flex items-start gap-2 px-3 py-2 cursor-pointer border-b border-slate-200/20 dark:border-slate-700/15 transition-colors"
        :class="selectedCommit?.hash === commit.hash
          ? 'bg-blue-500/8'
          : 'hover:bg-slate-100/50 dark:hover:bg-slate-800/20'"
      >
        <!-- Commit dot -->
        <div class="mt-1.5 w-2 h-2 rounded-full shrink-0"
          :class="selectedCommit?.hash === commit.hash ? 'bg-blue-500' : 'bg-slate-400 dark:bg-slate-500'" />

        <!-- Commit info -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="font-medium text-slate-700 dark:text-slate-300 truncate flex-1">{{ commit.message }}</span>
            <span class="text-slate-400 dark:text-slate-500 shrink-0">{{ formatDate(commit.date) }}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5">
            <span class="text-slate-400 dark:text-slate-500">{{ commit.short_hash }}</span>
            <span class="text-slate-400 dark:text-slate-500">{{ commit.author }}</span>
            <span
              v-for="ref in shortRefs(commit.refs)"
              :key="ref"
              class="text-[9px] px-1.5 py-0 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium"
            >{{ ref }}</span>
          </div>
        </div>
      </div>

      <!-- Load more -->
      <div class="px-3 py-2 shrink-0">
        <button
          @click="loadMore"
          class="w-full py-1.5 text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100/50 dark:hover:bg-slate-800/20 rounded-md transition-colors cursor-pointer"
        >
          {{ t('git.loadMore') }}
        </button>
      </div>
    </template>
  </div>
</template>
