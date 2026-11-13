import { ref } from 'vue';
import { api } from '../api';

/***********************运行形态（安装版 / 便携版）*********************/

const portable = ref(false);
let loadTask: Promise<boolean> | null = null;

/**
 * 是否为免安装便携版。
 *
 * 便携版没有 NSIS 安装信息，走原生安装器更新会被“安装”成普通版本，
 * 所以更新入口必须按运行形态分流。首次读取前按安装版处理。
 */
export const isPortableMode = portable;

/** 读取并缓存运行形态；重复调用共享同一次探测 */
export function loadAppMode(): Promise<boolean> {
  if (!loadTask) {
    loadTask = api.isPortableBuild()
      .then((value) => {
        portable.value = value;
        return value;
      })
      .catch((error) => {
        console.error('Failed to detect portable build:', error);
        return false;
      });
  }
  return loadTask;
}
