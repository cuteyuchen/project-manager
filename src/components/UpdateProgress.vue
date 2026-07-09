<template>
  <div class="app-card fixed bottom-4 right-4 z-50 w-80 p-4 transition-all duration-300">
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-medium text-primary">{{ t('update.downloading') }}</h3>
      <div class="flex items-center gap-2">
        <button 
          @click="$emit('background')" 
          class="app-icon-btn !h-7 !min-w-7"
          :title="t('update.background')"
        >
          <div class="i-mdi-minus" />
        </button>
        <button 
          @click="$emit('cancel')"
          class="app-danger-action !h-7 !px-1"
          :title="t('update.cancel')"
        >
          <div class="i-mdi-close" />
        </button>
      </div>
    </div>
    
    <div class="w-full rounded-full h-2.5 mb-1" style="background: var(--app-surface-soft);">
      <div class="h-2.5 rounded-full transition-all duration-300" style="background: var(--app-primary);" :style="{ width: `${percentage}%` }"></div>
    </div>
    <div class="text-right text-xs text-muted">{{ percentage }}%</div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{
  percentage: number
}>();

defineEmits<{
  (e: 'cancel'): void
  (e: 'background'): void
}>();

const { t } = useI18n();
</script>
