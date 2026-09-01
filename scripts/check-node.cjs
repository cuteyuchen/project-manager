const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major >= 22 || (major === 20 && minor >= 19);

if (!supported) {
  console.error(
    [
      '[Project Manager] Unsupported Node.js runtime.',
      `Detected: ${process.version} (${process.execPath})`,
      'Required by the current Vite/dependency set: Node 20.19+ or 22+ (Node 21 is not supported).',
      'Please switch to Node 20.19+ or Node 22+ (Node 22 LTS is recommended) and run the command again.',
    ].join('\n'),
  );
  process.exitCode = 1;
}
