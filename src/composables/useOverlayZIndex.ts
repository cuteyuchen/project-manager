import { shallowRef, watch } from 'vue';
import { useZIndex } from 'element-plus';

/***********************统一浮层层级*********************/
/** 自定义浮层与 Dialog、Select、MessageBox 共用层级计数，每次打开都重新置顶。 */
export function useOverlayZIndex(visible: () => boolean) {
  const { nextZIndex } = useZIndex();
  const zIndex = shallowRef(0);

  watch(visible, (opened) => {
    if (opened) zIndex.value = nextZIndex();
  }, { immediate: true, flush: 'sync' });

  return zIndex;
}
