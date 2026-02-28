import type { PlatformAPI, ProjectInfo, TerminalInfo } from '../types';
import type { NodeVersion, GitStatusResult, GitBranch, GitCommit, GitRemote, GitStashEntry, GitTag } from '../../types';

// Declare global interface for uTools services
declare global {
  interface Window {
    services: PlatformAPI;
  }
}

export class UToolsAdapter implements PlatformAPI {
  private get service() {
    if (!window.services) {
        console.warn('uTools services not found on window object. Are you running in uTools?');
        // Return a mock or throw? Throwing is better to catch issues.
        // For development outside uTools but selecting this adapter, we might fail.
        throw new Error('uTools services not initialized');
    }
    return window.services;
  }

  getNvmList(): Promise<NodeVersion[]> { return this.service.getNvmList(); }
  installNode(version: string): Promise<string> { return this.service.installNode(version); }
  uninstallNode(version: string): Promise<string> { return this.service.uninstallNode(version); }
  useNode(version: string): Promise<string> { return this.service.useNode(version); }
  getSystemNodePath(): Promise<string> { return this.service.getSystemNodePath(); }
  getNodeVersion(path: string): Promise<string> { return this.service.getNodeVersion(path); }

  scanProject(path: string): Promise<ProjectInfo> { return this.service.scanProject(path); }

  runProjectCommand(id: string, path: string, script: string, packageManager: string, nodePath: string): Promise<void> {
    return this.service.runProjectCommand(id, path, script, packageManager, nodePath);
  }
  stopProjectCommand(id: string): Promise<void> { return this.service.stopProjectCommand(id); }

  openInEditor(path: string, editor?: string): Promise<void> { return this.service.openInEditor(path, editor); }
    openInTerminal(path: string, terminal?: string): Promise<void> {
        if ((this.service as any).openInTerminal) {
            return (this.service as any).openInTerminal(path, terminal);
        }
        return this.service.openFolder(path);
    }
  openFolder(path: string): Promise<void> { return this.service.openFolder(path); }
  openUrl(url: string): Promise<void> { return this.service.openUrl(url); }

  readConfigFile(filename: string): Promise<string> { return this.service.readConfigFile(filename); }
  writeConfigFile(filename: string, content: string): Promise<void> { return this.service.writeConfigFile(filename, content); }
  readTextFile(path: string): Promise<string> { return this.service.readTextFile(path); }
  writeTextFile(path: string, content: string): Promise<void> { return this.service.writeTextFile(path, content); }
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]> { return this.service.readDir(path); }

  installUpdate(url: string): Promise<void> { return this.service.installUpdate(url); }
  cancelUpdate(): Promise<void> { return this.service.cancelUpdate ? this.service.cancelUpdate() : Promise.resolve(); }
  getAppVersion(): Promise<string> { return this.service.getAppVersion(); }

  openDialog(options: any): Promise<string | string[] | null> { return this.service.openDialog(options); }
  saveDialog(options: any): Promise<string | null> { return this.service.saveDialog(options); }

  onProjectOutput(callback: (payload: { id: string; data: string }) => void): Promise<() => void> {
    return this.service.onProjectOutput(callback);
  }
 async onProjectExit(callback: (payload: { id: string }) => void): Promise<() => void> {
    return this.service.onProjectExit(callback);
  }

  async onDownloadProgress(callback: (percentage: number) => void): Promise<() => void> {
      return this.service.onDownloadProgress(callback);
  }

  // Window
  async windowMinimize(): Promise<void> {
      // utools.hideMainWindow();
      return Promise.resolve();
  }

  async windowMaximize(): Promise<void> {
      return Promise.resolve();
  }

  async windowUnmaximize(): Promise<void> {
      return Promise.resolve();
  }

  async windowClose(): Promise<void> {
      // utools.outPlugin();
      return Promise.resolve();
  }

  async windowIsMaximized(): Promise<boolean> {
      return Promise.resolve(true);
  }

  async windowSetAlwaysOnTop(always: boolean): Promise<void> {
      console.log('windowSetAlwaysOnTop', always);
      return Promise.resolve();
  }

  async onWindowResize(callback: () => void): Promise<() => void> {
      console.log('onWindowResize registered', callback);
      return Promise.resolve(() => {});
  }

  // System Integration
  async setContextMenu(_enable: boolean, _locale?: string): Promise<void> {
      // Not supported in uTools
      return Promise.resolve();
  }

  async checkContextMenu(): Promise<boolean> {
      return false;
  }

  async isContextMenuSupported(): Promise<boolean> {
      return Promise.resolve(false);
  }

  async getPlatformInfo(): Promise<{ os: string; arch: string }> {
      // Fallback for uTools if service doesn't provide it
      // Usually uTools runs on Electron, so we might check navigator
      if (this.service.getPlatformInfo) {
          return this.service.getPlatformInfo();
      }
      return Promise.resolve({
          os: navigator.platform.toLowerCase().includes('win') ? 'windows' : 
              navigator.platform.toLowerCase().includes('mac') ? 'macos' : 'linux',
          arch: 'x86_64' // default fallback
      });
  }

  async detectAvailableTerminals(): Promise<TerminalInfo[]> {
      if (this.service.detectAvailableTerminals) {
          return this.service.detectAvailableTerminals();
      }
      return Promise.resolve([
          { id: 'cmd', name: 'Command Prompt (cmd.exe)' }
      ]);
  }

  // Git - Not supported in uTools
  private gitNotSupported(): never {
      throw new Error('Git operations are not supported in uTools');
  }

  async gitCheck(_path: string): Promise<boolean> { return false; }
  async gitInit(_path: string): Promise<string> { this.gitNotSupported(); }
  async gitStatus(_path: string): Promise<GitStatusResult> { this.gitNotSupported(); }
  async gitStage(_path: string, _files: string[]): Promise<string> { this.gitNotSupported(); }
  async gitUnstage(_path: string, _files: string[]): Promise<string> { this.gitNotSupported(); }
  async gitStageAll(_path: string): Promise<string> { this.gitNotSupported(); }
  async gitUnstageAll(_path: string): Promise<string> { this.gitNotSupported(); }
  async gitCommit(_path: string, _message: string): Promise<string> { this.gitNotSupported(); }
  async gitPull(_path: string, _remote?: string, _branch?: string): Promise<string> { this.gitNotSupported(); }
  async gitPush(_path: string, _remote?: string, _branch?: string, _force?: boolean, _setUpstream?: boolean): Promise<string> { this.gitNotSupported(); }
  async gitFetch(_path: string, _remote?: string): Promise<string> { this.gitNotSupported(); }
  async gitBranches(_path: string): Promise<GitBranch[]> { this.gitNotSupported(); }
  async gitCheckout(_path: string, _branch: string): Promise<string> { this.gitNotSupported(); }
  async gitCreateBranch(_path: string, _name: string, _startPoint?: string): Promise<string> { this.gitNotSupported(); }
  async gitDeleteBranch(_path: string, _name: string, _force?: boolean): Promise<string> { this.gitNotSupported(); }
  async gitMerge(_path: string, _branch: string): Promise<string> { this.gitNotSupported(); }
  async gitRebase(_path: string, _branch: string): Promise<string> { this.gitNotSupported(); }
  async gitRmCached(_path: string, _files: string[]): Promise<string> { this.gitNotSupported(); }
  async gitDeleteTag(_path: string, _name: string): Promise<string> { this.gitNotSupported(); }
  async gitApplyPatch(_path: string, _patch: string, _cached?: boolean, _reverse?: boolean): Promise<string> { this.gitNotSupported(); }
  async gitLog(_path: string, _maxCount?: number, _all?: boolean): Promise<GitCommit[]> { this.gitNotSupported(); }
  async gitDiff(_path: string, _file?: string, _staged?: boolean): Promise<string> { this.gitNotSupported(); }
  async gitDiffCommit(_path: string, _hash: string): Promise<string> { this.gitNotSupported(); }
  async gitDiscard(_path: string, _files: string[]): Promise<string> { this.gitNotSupported(); }
  async gitDiscardUntracked(_path: string, _files: string[]): Promise<string> { this.gitNotSupported(); }
  async gitStashSave(_path: string, _message?: string): Promise<string> { this.gitNotSupported(); }
  async gitStashPop(_path: string, _index?: number): Promise<string> { this.gitNotSupported(); }
  async gitStashApply(_path: string, _index?: number): Promise<string> { this.gitNotSupported(); }
  async gitStashDrop(_path: string, _index: number): Promise<string> { this.gitNotSupported(); }
  async gitStashList(_path: string): Promise<GitStashEntry[]> { this.gitNotSupported(); }
  async gitRemoteList(_path: string): Promise<GitRemote[]> { this.gitNotSupported(); }
  async gitCurrentBranch(_path: string): Promise<string> { this.gitNotSupported(); }
  async gitTags(_path: string): Promise<GitTag[]> { this.gitNotSupported(); }
}
