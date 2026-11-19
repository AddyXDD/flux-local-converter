import Tesseract from 'tesseract.js';

export type OcrWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

export type OcrPage = { text: string; words: OcrWord[] };

type OcrWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;
let workerPromise: Promise<OcrWorker> | undefined;

function localAsset(path: string): string {
  return new URL(path, window.location.href).href;
}

async function getWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      workerPath: localAsset('/ocr/worker.min.js'),
      corePath: localAsset('/ocr/core/'),
      langPath: localAsset('/ocr/lang/'),
      cacheMethod: 'none',
      gzip: true,
      workerBlobURL: false,
      legacyCore: false,
      legacyLang: false,
      errorHandler: error => console.error('Offline OCR engine error:', error),
    }).then(async worker => {
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '180' });
      return worker;
    }).catch(error => {
      workerPromise = undefined;
      throw new Error(`The bundled offline OCR engine could not start: ${error instanceof Error ? error.message : 'initialization failed'}`);
    });
  }
  return workerPromise;
}

export async function recognizeCanvas(canvas: HTMLCanvasElement): Promise<OcrPage> {
  const worker = await getWorker();
  let result: Awaited<ReturnType<OcrWorker['recognize']>>;
  try {
    result = await worker.recognize(canvas, { rotateAuto: true }, {
      text: true,
      blocks: true,
      layoutBlocks: false,
      hocr: false,
      tsv: false,
      box: false,
      unlv: false,
      osd: false,
      pdf: false,
      imageColor: false,
      imageGrey: false,
      imageBinary: false,
      debug: false,
    });
  } catch (error) {
    throw new Error(`Offline English OCR failed: ${error instanceof Error ? error.message : 'recognition failed'}`);
  }
  const text = result.data.text.trim();
  const words = (result.data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)))
    .filter(word => word.text.trim() && word.confidence >= 20).map(word => ({
    text: word.text.trim(),
    confidence: word.confidence,
    bbox: word.bbox,
  }));
  return { text, words };
}

export async function stopOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = undefined;
  try { await (await pending).terminate(); } catch { /* already stopped */ }
}
