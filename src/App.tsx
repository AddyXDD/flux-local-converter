import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { availableMonitors, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import { convert, detect, outputName, targetsFor, type FluxFile } from './converter';
import FormatWheel from './FormatWheel';

function errorMessage(cause: unknown, fallback: string) {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  if (cause && typeof cause === 'object' && 'message' in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not prepare the converted file for saving.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not prepare the converted file for saving.'));
        return;
      }
      const separator = reader.result.indexOf(',');
      if (separator < 0) {
        reject(new Error('Could not prepare the converted file for saving.'));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

const OUTPUT_CHUNK_BYTES = 512 * 1024;

function yieldToUi(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function writeOutputInChunks(
  blob: Blob,
  path: string,
  sourcePath: string | null,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<void> {
  const sessionId = await invoke<string>('begin_output_write', {
    path,
    sourcePath,
    totalBytes: blob.size,
  });
  try {
    let nextProgress = 10;
    for (let offset = 0; offset < blob.size; offset += OUTPUT_CHUNK_BYTES) {
      if (signal.aborted) throw new DOMException('Export canceled.', 'AbortError');
      const end = Math.min(blob.size, offset + OUTPUT_CHUNK_BYTES);
      const dataBase64 = await blobToBase64(blob.slice(offset, end));
      await invoke('append_output_chunk', { sessionId, offset, dataBase64 });
      const percent = Math.floor((end / blob.size) * 100);
      if (percent >= nextProgress) {
        onProgress(`SAVING FILE ${percent}%`);
        nextProgress = Math.floor(percent / 10) * 10 + 10;
      }
      await yieldToUi();
    }
    if (signal.aborted) throw new DOMException('Export canceled.', 'AbortError');
    await invoke('finish_output_write', { sessionId });
  } catch (error) {
    await invoke('abort_output_write', { sessionId }).catch(() => undefined);
    throw error;
  }
}

export default function App() {
  const [files, setFiles] = useState<FluxFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [lastFormat, setLastFormat] = useState(() => localStorage.getItem('flux-format') ?? '');
  const input = useRef<HTMLInputElement>(null);
  const cancelController = useRef<AbortController | null>(null);

  useEffect(() => {
    document.body.classList.add('desktop-donut');
    return () => document.body.classList.remove('desktop-donut');
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let mounted = true;
    let readyToSave = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await appWindow.onMoved(({ payload }) => {
          if (readyToSave) {
            try { localStorage.setItem('flux-widget-position', JSON.stringify({ x: payload.x, y: payload.y })); } catch { /* Ignore disabled browser storage. */ }
          }
        });
        const saved = JSON.parse(localStorage.getItem('flux-widget-position') ?? 'null') as { x?: number; y?: number } | null;
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
          const [monitors, size] = await Promise.all([availableMonitors(), appWindow.outerSize()]);
          const fits = monitors.find(monitor => {
            const area = monitor.workArea;
            return saved.x! + size.width > area.position.x + 24
              && saved.x! < area.position.x + area.size.width - 24
              && saved.y! + size.height > area.position.y + 24
              && saved.y! < area.position.y + area.size.height - 24;
          });
          const monitor = fits ?? await primaryMonitor();
          const area = monitor?.workArea;
          if (area) {
            const maxX = Math.max(area.position.x, area.position.x + area.size.width - size.width);
            const maxY = Math.max(area.position.y, area.position.y + area.size.height - size.height);
            const x = Math.min(maxX, Math.max(area.position.x, saved.x!));
            const y = Math.min(maxY, Math.max(area.position.y, saved.y!));
            await appWindow.setPosition(new PhysicalPosition(x, y));
          }
        }
      } catch {
        // A missing or stale saved position simply keeps the default desktop placement.
      }
      readyToSave = true;
      if (!mounted) unlisten?.();
    })();
    return () => { mounted = false; unlisten?.(); };
  }, []);

  const add = useCallback(async (list: FileList | File[]) => {
    const fresh: FluxFile[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      if (file.size > 16 * 1024 * 1024) {
        rejected.push(`${file.name}: files over 16 MB are not supported`);
        continue;
      }
      fresh.push(await detect(file));
    }
    if (fresh.length) {
      setFiles(previous => [...previous, ...fresh]);
      setStatus('');
      setError('');
    }
    if (rejected.length) {
      setStatus(rejected[0]);
      setError(rejected.join('\n'));
    }
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    const fresh: FluxFile[] = [];
    const failures: string[] = [];
    for (const path of paths) {
      try {
        const name = path.split(/[\\/]/).pop() || 'file';
        const info = await stat(path);
        if (info.size > 16 * 1024 * 1024) {
          failures.push(`${name}: files over 16 MB are not supported`);
          continue;
        }
        const bytes = await readFile(path);
        fresh.push(await detect(new File([bytes], name), path));
      } catch (cause) {
        failures.push(`${path.split(/[\\/]/).pop()}: ${cause instanceof Error ? cause.message : 'could not read file'}`);
      }
    }
    if (fresh.length) {
      setFiles(previous => [...previous, ...fresh]);
      setStatus('');
      setError('');
    }
    if (failures.length) {
      setStatus(failures[0]);
      setError(failures.join('\n'));
    }
  }, []);

  const browse = useCallback(async () => {
    if (!isTauri()) {
      input.current?.click();
      return;
    }
    try {
      const selected = await open({ multiple: true, directory: false, title: 'Choose files to convert' });
      if (selected) await addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (cause) {
      setStatus('FILE PICKER FAILED');
      setError(cause instanceof Error ? cause.message : 'Could not open files.');
    }
  }, [addPaths]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void browse();
      } else if (event.key === 'Escape' && cancelController.current) {
        event.preventDefault();
        setStatus('CANCELING EXPORT…');
        cancelController.current.abort();
      } else if (event.key === 'Escape' && !busy) {
        setFiles([]);
        setStatus('');
        setError('');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, browse]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === 'enter' || event.payload.type === 'over') setDragging(true);
      else if (event.payload.type === 'leave') setDragging(false);
      else if (event.payload.type === 'drop') {
        setDragging(false);
        void addPaths(event.payload.paths);
      }
    }).then(stop => { unlisten = stop; });
    return () => unlisten?.();
  }, [addPaths]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let mounted = true;
    const loadPending = async () => {
      try {
        const paths = await invoke<string[]>('take_pending_files');
        if (mounted && paths.length) await addPaths(paths);
      } catch (cause) {
        if (mounted) {
          setStatus('FILE COULD NOT OPEN');
          setError(errorMessage(cause, 'Could not open the selected file.'));
        }
      }
    };
    void listen('flux:files-pending', () => { void loadPending(); }).then(stop => {
      unlisten = stop;
      void loadPending();
    });
    return () => { mounted = false; unlisten?.(); };
  }, [addPaths]);

  const convertible = files.filter(file => file.kind !== 'unsupported' && targetsFor(file).length > 0);
  const formats = convertible.length
    ? targetsFor(convertible[0]).filter(format => convertible.every(file => targetsFor(file).includes(format)))
    : [];
  const displayItem = convertible[0] ?? files[0];
  const fileCount = convertible.length;

  const run = async (target: string) => {
    if (busy || !formats.includes(target)) return;
    setBusy(true);
    setStatus('');
    setError('');
    const controller = new AbortController();
    cancelController.current = controller;
    const successes: string[] = [];
    const savedPaths: string[] = [];
    const failures: string[] = [];
    for (const file of convertible) {
      if (controller.signal.aborted) break;
      try {
        const name = outputName(file, target);
        let outputPath: string | null = null;
        if (isTauri()) {
          const slash = Math.max(file.sourcePath?.lastIndexOf('/') ?? -1, file.sourcePath?.lastIndexOf('\\') ?? -1);
          const sibling = file.sourcePath && slash >= 0 ? `${file.sourcePath.slice(0, slash + 1)}${name}` : name;
          outputPath = await save({ title: `Save ${name}`, defaultPath: sibling, filters: [{ name: `${target.toUpperCase()} file`, extensions: [target] }] });
          if (!outputPath) continue;

        }

        const blob = await convert(file, target, message => setStatus(message), controller.signal);
        if (controller.signal.aborted) break;
        if (blob.size > 32 * 1024 * 1024) throw new Error('Converted output exceeds the safe 32 MB limit.');
        if (isTauri()) {
          if (!outputPath) throw new Error('No output location was selected.');
          await writeOutputInChunks(
            blob,
            outputPath,
            file.sourcePath ?? null,
            controller.signal,
            setStatus,
          );
          savedPaths.push(outputPath);
        } else {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = name;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        successes.push(name);
      } catch (cause) {
        if (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) break;
        failures.push(`${file.file.name}: ${errorMessage(cause, 'conversion failed')}`);
      }
    }
    if (successes.length) {
      const message = successes.length === 1 ? '1 FILE SAVED' : `${successes.length} FILES SAVED`;
      setStatus(message);
      setLastFormat(target);
      localStorage.setItem('flux-format', target);
    }
    if (failures.length) {
      setStatus(failures.length === successes.length ? 'CONVERSION FAILED' : 'PARTLY CONVERTED');
      setError(failures.join('\n'));
    }
    if (!controller.signal.aborted && savedPaths.length) {
      try {
        await invoke('open_converted_file', { path: savedPaths[0] });
      } catch (cause) {
        const message = errorMessage(cause, 'Windows could not open the converted file.');
        setStatus('FILE SAVED · COULD NOT OPEN');
        setError(previous => previous ? `${previous}\n${message}` : message);
      }
    }
    if (controller.signal.aborted) setStatus(successes.length ? 'EXPORT CANCELED · SAVED FILES KEPT' : 'EXPORT CANCELED');
    else if (!successes.length && !failures.length) setStatus('READY WHEN YOU ARE');
    setFiles([]);
    cancelController.current = null;
    setBusy(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void add(event.dataTransfer.files);
  };

  return <section className="desktop-surface" onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={onDrop}>
    <FormatWheel item={displayItem} count={fileCount} formats={formats} busy={busy} status={status} error={error} dragging={dragging} onConvert={run} onBrowse={() => void browse()}/>
    <input ref={input} className="hidden-input" type="file" multiple onChange={event => { if (event.target.files) void add(event.target.files); event.target.value = ''; }}/>
    <span className="sr-only">FLUX local file converter{lastFormat ? ` · last format ${lastFormat.toUpperCase()}` : ''}{error ? ` · ${error}` : ''}</span>
  </section>;
}
