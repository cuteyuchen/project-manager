export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif']);

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'geojson', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf',
  'env', 'sh', 'bat', 'cmd', 'ps1', 'py', 'rs', 'go', 'java', 'kt', 'c', 'cc', 'cpp', 'h',
  'hpp', 'cs', 'swift', 'rb', 'php', 'log', 'csv', 'sql', 'gitignore', 'editorconfig',
  'npmrc', 'nvmrc', 'prettierrc', 'eslintrc',
]);

const TEXT_BASENAMES = new Set([
  'license', 'licence', 'copying', 'copyright', 'notice', 'authors', 'contributors',
  'readme', 'changelog', 'changes', 'history', 'makefile', 'dockerfile', 'jenkinsfile',
  'procfile', 'gemfile', 'rakefile', 'vagrantfile', 'brewfile', 'justfile', 'taskfile',
  '.gitignore', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
  '.gitattributes', '.gitmodules', '.dockerignore', '.prettierignore', '.eslintignore',
  '.stylelintignore',
]);

const TEXT_BASENAME_VARIANTS = [
  /^(?:license|licence)-(?:mit|apache(?:-2\.0)?|bsd(?:-[23]-clause)?|gpl(?:-[23](?:\.0)?)?|lgpl(?:-[23](?:\.0)?)?|mpl(?:-2\.0)?|isc|unlicense)$/i,
  /^copying\.lesser$/i,
  /^notice-third-party$/i,
];

function isTextBasename(name: string): boolean {
  const lowerName = name.toLowerCase();
  return TEXT_BASENAMES.has(lowerName) || TEXT_BASENAME_VARIANTS.some(pattern => pattern.test(name));
}

export type FileKind = 'image' | 'text' | 'binary';

export function fileExtension(pathOrName: string): string {
  const name = pathOrName.replace(/\\/g, '/').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isImageFile(pathOrName: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(pathOrName));
}

export function isTextFile(pathOrName: string): boolean {
  const name = pathOrName.replace(/\\/g, '/').split('/').pop() || '';
  if (/^\.env(?:\.|$)/i.test(name)) return true;
  if (isTextBasename(name)) return true;
  return TEXT_EXTENSIONS.has(fileExtension(name));
}

export function fileKind(pathOrName: string): FileKind {
  if (isImageFile(pathOrName)) return 'image';
  if (isTextFile(pathOrName)) return 'text';
  return 'binary';
}

export function mimeForFile(pathOrName: string): string {
  switch (fileExtension(pathOrName)) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

export interface FileIconOptions {
  folderStyle?: 'outline' | 'solid';
}

export function getFileIconClass(pathOrName: string, isDirectory?: boolean, options?: FileIconOptions): string {
  if (isDirectory) {
    return options?.folderStyle === 'solid'
      ? 'i-mdi-folder text-amber-500'
      : 'i-mdi-folder-outline text-amber-500';
  }

  const name = pathOrName.replace(/\\/g, '/').split('/').pop() || '';

  // Special named config / system files
  if (/^\.env(?:\..*)?$/i.test(name)) return 'i-mdi-key-variant text-amber-500';
  if (/^package(?:-lock)?\.json$/i.test(name) || /^(?:pnpm-lock\.yaml|yarn\.lock|\.npmrc)$/i.test(name)) {
    return 'i-mdi-npm text-red-500';
  }
  if (/^cargo\.(?:toml|lock)$/i.test(name)) return 'i-mdi-language-rust text-amber-600';
  if (/^go\.(?:mod|sum|work)$/i.test(name)) return 'i-mdi-language-go text-cyan-500';
  if (/^(?:gemfile|rakefile)$/i.test(name)) return 'i-mdi-language-ruby text-red-500';
  if (/^composer\.(?:json|lock)$/i.test(name)) return 'i-mdi-language-php text-indigo-400';
  if (/^\.git(?:ignore|attributes|modules)$/i.test(name)) return 'i-mdi-git text-orange-500';
  if (/^dockerfile(?:\..*)?$/i.test(name) || /^docker-compose(?:\..*)?\.ya?ml$/i.test(name) || name.toLowerCase() === '.dockerignore') {
    return 'i-mdi-docker text-blue-500';
  }
  if (/^(?:license|licence|copying)(?:\..*)?$/i.test(name)) return 'i-mdi-certificate text-amber-500';
  if (/^(?:tsconfig|jsconfig)(?:\..*)?\.json$/i.test(name)) return 'i-mdi-language-typescript text-blue-500';

  const ext = fileExtension(name);

  switch (ext) {
    // Office & Documents
    case 'doc':
    case 'docx':
    case 'dot':
    case 'dotx':
    case 'rtf':
    case 'odt':
      return 'i-mdi-file-word-box text-blue-600';

    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'csv':
    case 'tsv':
    case 'ods':
      return 'i-mdi-file-excel-box text-emerald-600';

    case 'ppt':
    case 'pptx':
    case 'pot':
    case 'potx':
    case 'pps':
    case 'ppsx':
    case 'odp':
      return 'i-mdi-file-powerpoint-box text-orange-500';

    case 'pdf':
      return 'i-mdi-file-pdf-box text-red-500';

    // Archives / Compressed
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'tgz':
    case 'bz2':
    case 'bzip2':
    case 'xz':
    case 'zst':
    case 'iso':
    case 'cab':
    case 'dmg':
      return 'i-mdi-folder-zip text-purple-500';

    // JSON & Data
    case 'json':
    case 'jsonc':
    case 'json5':
    case 'geojson':
      return 'i-mdi-code-json text-amber-500';

    case 'yaml':
    case 'yml':
      return 'i-mdi-file-code-outline text-rose-400';

    case 'xml':
    case 'xsl':
    case 'xslt':
    case 'plist':
      return 'i-mdi-xml text-orange-400';

    case 'toml':
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'properties':
      return 'i-mdi-cog-outline text-slate-400';

    case 'sql':
    case 'sqlite':
    case 'sqlite3':
    case 'db':
    case 'db3':
      return 'i-mdi-database text-cyan-500';

    // Frontend & Web
    case 'vue':
      return 'i-mdi-vuejs text-green-500';
    case 'jsx':
    case 'tsx':
      return 'i-mdi-react text-cyan-400';
    case 'ts':
    case 'mts':
    case 'cts':
      return 'i-mdi-language-typescript text-blue-500';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'i-mdi-language-javascript text-yellow-500';
    case 'html':
    case 'htm':
      return 'i-mdi-language-html5 text-orange-500';
    case 'css':
      return 'i-mdi-language-css3 text-blue-400';
    case 'scss':
    case 'sass':
    case 'less':
    case 'styl':
      return 'i-mdi-language-css3 text-pink-400';
    case 'md':
    case 'markdown':
    case 'mdown':
    case 'mkdn':
      return 'i-mdi-language-markdown text-slate-500';

    // Programming Languages
    case 'py':
    case 'pyw':
    case 'ipynb':
      return 'i-mdi-language-python text-blue-400';
    case 'rs':
      return 'i-mdi-language-rust text-amber-600';
    case 'go':
      return 'i-mdi-language-go text-cyan-500';
    case 'java':
    case 'jar':
    case 'class':
      return 'i-mdi-language-java text-red-500';
    case 'kt':
    case 'kts':
      return 'i-mdi-language-kotlin text-purple-500';
    case 'c':
    case 'h':
      return 'i-mdi-language-c text-blue-500';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'hxx':
      return 'i-mdi-language-cpp text-blue-600';
    case 'cs':
      return 'i-mdi-language-csharp text-emerald-500';
    case 'php':
      return 'i-mdi-language-php text-indigo-400';
    case 'rb':
      return 'i-mdi-language-ruby text-red-500';
    case 'swift':
      return 'i-mdi-language-swift text-orange-500';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'bat':
    case 'cmd':
    case 'ps1':
      return 'i-mdi-console text-emerald-400';

    // Media
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'aac':
    case 'ogg':
    case 'm4a':
    case 'wma':
      return 'i-mdi-file-music text-purple-400';
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'wmv':
    case 'flv':
    case 'webm':
    case 'm4v':
      return 'i-mdi-file-video text-rose-400';

    // Security / Keys
    case 'pem':
    case 'crt':
    case 'cer':
    case 'der':
    case 'pfx':
    case 'p12':
    case 'key':
    case 'pub':
      return 'i-mdi-key-variant text-amber-500';

    default:
      if (isImageFile(name)) return 'i-mdi-file-image-outline text-pink-500';
      if (isTextFile(name)) return 'i-mdi-file-document-outline text-slate-400';
      return 'i-mdi-file-outline text-slate-400';
  }
}
