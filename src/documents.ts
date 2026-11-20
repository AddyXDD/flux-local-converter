import JSZip from 'jszip';
import { Document, HeadingLevel, ImageRun, PageBreak, Packer, Paragraph, SectionType, TextRun } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import html2canvas from 'html2canvas';
import { renderAsync } from 'docx-preview';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { recognizeCanvas, type OcrPage } from './ocr';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type TextBlock = { text: string; heading?: number };
type Section = { title: string; blocks: TextBlock[] };
type ExtractedDocument = { title: string; sections: Section[] };

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_PACKAGE_EXPANDED = 128 * 1024 * 1024;
const MAX_XML_PART = 16 * 1024 * 1024;
const MAX_OCR_PAGES = 50;
const MAX_PAGE_PIXELS = 12_000_000;
const MAX_PAGE_RENDER_SCALE = 2.25;
const MAX_RASTER_BYTES = 22 * 1024 * 1024;

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type RasterPage = { image: Uint8Array; width: number; height: number; pixelWidth: number; pixelHeight: number; ocr: OcrPage };
type Progress = (message: string) => void;

function checkCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Export canceled.', 'AbortError');
}

function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function xmlDocument(xml: string, description: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(`This ${description} contains invalid XML.`);
  return doc;
}

async function openOfficePackage(file: File, description: string): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error(`This ${description} is damaged or is not a valid Office document.`);
  }
  let expanded = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size === 'number') {
      expanded += size;
      if (expanded > MAX_PACKAGE_EXPANDED || (entry.name.endsWith('.xml') && size > MAX_XML_PART)) {
        throw new Error(`This ${description} expands beyond the safe document limit.`);
      }
    }
  }
  return zip;
}

async function readXml(zip: JSZip, path: string, description: string): Promise<XMLDocument> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`This ${description} is missing ${path}.`);
  const xml = await entry.async('string');
  if (xml.length > MAX_XML_PART) throw new Error(`This ${description} contains an unusually large XML part.`);
  return xmlDocument(xml, description);
}

function elementText(node: Element): string {
  let value = '';
  const walk = (part: Node) => {
    if (part.nodeType === Node.TEXT_NODE) return;
    if (part.nodeType !== Node.ELEMENT_NODE) return;
    const element = part as Element;
    if (element.namespaceURI === WORD_NS && element.localName === 't') value += element.textContent ?? '';
    else if (element.namespaceURI === WORD_NS && element.localName === 'tab') value += '\t';
    else if (element.namespaceURI === WORD_NS && element.localName === 'br') value += '\n';
    else for (const child of [...part.childNodes]) walk(child);
  };
  for (const child of [...node.childNodes]) walk(child);
  return value.replace(/[\t ]+$/g, '').trim();
}

function wordParagraph(node: Element): TextBlock {
  const style = node.getElementsByTagNameNS(WORD_NS, 'pStyle')[0];
  const styleName = style?.getAttributeNS(WORD_NS, 'val') ?? style?.getAttribute('w:val') ?? '';
  const heading = /^Heading([1-6])$/i.exec(styleName);
  return { text: elementText(node), heading: heading ? Number(heading[1]) : undefined };
}

function wordBlocks(container: Element): TextBlock[] {
  const blocks: TextBlock[] = [];
  const walk = (node: Element) => {
    for (const child of [...node.children]) {
      if (child.namespaceURI === WORD_NS && child.localName === 'p') {
        const block = wordParagraph(child);
        if (block.text) blocks.push(block);
      } else if (child.namespaceURI === WORD_NS && child.localName === 'tbl') {
        const rows = [...child.getElementsByTagNameNS(WORD_NS, 'tr')];
        for (const row of rows) {
          const cells = [...row.children].filter(el => el.namespaceURI === WORD_NS && el.localName === 'tc');
          const values = cells.map(cell => [...cell.getElementsByTagNameNS(WORD_NS, 'p')].map(p => elementText(p)).filter(Boolean).join('\n'));
          const text = values.join('  |  ').trim();
          if (text) blocks.push({ text });
        }
      } else if (child.namespaceURI === WORD_NS) walk(child);
    }
  };
  walk(container);
  return blocks;
}

async function readDocx(file: File): Promise<ExtractedDocument> {
  const zip = await openOfficePackage(file, 'Word document');
  if (!zip.file('word/document.xml')) throw new Error('This package does not contain a Word document.');
  const doc = await readXml(zip, 'word/document.xml', 'Word document');
  const body = doc.getElementsByTagNameNS(WORD_NS, 'body')[0];
  if (!body) throw new Error('The Word document has no readable body.');
  const blocks = wordBlocks(body);
  if (!blocks.length) throw new Error('No readable text was found in this Word document.');
  return { title: 'Document', sections: [{ title: 'Document', blocks }] };
}

function resolvePackagePath(base: string, target: string): string {
  const parts: string[] = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const segment of target.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new Error('This presentation contains an invalid internal path.');
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

function presentationParagraphs(slide: XMLDocument): string[] {
  return [...slide.getElementsByTagNameNS(DRAWING_NS, 'p')].map(paragraph => {
    const runs: string[] = [];
    for (const child of [...paragraph.childNodes]) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      if (element.namespaceURI === DRAWING_NS && element.localName === 'r') {
        for (const t of [...element.getElementsByTagNameNS(DRAWING_NS, 't')]) runs.push(t.textContent ?? '');
      } else if (element.namespaceURI === DRAWING_NS && element.localName === 'fld') {
        for (const t of [...element.getElementsByTagNameNS(DRAWING_NS, 't')]) runs.push(t.textContent ?? '');
      } else if (element.namespaceURI === DRAWING_NS && element.localName === 'br') runs.push('\n');
    }
    const text = runs.join('').trim();
    if (!text) return '';
    const props = paragraph.getElementsByTagNameNS(DRAWING_NS, 'pPr')[0];
    const hasBullet = !!props && (props.getElementsByTagNameNS(DRAWING_NS, 'buChar').length > 0 || props.getElementsByTagNameNS(DRAWING_NS, 'buAutoNum').length > 0);
    return hasBullet ? `• ${text}` : text;
  }).filter(Boolean);
}

async function readPptx(file: File): Promise<ExtractedDocument> {
  const zip = await openOfficePackage(file, 'PowerPoint presentation');
  if (!zip.file('ppt/presentation.xml')) throw new Error('This package does not contain a PowerPoint presentation.');
  const presentation = await readXml(zip, 'ppt/presentation.xml', 'PowerPoint presentation');
  const rels = await readXml(zip, 'ppt/_rels/presentation.xml.rels', 'PowerPoint presentation');
  const targets = new Map<string, string>();
  for (const rel of [...rels.getElementsByTagNameNS(PACKAGE_REL_NS, 'Relationship')]) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) targets.set(id, resolvePackagePath('ppt', target));
  }
  const slideIds = [...presentation.getElementsByTagNameNS(PRESENTATION_NS, 'sldId')];
  let paths = slideIds.map(id => targets.get(id.getAttributeNS(REL_NS, 'id') ?? '')).filter((p): p is string => !!p);
  if (!paths.length) {
    paths = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
      .sort((a, b) => Number(/slide(\d+)/i.exec(a)?.[1] ?? 0) - Number(/slide(\d+)/i.exec(b)?.[1] ?? 0));
  }
  if (!paths.length) throw new Error('No readable slides were found in this PowerPoint presentation.');
  if (paths.length > 2000) throw new Error('This presentation has more than 2,000 slides and exceeds the safe limit.');
  const sections: Section[] = [];
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const slide = await readXml(zip, path, 'PowerPoint slide');
    const paragraphs = presentationParagraphs(slide);
    if (paragraphs.length) sections.push({ title: `Slide ${index + 1}`, blocks: paragraphs.map(text => ({ text })) });
  }
  if (!sections.length) throw new Error('No selectable text was found in this presentation. Slides made only from images need OCR, which is not included.');
  return { title: 'Presentation', sections };
}

function pdfLineGroups(items: Array<{ str: string; transform: number[]; width: number }>): string[] {
  const sorted = items.filter(item => item.str.trim()).map(item => ({
    text: item.str,
    x: item.transform[4] ?? 0,
    y: item.transform[5] ?? 0,
    width: item.width ?? 0,
    height: Math.max(1, Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0)),
  })).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; height: number; chunks: typeof sorted }> = [];
  for (const chunk of sorted) {
    let line = lines.find(candidate => Math.abs(candidate.y - chunk.y) <= Math.max(2, Math.min(candidate.height, chunk.height) * 0.28));
    if (!line) {
      line = { y: chunk.y, height: chunk.height, chunks: [] };
      lines.push(line);
    }
    line.chunks.push(chunk);
  }
  return lines.sort((a, b) => b.y - a.y).map(line => {
    const chunks = line.chunks.sort((a, b) => a.x - b.x);
    let result = '';
    let previous: (typeof chunks)[number] | undefined;
    for (const chunk of chunks) {
      const gap = previous ? chunk.x - (previous.x + previous.width) : 0;
      if (previous && gap > Math.max(1.5, chunk.height * 0.12) && !/\s$/.test(result) && !/^\s/.test(chunk.text)) result += ' ';
      result += chunk.text;
      previous = chunk;
    }
    return result.replace(/[\t ]+/g, ' ').trim();
  }).filter(Boolean);
}

async function renderPdfPage(page: PdfPage): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_PAGE_RENDER_SCALE, Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Could not render this PDF page for local OCR.');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
  return { canvas, width: base.width, height: base.height };
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('The rendered page could not be saved as a lossless image.')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const buffer = bytes.buffer;
  const output = buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === buffer.byteLength
    ? buffer
    : bytes.slice().buffer as ArrayBuffer;
  return new Blob([output], { type });
}

async function ocrPdfPage(page: PdfPage): Promise<RasterPage> {
  const rendered = await renderPdfPage(page);
  try {
    const image = await canvasPng(rendered.canvas);
    const ocr = await recognizeCanvas(rendered.canvas);
    return { image, width: rendered.width, height: rendered.height, pixelWidth: rendered.canvas.width, pixelHeight: rendered.canvas.height, ocr };
  } finally {
    rendered.canvas.width = 0;
    rendered.canvas.height = 0;
  }
}

async function openPdf(file: File): Promise<{ pdf: PdfDocument; destroy: () => Promise<void> }> {
  const localAssets = new URL(/* @vite-ignore */ '../pdfjs/', import.meta.url).href;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
    cMapUrl: `${localAssets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${localAssets}standard_fonts/`,
    wasmUrl: `${localAssets}wasm/`,
    iccUrl: `${localAssets}iccs/`,
    useWorkerFetch: true,
  });
  return { pdf: await loading.promise, destroy: () => loading.destroy() };
}

async function readPdf(file: File, onProgress?: Progress, signal?: AbortSignal): Promise<ExtractedDocument> {
  let opened: Awaited<ReturnType<typeof openPdf>> | undefined;
  try {
    opened = await openPdf(file);
    const pdf = opened.pdf;
    if (pdf.numPages > 3000) throw new Error('This PDF has more than 3,000 pages and exceeds the safe limit.');
    const sections: Section[] = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      checkCanceled(signal);
      onProgress?.(`READING PDF PAGE ${pageNo} / ${pdf.numPages}`);
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const textItems = content.items.filter((item): item is typeof item & { str: string; transform: number[]; width: number } => 'str' in item && 'transform' in item);
      let lines = pdfLineGroups(textItems);
      if (!lines.length) {
        if (pageNo > MAX_OCR_PAGES) throw new Error(`This scanned PDF needs OCR beyond the ${MAX_OCR_PAGES}-page limit.`);
        onProgress?.(`OCR PAGE ${pageNo} / ${pdf.numPages} · RUNNING ON THIS DEVICE`);
        const raster = await ocrPdfPage(page);
        lines = raster.ocr.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      }
      if (lines.length) sections.push({ title: `Page ${pageNo}`, blocks: lines.map(text => ({ text })) });
      page.cleanup();
      if (pageNo % 4 === 0) await yieldToUi();
    }
    if (!sections.length) throw new Error('No readable text was found in this PDF, even after offline OCR.');
    return { title: 'PDF', sections };
  } catch (error) {
    if (error instanceof Error && /3,000 pages|exceeds the safe limit|needs OCR|offline OCR|OCR failed|image budget/.test(error.message)) throw error;
    if (import.meta.env.DEV) console.error('PDF smoke diagnostic:', error);
    throw new Error('FLUX could not read this PDF. It may be damaged, password-protected, or use unsupported PDF features.');
  } finally {
    await opened?.destroy();
  }
}

function docxParagraph(block: TextBlock): Paragraph {
  const heading = block.heading ? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][block.heading - 1] : undefined;
  return new Paragraph({ heading, children: [new TextRun({ text: block.text })] });
}

async function asDocx(extracted: ExtractedDocument): Promise<Blob> {
  const children: Paragraph[] = [];
  extracted.sections.forEach((section, sectionIndex) => {
    if (extracted.title === 'Presentation' || extracted.title === 'PDF') {
      if (sectionIndex) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: section.title })] }));
    }
    children.push(...section.blocks.map(docxParagraph));
  });
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBlob(doc);
}

async function renderWordDocument(file: File, onProgress?: Progress, signal?: AbortSignal): Promise<{ host: HTMLDivElement; styleHost: HTMLDivElement; content: HTMLDivElement; pages: HTMLElement[] }> {
  const host = document.createElement('div');
  const styleHost = document.createElement('div');
  const content = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;z-index:-1;background:#fff;color:#000;pointer-events:none;';
  content.style.cssText = 'display:block;background:#fff;';
  host.append(styleHost, content);
  document.body.appendChild(host);
  try {
    checkCanceled(signal);
    onProgress?.('RENDERING WORD PAGE LAYOUT…');
    await renderAsync(file, content, styleHost, {
      useBase64URL: true,
      renderAltChunks: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    });
    checkCanceled(signal);
    const pages = [...content.querySelectorAll<HTMLElement>('section.docx')];
    if (!pages.length) throw new Error('This Word document could not be rendered into pages.');
    if (pages.length > MAX_OCR_PAGES) throw new Error(`This Word document has more than the ${MAX_OCR_PAGES}-page visual conversion limit.`);
    return { host, styleHost, content, pages };
  } catch (error) {
    host.remove();
    throw error;
  }
}

async function captureWordPage(page: HTMLElement, useOcr: boolean, signal?: AbortSignal): Promise<RasterPage> {
  checkCanceled(signal);
  const rect = page.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) throw new Error('A Word page has no printable size.');
  const scale = Math.min(MAX_PAGE_RENDER_SCALE, Math.sqrt(MAX_PAGE_PIXELS / (rect.width * rect.height)));
  const canvas = await html2canvas(page, {
    scale,
    backgroundColor: '#ffffff',
    useCORS: false,
    allowTaint: false,
    logging: false,
    imageTimeout: 5000,
  });
  try {
    const image = await canvasPng(canvas);
    const ocr = useOcr ? await recognizeCanvas(canvas) : { text: '', words: [] };
    checkCanceled(signal);
    page.setAttribute('aria-label', ocr.text ? `OCR text: ${ocr.text.slice(0, 20000)}` : 'Rendered Word page');
    return {
      image,
      width: rect.width * 0.75,
      height: rect.height * 0.75,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height,
      ocr,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function captureWordPages(file: File, onProgress?: Progress, signal?: AbortSignal, useOcr = true): Promise<{ pages: RasterPage[]; rendered: Awaited<ReturnType<typeof renderWordDocument>> }> {
  const rendered = await renderWordDocument(file, onProgress, signal);
  try {
    const pages: RasterPage[] = [];
    let imageBytes = 0;
    for (let i = 0; i < rendered.pages.length; i++) {
      checkCanceled(signal);
      onProgress?.(useOcr ? `OCR WORD PAGE ${i + 1} / ${rendered.pages.length} · RUNNING ON THIS DEVICE` : `RENDERING WORD PAGE ${i + 1} / ${rendered.pages.length}`);
      const page = await captureWordPage(rendered.pages[i], useOcr, signal);
      imageBytes += page.image.byteLength;
      if (imageBytes > MAX_RASTER_BYTES) {
        throw new Error('This page-image export would exceed the safe 22 MB image budget. Try fewer pages or a smaller document.');
      }
      pages.push(page);
      await yieldToUi();
    }
    return { pages, rendered };
  } catch (error) {
    rendered.host.remove();
    throw error;
  }
}

function wordHtml(rendered: Awaited<ReturnType<typeof renderWordDocument>>): string {
  const styles = [...rendered.styleHost.querySelectorAll('style')].map(style => style.textContent ?? '').join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Converted Word document</title><style>html{background:#e7e7e7}body{margin:0;padding:24px;background:#e7e7e7}.docx-wrapper{margin:0 auto}</style><style>${styles}</style></head><body>${rendered.content.innerHTML}</body></html>`;
}

async function asPageImageDocx(pages: RasterPage[]): Promise<Blob> {
  const sections = pages.map((page, index) => ({
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        size: { width: Math.round(page.width * 20), height: Math.round(page.height * 20) },
        margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 },
      },
    },
    children: [
      new Paragraph({
        children: [new ImageRun({
          data: page.image,
          type: 'png',
          transformation: { width: page.width * 96 / 72, height: page.height * 96 / 72 },
          altText: { title: `Page ${index + 1}`, description: page.ocr.text ? `Offline OCR: ${page.ocr.text.slice(0, 20000)}` : `Rendered page ${index + 1}` },
        })],
        spacing: { before: 0, after: 0, line: 1 },
      }),
      ...(page.ocr.text ? [new Paragraph({
        children: [new TextRun({ text: page.ocr.text, vanish: true, size: 1 })],
        run: { vanish: true, specVanish: true },
        spacing: { before: 0, after: 0, line: 1 },
      })] : []),
    ],
  }));
  const document = new Document({ sections });
  return Packer.toBlob(document);
}

async function asRasterPdf(pages: RasterPage[], signal?: AbortSignal): Promise<Blob> {
  const pdf = await PDFDocument.create();
  for (const raster of pages) {
    checkCanceled(signal);
    const page = pdf.addPage([raster.width, raster.height]);
    const image = await pdf.embedPng(raster.image);
    page.drawImage(image, { x: 0, y: 0, width: raster.width, height: raster.height });
    await yieldToUi();
  }
  const bytes = await pdf.save();
  return bytesToBlob(bytes, 'application/pdf');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 0x8000)));
  }
  return btoa(binary);
}

function rasterPagesHtml(pages: RasterPage[]): string {
  const figures = pages.map((page, index) => {
    const alt = page.ocr.text || `Page ${index + 1}`;
    return `<figure><img alt="${escapeHtml(alt)}" src="data:image/png;base64,${base64(page.image)}"><figcaption>Page ${index + 1}</figcaption><span class="ocr">${escapeHtml(alt)}</span></figure>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Faithful page conversion</title><style>html{background:#e7e7e7}body{margin:0;padding:24px;font:14px system-ui,sans-serif;color:#333}figure{position:relative;width:min(100%,8.5in);margin:0 auto 24px;background:#fff;box-shadow:0 2px 14px #0002}img{display:block;width:100%;height:auto}figcaption{text-align:center;padding:8px;color:#666}.ocr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}</style></head><body>${figures}</body></html>`;
}

async function wordText(file: File, onProgress?: Progress, signal?: AbortSignal): Promise<string> {
  try {
    return asText(await readDocx(file));
  } catch (error) {
    if (!(error instanceof Error) || !/No readable text was found/.test(error.message)) throw error;
  }
  const { pages, rendered } = await captureWordPages(file, onProgress, signal);
  rendered.host.remove();
  return pages.map((page, index) => `Page ${index + 1}\n${page.ocr.text}`).join('\n\n') + '\n';
}

async function pdfPagesAsImages(file: File, onProgress?: Progress, signal?: AbortSignal): Promise<RasterPage[]> {
  let opened: Awaited<ReturnType<typeof openPdf>> | undefined;
  try {
    opened = await openPdf(file);
    if (opened.pdf.numPages > MAX_OCR_PAGES) throw new Error(`This PDF has more than the ${MAX_OCR_PAGES}-page visual conversion limit.`);
    const pages: RasterPage[] = [];
    let imageBytes = 0;
    for (let pageNo = 1; pageNo <= opened.pdf.numPages; pageNo++) {
      checkCanceled(signal);
      onProgress?.(`OCR PDF PAGE ${pageNo} / ${opened.pdf.numPages} · RUNNING ON THIS DEVICE`);
      const pdfPage = await opened.pdf.getPage(pageNo);
      try {
        const page = await ocrPdfPage(pdfPage);
        imageBytes += page.image.byteLength;
        if (imageBytes > MAX_RASTER_BYTES) throw new Error('This page-image export would exceed the safe 22 MB image budget. Try fewer pages or a smaller document.');
        pages.push(page);
      } finally {
        pdfPage.cleanup();
      }
      await yieldToUi();
    }
    return pages;
  } finally {
    await opened?.destroy();
  }
}

function asText(extracted: ExtractedDocument): string {
  return extracted.sections.map(section => `${section.title}\n${section.blocks.map(block => block.text).join('\n')}`).join('\n\n') + '\n';
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function asHtml(extracted: ExtractedDocument): string {
  const sections = extracted.sections.map(section => `<section><h2>${escapeHtml(section.title)}</h2>${section.blocks.map(block => block.heading ? `<h${Math.min(block.heading, 6)}>${escapeHtml(block.text)}</h${Math.min(block.heading, 6)}>` : `<p>${escapeHtml(block.text)}</p>`).join('\n')}</section>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FLUX text extraction</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 24px;color:#202124}section{margin:0 0 2.5em}p{white-space:pre-wrap}h2{border-bottom:1px solid #ddd;padding-bottom:.4em}</style></head><body>${sections}</body></html>`;
}

function wrapLine(text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>, size: number, maxWidth: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    let line = '';
    const words = paragraph.split(/\s+/);
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) result.push(line);
      line = '';
      let piece = '';
      for (const char of word) {
        const next = piece + char;
        if (piece && font.widthOfTextAtSize(next, size) > maxWidth) { result.push(piece); piece = char; }
        else piece = next;
      }
      line = piece;
    }
    if (line) result.push(line);
  }
  return result;
}

async function asPdf(extracted: ExtractedDocument): Promise<Blob> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const bodySize = 10.5;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  const addLine = (text: string, isHeading = false) => {
    const font = isHeading ? bold : regular;
    const size = isHeading ? 14 : bodySize;
    for (const line of wrapLine(text, font, size, pageWidth - margin * 2)) {
      if (y < margin + size + 4) { page = pdf.addPage([pageWidth, pageHeight]); y = pageHeight - margin; }
      if (line) page.drawText(line, { x: margin, y, size, font, lineHeight: size * 1.38 });
      y -= size * 1.38;
    }
    y -= isHeading ? 4 : 2;
  };
  try {
    for (const section of extracted.sections) {
      addLine(section.title, true);
      for (const block of section.blocks) addLine(block.text, !!block.heading);
      y -= 8;
    }
    const bytes = await pdf.save();
    return bytesToBlob(bytes, 'application/pdf');
  } catch (error) {
    if (error instanceof Error && /WinAnsi|encode/i.test(error.message)) throw new Error('This PDF export font cannot encode one or more characters in the document. Use DOCX or TXT to preserve its full text.');
    throw error;
  }
}

export async function convertDocument(file: File, sourceExt: string, target: string, onProgress?: Progress, signal?: AbortSignal): Promise<Blob> {
  if (sourceExt === 'pdf' && target === 'docx') return asPageImageDocx(await pdfPagesAsImages(file, onProgress, signal));
  if (sourceExt === 'pdf' && target === 'html') return new Blob([rasterPagesHtml(await pdfPagesAsImages(file, onProgress, signal))], { type: 'text/html;charset=utf-8' });
  if (sourceExt === 'docx' && target === 'pdf') {
    const { pages, rendered } = await captureWordPages(file, onProgress, signal, false);
    try { return await asRasterPdf(pages, signal); } finally { rendered.host.remove(); }
  }
  if (sourceExt === 'docx' && target === 'html') {
    const { pages, rendered } = await captureWordPages(file, onProgress, signal);
    try { return new Blob([wordHtml(rendered)], { type: 'text/html;charset=utf-8' }); } finally { rendered.host.remove(); }
  }
  if (sourceExt === 'docx' && target === 'txt') return new Blob([await wordText(file, onProgress, signal)], { type: 'text/plain;charset=utf-8' });

  let extracted: ExtractedDocument;
  if (sourceExt === 'pdf') extracted = await readPdf(file, onProgress, signal);
  else if (sourceExt === 'pptx') extracted = await readPptx(file);
  else if (sourceExt === 'docx') extracted = await readDocx(file);
  else throw new Error(`.${sourceExt} documents are not supported in this offline build.`);

  if (target === 'docx') return asDocx(extracted);
  if (target === 'txt') return new Blob([asText(extracted)], { type: 'text/plain;charset=utf-8' });
  if (target === 'html') return new Blob([asHtml(extracted)], { type: 'text/html;charset=utf-8' });
  if (target === 'pdf' && sourceExt !== 'pdf') return asPdf(extracted);
  throw new Error(`Conversion from ${sourceExt.toUpperCase()} to ${target.toUpperCase()} is not available.`);
}
