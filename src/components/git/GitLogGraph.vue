<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGitStore } from '../../stores/git';
import { useI18n } from 'vue-i18n';
import type { Project, GitCommit } from '../../types';

const props = defineProps<{
  project: Project;
}>();

const { t } = useI18n();
const gitStore = useGitStore();

const loadCount = ref(200);
const selectedCommitHash = ref<string | null>(null);
const showDiffForCommit = ref(false);

const commits = computed(() => gitStore.getCommits(props.project.id));

// Graph colors palette
const GRAPH_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#f97316', // orange
  '#14b8a6', // teal
  '#8b5cf6', // violet
];

// Build graph layout from commits
const graphData = computed(() => {
  const commitList = commits.value;
  if (!commitList.length) return { nodes: [] as GraphLayoutNode[], maxColumns: 0 };

  const nodes: GraphLayoutNode[] = [];
  const activeLanes: (string | null)[] = []; // Each lane holds the hash it's tracking
  const commitToColumn: Record<string, number> = {};
  const commitToColor: Record<string, string> = {};

  for (let i = 0; i < commitList.length; i++) {
    const commit = commitList[i];
    
    // Find which lane this commit should go in
    let column = activeLanes.indexOf(commit.hash);
    
    if (column === -1) {
      // New commit not yet in any lane - find a free lane or add new one
      const freeIdx = activeLanes.indexOf(null);
      if (freeIdx !== -1) {
        column = freeIdx;
        activeLanes[freeIdx] = commit.hash;
      } else {
        column = activeLanes.length;
        activeLanes.push(commit.hash);
      }
    }

    // Assign color based on column
    const color = commitToColor[commit.hash] || GRAPH_COLORS[column % GRAPH_COLORS.length];
    commitToColor[commit.hash] = color;
    commitToColumn[commit.hash] = column;

    // Process parents
    const parentLinks: { hash: string; column: number; color: string }[] = [];
    
    // Clear this lane (the commit has been placed)
    activeLanes[column] = null;

    for (let pi = 0; pi < commit.parents.length; pi++) {
      const parentHash = commit.parents[pi];
      let parentColumn = activeLanes.indexOf(parentHash);
      
      if (parentColumn === -1) {
        // Parent not yet in a lane
        if (pi === 0) {
          // First parent goes in the same column
          activeLanes[column] = parentHash;
          parentColumn = column;
        } else {
          // Other parents get new lanes
          const freeIdx = activeLanes.indexOf(null);
          if (freeIdx !== -1) {
            parentColumn = freeIdx;
            activeLanes[freeIdx] = parentHash;
          } else {
            parentColumn = activeLanes.length;
            activeLanes.push(parentHash);
          }
        }
      } else {
        // Parent already in a lane, will converge
      }

      const parentColor = pi === 0 ? color : GRAPH_COLORS[parentColumn % GRAPH_COLORS.length];
      if (!commitToColor[parentHash]) {
        commitToColor[parentHash] = parentColor;
      }
      
      parentLinks.push({ hash: parentHash, column: parentColumn, color: parentColor });
    }

    // Clean up empty trailing lanes
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    nodes.push({
      hash: commit.hash,
      column,
      color,
      row: i,
      parentLinks,
      activeLaneCount: Math.max(activeLanes.filter(l => l !== null).length, column + 1),
    });
  }

  const maxColumns = Math.max(...nodes.map(n => Math.max(n.column, ...n.parentLinks.map(p => p.column)))) + 1;

  return { nodes, maxColumns: Math.min(maxColumns, 12) };
});

interface GraphLayoutNode {
  hash: string;
  column: number;
  color: string;
  row: number;
  parentLinks: { hash: string; column: number; color: string }[];
  activeLaneCount: number;
}

const ROW_HEIGHT = 28;
const COL_WIDTH = 16;
const NODE_RADIUS = 4;
const GRAPH_PADDING = 12;

const svgWidth = computed(() => (graphData.value.maxColumns * COL_WIDTH) + GRAPH_PADDING * 2);
const svgHeight = computed(() => commits.value.length * ROW_HEIGHT + ROW_HEIGHT);

function nodeX(col: number): number {
  return GRAPH_PADDING + col * COL_WIDTH + COL_WIDTH / 2;
}

function nodeY(row: number): number {
  return ROW_HEIGHT / 2 + row * ROW_HEIGHT;
}

// Generate SVG path for parent connections
function generatePaths(): { d: string; color: string }[] {
  const paths: { d: string; color: string }[] = [];
  const { nodes } = graphData.value;
  const commitIndexMap: Record<string, number> = {};
  
  for (const node of nodes) {
    commitIndexMap[node.hash] = node.row;
  }

  for (const node of nodes) {
    const x1 = nodeX(node.column);
    const y1 = nodeY(node.row);

    for (const parent of node.parentLinks) {
      const parentRow = commitIndexMap[parent.hash];
      if (parentRow === undefined) {
        // Parent not in visible commits, draw line going down
        const x2 = nodeX(parent.column);
        const y2 = svgHeight.value;
        if (node.column === parent.column) {
          paths.push({ d: `M ${x1} ${y1} L ${x2} ${y2}`, color: parent.color });
        } else {
          const midY = y1 + ROW_HEIGHT / 2;
          paths.push({ d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y1 + ROW_HEIGHT}`, color: parent.color });
          paths.push({ d: `M ${x2} ${y1 + ROW_HEIGHT} L ${x2} ${y2}`, color: parent.color });
        }
        continue;
      }

      const x2 = nodeX(parent.column);
      const y2 = nodeY(parentRow);

      if (node.column === parent.column) {
        // Straight line
        paths.push({ d: `M ${x1} ${y1} L ${x2} ${y2}`, color: parent.color });
      } else {
        // Bezier curve for branch/merge
        const midY = (y1 + y2) / 2;
        paths.push({
          d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
          color: parent.color,
        });
      }
    }
  }

  return paths;
}

const svgPaths = computed(() => generatePaths());

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) {
        const mins = Math.floor(diff / (1000 * 60));
        return `${mins}m ago`;
      }
      return `${hours}h ago`;
    }
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  } catch {
    return dateStr;
  }
}

function parseRefs(refs: string[]): { type: 'branch' | 'tag' | 'head' | 'remote'; name: string }[] {
  return refs.map(ref => {
    if (ref.startsWith('HEAD -> ')) {
      return { type: 'head', name: ref.replace('HEAD -> ', '') };
    }
    if (ref.startsWith('tag: ')) {
      return { type: 'tag', name: ref.replace('tag: ', '') };
    }
    if (ref.includes('/')) {
      return { type: 'remote', name: ref };
    }
    return { type: 'branch', name: ref };
  });
}

function getRefClass(type: string): string {
  switch (type) {
    case 'head': return 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30';
    case 'branch': return 'bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30';
    case 'tag': return 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30';
    case 'remote': return 'bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30';
    default: return 'bg-slate-200 text-slate-600';
  }
}

async function handleSelectCommit(commit: GitCommit) {
  selectedCommitHash.value = commit.hash;
  try {
    await gitStore.getDiffCommit(props.project.path, commit.hash);
    showDiffForCommit.value = true;
  } catch (e) {
    console.error('Failed to get commit diff:', e);
  }
}

async function handleLoadMore() {
  loadCount.value += 200;
  await gitStore.refreshLog(props.project.id, props.project.path, loadCount.value);
}

// ─── Scroll to branch (called from sidebar click) ───────────────────────────
const scrollContainerRef = ref<HTMLElement | null>(null);

function scrollToBranch(branchName: string) {
  const target = branchName.replace(/^HEAD -> /, '');
  const idx = commits.value.findIndex(c =>
    c.refs.some(r => {
      const cleanRef = r.replace(/^HEAD -> /, '');
      return cleanRef === target || cleanRef.endsWith('/' + target);
    })
  );
  if (idx === -1) return;
  const y = idx * ROW_HEIGHT;
  scrollContainerRef.value?.scrollTo({ top: Math.max(0, y - 80), behavior: 'smooth' });
  selectedCommitHash.value = commits.value[idx].hash;
}

defineExpose({ scrollToBranch });
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Commit list with graph -->
    <div ref="scrollContainerRef" class="flex-1 overflow-auto custom-scrollbar">
      <div v-if="commits.length === 0" class="flex items-center justify-center h-full text-slate-400">
        <div class="text-center">
          <div class="i-mdi-source-commit text-5xl opacity-20 mx-auto mb-3" />
          <p class="text-sm">{{ t('git.noCommits') }}</p>
        </div>
      </div>

      <div v-else class="relative" :style="{ minHeight: svgHeight + 'px' }">
        <!-- SVG graph layer -->
        <svg class="absolute top-0 left-0 pointer-events-none" 
          :width="svgWidth" :height="svgHeight"
          :viewBox="`0 0 ${svgWidth} ${svgHeight}`">
          <!-- Connection lines -->
          <path v-for="(path, i) in svgPaths" :key="'path-' + i"
            :d="path.d"
            :stroke="path.color"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
          />
          <!-- Commit nodes -->
          <circle v-for="node in graphData.nodes" :key="'node-' + node.hash"
            :cx="nodeX(node.column)"
            :cy="nodeY(node.row)"
            :r="NODE_RADIUS"
            :fill="node.color"
            stroke="white"
            stroke-width="1.5"
            class="dark:stroke-slate-900"
          />
        </svg>

        <!-- Commit rows -->
        <div v-for="commit in commits" :key="commit.hash"
          @click="handleSelectCommit(commit)"
          class="flex items-center h-7 hover:bg-slate-100/80 dark:hover:bg-slate-800/30 cursor-pointer transition-colors text-xs border-b border-slate-100 dark:border-slate-800/30"
          :class="{ 'bg-blue-50 dark:bg-blue-900/10': selectedCommitHash === commit.hash }"
          :style="{ paddingLeft: svgWidth + 'px' }">
          
          <!-- Hash -->
          <span class="w-16 font-mono text-[10px] text-blue-500 flex-shrink-0 px-2">{{ commit.short_hash }}</span>
          
          <!-- Refs -->
          <div class="flex items-center gap-1 flex-shrink-0 mr-2">
            <span v-for="ref in parseRefs(commit.refs)" :key="ref.name"
              class="px-1.5 py-0 rounded text-[9px] font-medium border"
              :class="getRefClass(ref.type)">
              {{ ref.name }}
            </span>
          </div>
          
          <!-- Message -->
          <span class="flex-1 truncate text-slate-700 dark:text-slate-300 min-w-0">{{ commit.message }}</span>
          
          <!-- Author -->
          <span class="w-24 truncate text-slate-400 text-[10px] px-2 flex-shrink-0 text-right">{{ commit.author }}</span>
          
          <!-- Date -->
          <span class="w-20 text-slate-400 text-[10px] px-2 flex-shrink-0 text-right">{{ formatDate(commit.date) }}</span>
        </div>

        <!-- Load more -->
        <div v-if="commits.length >= loadCount"
          @click="handleLoadMore"
          class="flex items-center justify-center py-3 text-xs text-blue-500 hover:text-blue-600 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30">
          <div class="i-mdi-dots-horizontal mr-1" />
          {{ t('git.loadMore') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dark circle {
  stroke: #0f172a;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 4px;
}
.dark .custom-scrollbar::-webkit-scrollbar-thumb {
  background: #334155;
}
</style>
