import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const output = join(root, 'public', 'ocr');
const coreOutput = join(output, 'core');
const licenseOutput = join(root, 'public', 'licenses');
const packageRoot = join(root, 'node_modules', 'tesseract.js-core');

await mkdir(coreOutput, { recursive: true });
await mkdir(licenseOutput, { recursive: true });
await copyFile(join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'), join(output, 'worker.min.js'));

const engines = await readdir(packageRoot);
const files = engines.filter(name => /^tesseract-core-(?:(?:relaxedsimd|simd)-)?lstm\.wasm\.js$/.test(name));
if (files.length !== 3) throw new Error(`Expected three local LSTM WASM engines, found ${files.length}.`);
for (const file of files) await copyFile(join(packageRoot, file), join(coreOutput, file));
await copyFile(join(root, 'node_modules', 'tesseract.js', 'LICENSE.md'), join(licenseOutput, 'tesseract.js-Apache-2.0.txt'));
await copyFile(join(packageRoot, 'LICENSE'), join(licenseOutput, 'tesseract.js-core-Apache-2.0.txt'));
await copyFile(join(root, 'node_modules', 'docx-preview', 'LICENSE'), join(licenseOutput, 'docx-preview-Apache-2.0.txt'));
await copyFile(join(root, 'node_modules', 'html2canvas', 'LICENSE'), join(licenseOutput, 'html2canvas-MIT.txt'));
await copyFile(join(root, 'node_modules', 'docx', 'LICENSE'), join(licenseOutput, 'docx-MIT.txt'));
await copyFile(join(root, 'node_modules', 'docx', 'LICENSE'), join(licenseOutput, 'fontkit-MIT.txt'));
await copyFile(join(root, 'node_modules', 'pdf-lib', 'LICENSE.md'), join(licenseOutput, 'pdf-lib-MIT.txt'));
await copyFile(join(root, 'node_modules', 'jszip', 'LICENSE.markdown'), join(licenseOutput, 'jszip-MIT.txt'));
await copyFile(join(root, 'node_modules', 'yaml', 'LICENSE'), join(licenseOutput, 'yaml-ISC.txt'));
await copyFile(join(root, 'THIRD-PARTY-NOTICES.md'), join(licenseOutput, 'THIRD-PARTY-NOTICES.md'));

console.log(`Bundled Tesseract worker and ${files.length} local OCR engines.`);
