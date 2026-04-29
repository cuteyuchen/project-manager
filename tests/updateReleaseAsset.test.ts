type PlatformInfo = {
  os: string;
  arch: string;
};

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

import { selectReleaseAsset } from '../src/utils/updateReleaseAsset';

/***********************测试辅助函数*********************/

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createAsset(name: string): ReleaseAsset {
  return {
    name,
    browser_download_url: `https://example.com/${name}`,
  };
}

/***********************Windows 资产选择*********************/

{
  const asset = selectReleaseAsset(
    {
      os: 'windows',
      arch: 'x86_64',
    },
    [
      createAsset('project-manager_1.1.2_x64-setup.exe'),
      createAsset('project-manager_1.1.2_x64.msi'),
    ],
  );

  assert(asset?.name === 'project-manager_1.1.2_x64-setup.exe', 'windows should prefer setup exe asset');
}

/***********************macOS 资产选择*********************/

{
  const asset = selectReleaseAsset(
    {
      os: 'macos',
      arch: 'aarch64',
    },
    [
      createAsset('Project Manager_1.1.2_x64.dmg'),
      createAsset('Project Manager_1.1.2_aarch64.dmg'),
    ],
  );

  assert(asset?.name === 'Project Manager_1.1.2_aarch64.dmg', 'macos should select dmg matching arch');
}

/***********************Linux 资产选择*********************/

{
  const asset = selectReleaseAsset(
    {
      os: 'linux',
      arch: 'x86_64',
    },
    [
      createAsset('project-manager_1.1.2_amd64.deb'),
      createAsset('project-manager_1.1.2_amd64.AppImage'),
    ],
  );

  assert(asset?.name === 'project-manager_1.1.2_amd64.AppImage', 'linux should prefer AppImage asset');
}

/***********************无法匹配时返回空*********************/

{
  const asset = selectReleaseAsset(
    {
      os: 'windows',
      arch: 'x86_64',
    },
    [
      createAsset('project-manager_1.1.2_arm64-setup.exe'),
    ],
  );

  assert(asset === null, 'mismatched arch should not produce a release asset');
}

console.log('updateReleaseAsset tests passed');
