import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pdfPath = resolve(__dirname, '../src/assets/DangThoBach_EN.pdf');
const data = new Uint8Array(readFileSync(pdfPath));

const loadingTask = pdfjsLib.getDocument({ data });
const doc = await loadingTask.promise;

let fullText = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const pageText = content.items.map((item) => item.str).join(' ');
  fullText += pageText + '\n\n';
}

import { writeFileSync } from 'fs';
writeFileSync(resolve(__dirname, './extracted-cv.txt'), fullText, 'utf-8');
console.log('PDF text extracted to scripts/extracted-cv.txt successfully!');
