import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', '@hevcjs', 'core', 'dist');
const destination = path.join(root, 'public', 'hevc');
const files = [
  [path.join(source, 'transcode-worker.js'), path.join(destination, 'transcode-worker.js')],
  [path.join(source, 'wasm', 'hevc-decode.js'), path.join(destination, 'hevc-decode.js')],
  [path.join(source, 'wasm', 'hevc-decode.wasm'), path.join(destination, 'hevc-decode.wasm')],
];

await mkdir(destination, { recursive: true });
for (const [from, to] of files) {
  await access(from);
  await copyFile(from, to);
  console.log(`Copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}
console.log('HEVC.js browser assets are ready.');
