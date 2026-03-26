<script setup lang="ts">
import { computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import type { Project } from '../../types';

defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const diffContent = computed(() => gitStore.selectedDiff);
const diffFile = computed(() => gitStore.selectedDiffFile);

interface DiffLine {
  type: 'header' | 'add' | 'del' | 'context' | 'hunk' | 'meta';
  content: string;
  oldNum?: number;
  newNum?: number;
}

const parsedLines = computed((): DiffLine[] => {
  const raw = diffContent.value;
  if (!raw) return [];

  const result: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'meta', content: line });
    } else if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)/);
      if (match) {
        oldNum = parseInt(match[1]) - 1;
        const newMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        newNum = newMatch ? parseInt(newMatch[1]) - 1 : oldNum;
      }
      result.push({ type: 'hunk', content: line });
    } else if (line.startsWith('+')) {
      newNum++;
      result.push({ type: 'add', content: line.slice(1), newNum });
    } else if (line.startsWith('-')) {
      oldNum++;
      result.push({ type: 'del', content: line.slice(1), oldNum });
    } else {
      oldNum++;
      newNum++;
      result.push({
        type: 'context',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldNum,
        newNum,
      });
    }
  }

  return result;
});

const stats = computed(() => {
  let adds = 0;
  let dels = 0;
  for (const line of parsedLines.value) {
    if (line.type === 'add') adds++;
    else if (line.type === 'del') dels++;
  }
  return { adds, dels };
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- No diff selected -->
    <div v-if="!diffContent" class="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 gap-1">
      <div class="i-mdi-file-document-outline text-2xl" />
      <span class="text-[11px]">{{ t('git.selectFileToView') }}</span>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-slate-200/40 dark:border-slate-700/30 shrink-0 text-[11px]">
        <span class="font-medium text-slate-700 dark:text-slate-300 truncate flex-1">{{ diffFile || t('git.commitDetail') }}</span>
        <span class="text-green-500 font-mono">+{{ stats.adds }}</span>
        <span class="text-red-500 font-mono">-{{ stats.dels }}</span>
      </div>

      <!-- Diff content -->
      <div class="flex-1 overflow-auto font-mono text-[11px] leading-[18px]">
        <table class="w-full border-collapse">
          <tbody>
            <tr
              v-for="(line, i) in parsedLines"
              :key="i"
              :class="{
                'bg-green-500/8': line.type === 'add',
                'bg-red-500/8': line.type === 'del',
                'bg-blue-500/5': line.type === 'hunk',
                'bg-slate-500/3': line.type === 'meta',
              }"
            >
              <!-- Line numbers -->
              <td
                v-if="line.type !== 'meta' && line.type !== 'hunk'"
                class="w-[1px] whitespace-nowrap px-1.5 text-right text-slate-400/60 dark:text-slate-500/40 select-none border-r border-slate-200/20 dark:border-slate-700/15"
              >
                {{ line.oldNum || '' }}
              </td>
              <td
                v-if="line.type !== 'meta' && line.type !== 'hunk'"
                class="w-[1px] whitespace-nowrap px-1.5 text-right text-slate-400/60 dark:text-slate-500/40 select-none border-r border-slate-200/20 dark:border-slate-700/15"
              >
                {{ line.newNum || '' }}
              </td>
              <td
                v-if="line.type === 'meta' || line.type === 'hunk'"
                colspan="2"
                class="w-[1px] whitespace-nowrap px-1.5 text-right text-slate-400/40 select-none border-r border-slate-200/20 dark:border-slate-700/15"
              />
              <!-- Content -->
              <td
                class="px-2 whitespace-pre"
                :class="{
                  'text-green-700 dark:text-green-300': line.type === 'add',
                  'text-red-700 dark:text-red-300': line.type === 'del',
                  'text-blue-500/70': line.type === 'hunk',
                  'text-slate-400/60': line.type === 'meta',
                  'text-slate-700 dark:text-slate-300': line.type === 'context',
                }"
              >{{ line.content }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
