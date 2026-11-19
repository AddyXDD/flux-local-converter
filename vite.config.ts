import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

function bundledPdfAssets(): Plugin {
  return {
    name: 'bundled-pdfjs-assets',
    apply: 'build',
    async generateBundle() {
      const root = join(process.cwd(), 'node_modules', 'pdfjs-dist');
      for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        const directory = join(root, folder);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const source = await readFile(join(directory, entry.name));
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${entry.name}`, source });
        }
      }
    },
  };
}

export default defineConfig({ plugins: [react(), bundledPdfAssets()], clearScreen: false, server: { strictPort: true } });
