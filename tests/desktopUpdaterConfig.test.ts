import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const capability = JSON.parse(readFileSync(resolve(root, 'src-tauri/capabilities/default.json'), 'utf8'));
const metadata = readFileSync(resolve(root, 'src-tauri/deb/com.cuteyuchen.project-manager.metainfo.xml'), 'utf8');

assert(config.bundle.createUpdaterArtifacts === true, 'updater artifacts must be enabled');
assert(config.plugins?.updater?.pubkey, 'updater public key must be configured');
assert(
  config.plugins?.updater?.endpoints?.includes('https://github.com/cuteyuchen/project-manager/releases/latest/download/latest.json'),
  'updater endpoint must target the latest release manifest',
);
assert(capability.permissions.includes('updater:default'), 'updater capability must be granted');
assert(capability.permissions.includes('process:allow-restart'), 'restart capability must be granted');
assert(metadata.includes('<icon type="stock">project-manager</icon>'), 'AppStream metadata must reference the package icon');
assert(metadata.includes('<developer id="com.cuteyuchen">'), 'AppStream metadata must include the publisher');
assert(metadata.includes('<project_license>MIT</project_license>'), 'AppStream metadata must include the license');

console.log('desktopUpdaterConfig tests passed');
