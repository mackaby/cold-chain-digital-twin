// Copies the parts of three.js the dashboard imports into public/vendor so
// both the Node server and Cloudflare serve them as plain static files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'three');
const dst = path.join(root, 'public', 'vendor', 'three');

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(path.join(dst, 'build'), { recursive: true });
fs.copyFileSync(path.join(src, 'build', 'three.module.js'), path.join(dst, 'build', 'three.module.js'));
for (const dir of ['controls', 'postprocessing', 'shaders']) {
  fs.cpSync(path.join(src, 'examples', 'jsm', dir), path.join(dst, 'examples', 'jsm', dir), { recursive: true });
}
console.log('three.js copied to public/vendor/three');
