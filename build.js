import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexHtmlPath = path.resolve(__dirname, 'index.html');
const distDir = path.resolve(__dirname, 'dist');
const srcAssetsDir = path.resolve(__dirname, 'src/assets');
const distAssetsDir = path.resolve(distDir, 'src/assets');

const html = fs.readFileSync(indexHtmlPath, 'utf8');

const scriptRegex = /<script(?![^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let scriptIndex = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  scriptIndex += 1;
  const code = match[1];
  if (code.trim()) {
    new vm.Script(code, { filename: `index.html#script-${scriptIndex}` });
  }
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(indexHtmlPath, path.join(distDir, 'index.html'));

if (fs.existsSync(srcAssetsDir)) {
  fs.cpSync(srcAssetsDir, distAssetsDir, { recursive: true, force: true });
}

console.log(`Built ProPlay single-file static bundle into ${distDir} (checked ${scriptIndex} inline script block).`);
