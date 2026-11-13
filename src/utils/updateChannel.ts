/***********************更新渠道与产物地址*********************/

export const RELEASES_URL = 'https://github.com/cuteyuchen/project-manager/releases';

/**
 * 便携版更新包地址。
 *
 * 发布流水线把 Windows 便携包命名为
 * `project-manager_<version>_<target>-portable.zip`，与 latest.json 里的版本号一一对应。
 * 这里保持纯函数，便于单测；不依赖运行环境探测。
 */
export function buildPortableDownloadUrl(version: string, target = 'x64'): string {
  const normalized = version.trim().replace(/^v/i, '');
  return `${RELEASES_URL}/download/v${normalized}/project-manager_${normalized}_${target}-portable.zip`;
}
