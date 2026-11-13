import type { BuiltinCommandId, CustomCommand, Project } from '../types';

/***********************项目命令运行标识*********************/
/**
 * 运行状态和日志按项目 + 命令类型 + 命令 id 分桶，避免同名 script/custom command
 * 共用一个 stable commandKey 后互相停止或覆盖日志。
 */
export type ProjectCommandType = 'script' | 'custom';

export function getProjectCommandKey(type: ProjectCommandType, id: string): string {
  return `${type}:${id}`;
}

export function parseProjectCommandKey(key: string): { type: ProjectCommandType; id: string } | null {
  if (key.startsWith('script:')) {
    return { type: 'script', id: key.slice('script:'.length) };
  }
  if (key.startsWith('custom:')) {
    return { type: 'custom', id: key.slice('custom:'.length) };
  }
  return null;
}

export function getProjectCommandRunId(
  projectId: string,
  type: ProjectCommandType,
  id: string,
): string {
  // 历史函数名保留以避免全仓 churn；返回的是 stable commandKey，不是 unique sessionId。
  return `${projectId}:${getProjectCommandKey(type, id)}`;
}

const AUTO_INSTALL_COMMAND_NAMES = new Set([
  '安装依赖',
  'Install Dependencies',
]);

function getBuiltinCommandLabelByLocale(builtinId: CustomCommand['builtinId'], locale: 'zh' | 'en') {
  if (builtinId === 'install_dependencies') {
    return locale === 'en' ? 'Install Dependencies' : '安装依赖';
  }
  if (builtinId === 'java_run') {
    return locale === 'en' ? 'Run Service' : '启动服务';
  }
  if (builtinId === 'java_install') {
    return locale === 'en' ? 'Install Dependencies' : '安装依赖';
  }
  if (builtinId === 'java_package') {
    return locale === 'en' ? 'Package (skip tests)' : '打包（跳过测试）';
  }
  if (builtinId === 'java_test') {
    return locale === 'en' ? 'Run Tests' : '运行测试';
  }

  return '';
}

export function getInstallDependenciesCommand(packageManager?: Project['packageManager']) {
  switch (packageManager) {
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    case 'cnpm':
      return 'cnpm install';
    case 'npm':
    default:
      return 'npm install';
  }
}

export function getCustomCommandDisplayName(
  command: Pick<CustomCommand, 'name' | 'builtinId'>,
  translate: (key: string) => string,
) {
  if (command.builtinId === 'install_dependencies') {
    return translate('project.installDependencies');
  }
  // Java 预设命令：名称同样按当前语言翻译，不依赖数据里存的字符串
  if (command.builtinId?.startsWith('java_')) {
    return translate(`project.javaCommand.${command.builtinId.slice('java_'.length)}`);
  }

  return command.name;
}

/***********************Java 项目命令组装*********************/

/**
 * 当前是否 Windows。
 *
 * wrapper 的文件名在 Windows 上是 .cmd / .bat，其余平台需要 `./` 前缀，
 * 所以命令组装必须知道平台。用 navigator 判断即可——这里只影响命令字符串，
 * 真正的执行由后端在项目目录里做。
 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? '';
  return /win/i.test(platform);
}

/** Java 项目的一条预设命令 */
export interface JavaCommandPreset {
  /** 内置命令 id，决定显示名如何翻译 */
  builtinId: Extract<BuiltinCommandId, `java_${string}`>;
  args: string;
}

/**
 * Maven 预设。
 * 打包默认跳过测试：装依赖/首次编译时跑全量测试往往要等很久，
 * 需要跑测试的话有独立的 test 条目。
 * 安装依赖用 install 而不是 dependency:go-offline：多模块工程里兄弟模块的
 * SNAPSHOT 只有 install 到本地仓库后才解析得到。
 */
export const MAVEN_COMMAND_PRESETS: JavaCommandPreset[] = [
  { builtinId: 'java_run', args: 'spring-boot:run' },
  { builtinId: 'java_install', args: 'install -DskipTests' },
  { builtinId: 'java_package', args: 'clean package -DskipTests' },
  { builtinId: 'java_test', args: 'test' },
];

/** Gradle 预设 */
export const GRADLE_COMMAND_PRESETS: JavaCommandPreset[] = [
  { builtinId: 'java_run', args: 'bootRun' },
  { builtinId: 'java_install', args: 'build -x test' },
  { builtinId: 'java_package', args: 'build -x test' },
  { builtinId: 'java_test', args: 'test' },
];

/**
 * 取构建工具的可执行文件名。
 *
 * 有 wrapper 就用 wrapper：它锁定了构建工具版本，比依赖机器上装的
 * 全局 mvn / gradle 可靠得多，也免去「本机没装」的问题。
 * Windows 下 wrapper 是 .cmd / .bat，其余平台要带 `./` 前缀。
 */
export function resolveJavaBuildExecutable(
  buildTool: 'maven' | 'gradle',
  hasWrapper: boolean,
  isWindows: boolean,
): string {
  if (!hasWrapper) {
    return buildTool === 'maven' ? 'mvn' : 'gradle';
  }
  if (buildTool === 'maven') {
    return isWindows ? 'mvnw.cmd' : './mvnw';
  }
  return isWindows ? 'gradlew.bat' : './gradlew';
}

/**
 * 组装一条完整的 Java 命令。
 *
 * springBootModule 只对 Maven 生效：聚合工程根 pom 通常没有
 * spring-boot-maven-plugin，直接 `mvn spring-boot:run` 会报
 * “No plugin found for prefix 'spring-boot'”。
 * 用 `-pl <module>` 只让该模块执行 goal；不能加 `-am`，否则上游模块
 * 也会执行 spring-boot:run，同样会报找不到插件。
 * 依赖模块由「安装依赖」先 install 到本地仓库。
 */
export function buildJavaCommand(
  buildTool: 'maven' | 'gradle',
  hasWrapper: boolean,
  isWindows: boolean,
  args: string,
  springBootModule?: string,
): string {
  const executable = resolveJavaBuildExecutable(buildTool, hasWrapper, isWindows);
  const module = springBootModule?.trim();
  const scopedArgs = module && buildTool === 'maven'
    ? `-pl ${module} ${args}`.trim()
    : args;
  return `${executable} ${scopedArgs}`.trim();
}

/**
 * 生成 Java 项目的预设自定义命令。
 *
 * 复用既有的 CustomCommand 结构，运行链路直接走 store 的 runCustomCommand
 * （后端 run_custom_command 已经在项目目录执行任意 shell 命令），
 * 所以 Java 支持不需要新增任何后端命令。
 *
 * 显示名不在这里翻译：只写 builtinId，由 getCustomCommandDisplayName 在渲染时
 * 按当前语言取文案。这样切换语言后已存的命令名也会跟着变，
 * 也免得把 translate 函数塞进这个纯函数。
 */
export function buildJavaPresetCommands(
  buildTool: 'maven' | 'gradle',
  hasWrapper: boolean,
  isWindows: boolean,
  createId: () => string,
  springBootModule?: string,
): CustomCommand[] {
  const presets = buildTool === 'maven' ? MAVEN_COMMAND_PRESETS : GRADLE_COMMAND_PRESETS;
  return presets.map(preset => ({
    id: createId(),
    // name 作为兜底：旧版本或不认识该 builtinId 时至少能看出是什么命令
    name: preset.builtinId,
    builtinId: preset.builtinId,
    command: buildJavaCommand(
      buildTool,
      hasWrapper,
      isWindows,
      preset.args,
      preset.builtinId === 'java_run' ? springBootModule : undefined,
    ),
  }));
}

/** 某个预设在不同 wrapper / 模块写法下的默认命令，用于判断命令是否被用户改过 */
function buildJavaPresetVariants(
  buildTool: 'maven' | 'gradle',
  isWindows: boolean,
  preset: JavaCommandPreset,
  springBootModule?: string,
): Set<string> {
  const variants = new Set<string>();
  for (const hasWrapper of [false, true]) {
    variants.add(buildJavaCommand(buildTool, hasWrapper, isWindows, preset.args));
    if (preset.builtinId === 'java_run' && buildTool === 'maven' && springBootModule) {
      variants.add(buildJavaCommand(buildTool, hasWrapper, isWindows, preset.args, springBootModule));
    }
  }
  return variants;
}

/**
 * 补齐/校正 Java 项目的内置命令。
 *
 * 用途有两个：
 * 1. 老项目升级后补上「安装依赖」按钮；
 * 2. 扫描发现 spring-boot 子模块后，把仍然是默认写法的「启动服务」
 *    改成 `-pl <module> spring-boot:run`。
 *
 * 只改「看起来还是默认值」的命令，用户手动加过参数的一律不动。
 */
export function ensureJavaCommands<T extends Pick<Project, 'type' | 'buildTool' | 'hasWrapper' | 'springBootModule' | 'customCommands'>>(
  project: T,
  installCommandName: string,
  isWindows = isWindowsPlatform(),
): T {
  if (project.type !== 'java' || !project.buildTool) {
    return project;
  }

  const buildTool = project.buildTool;
  const presets = buildJavaPresetCommands(
    buildTool,
    !!project.hasWrapper,
    isWindows,
    () => crypto.randomUUID(),
    project.springBootModule,
  );
  const presetArgs = new Map(
    (buildTool === 'maven' ? MAVEN_COMMAND_PRESETS : GRADLE_COMMAND_PRESETS)
      .map(preset => [preset.builtinId, preset.args]),
  );

  const commands: CustomCommand[] = [];
  let hasInstall = false;

  for (const command of Array.isArray(project.customCommands) ? project.customCommands : []) {
    if (!command.name || !command.command) continue;
    const preset = command.builtinId
      ? presets.find(item => item.builtinId === command.builtinId)
      : undefined;

    if (!preset) {
      commands.push(command);
      continue;
    }

    if (command.builtinId === 'java_install') {
      hasInstall = true;
      // 安装命令总是对齐最新的 wrapper / 参数，避免 mvnw 生成后还跑全局 mvn
      commands.push({ ...command, command: preset.command });
      continue;
    }

    // 只有仍处于默认写法时才跟随构建工具/模块更新，保留用户自改的命令
    const args = presetArgs.get(command.builtinId as JavaCommandPreset['builtinId']) ?? '';
    const variants = buildJavaPresetVariants(
      buildTool,
      isWindows,
      { builtinId: command.builtinId as JavaCommandPreset['builtinId'], args },
      project.springBootModule,
    );
    commands.push(variants.has(command.command) ? { ...command, command: preset.command } : command);
  }

  if (!hasInstall) {
    const installPreset = presets.find(preset => preset.builtinId === 'java_install');
    if (installPreset) {
      // 放在「启动服务」后面，避免抢掉一级页快捷命令的位置
      const runIndex = commands.findIndex(command => command.builtinId === 'java_run');
      const insertAt = runIndex >= 0 ? runIndex + 1 : 0;
      commands.splice(insertAt, 0, { ...installPreset, name: installCommandName });
    }
  }

  return { ...project, customCommands: commands };
}

export function getCustomCommandDisplayNameByLocale(
  command: Pick<CustomCommand, 'name' | 'builtinId'>,
  locale: 'zh' | 'en',
) {
  if (command.builtinId) {
    return getBuiltinCommandLabelByLocale(command.builtinId, locale);
  }

  return command.name;
}

/***********************可运行脚本解析*********************/
/** 与 ConsoleView、一级页快捷命令共用 visibleScripts 白名单语义。 */
export function getRunnableProjectScripts(
  project: Pick<Project, 'type' | 'scripts' | 'visibleScripts'>,
): string[] {
  if (project.type !== 'node' || !project.scripts?.length) return [];
  if (project.visibleScripts?.length) {
    return project.scripts.filter(script => project.visibleScripts!.includes(script));
  }
  return project.scripts;
}

export function ensureNodeInstallCommand<T extends Pick<Project, 'type' | 'packageManager' | 'customCommands'>>(
  project: T,
  installCommandName: string,
): T {
  if (project.type !== 'node') {
    return project;
  }

  const installCommand = getInstallDependenciesCommand(project.packageManager);
  let hasInstallCommand = false;

  const customCommands = (Array.isArray(project.customCommands)
    ? project.customCommands.filter((command) => command.name && command.command)
    : []).map((command) => {
      const isInstallCommand =
        command.builtinId === 'install_dependencies' ||
        (AUTO_INSTALL_COMMAND_NAMES.has(command.name.trim()) &&
          isInstallDependenciesCommand(command.command.trim()));

      if (!isInstallCommand) {
        return command;
      }

      hasInstallCommand = true;
      return {
        ...command,
        builtinId: 'install_dependencies' as const,
        name: command.name || installCommandName,
        command: installCommand,
      };
    });

  if (hasInstallCommand) {
    return {
      ...project,
      customCommands,
    };
  }

  const nextCommands: CustomCommand[] = [
    {
      id: crypto.randomUUID(),
      name: installCommandName,
      command: installCommand,
      builtinId: 'install_dependencies',
    },
    ...customCommands,
  ];

  return {
    ...project,
    customCommands: nextCommands,
  };
}

function isInstallDependenciesCommand(command: string): boolean {
  const installCommands = ['npm install', 'yarn install', 'pnpm install', 'cnpm install'];
  return installCommands.includes(command);
}
