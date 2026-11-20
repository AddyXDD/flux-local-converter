import { useRef } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FluxFile } from './converter';

type Props = {
  item?: FluxFile;
  count: number;
  formats: string[];
  busy: boolean;
  status?: string;
  error?: string;
  dragging: boolean;
  onConvert: (target: string) => void;
  onBrowse: () => void;
};

const label = (format: string) => format === 'jpg' ? 'JPG' : format.toUpperCase();
const shorten = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

function point(radius: number, degrees: number) {
  const angle = degrees * Math.PI / 180;
  return { x: 180 + Math.cos(angle) * radius, y: 180 + Math.sin(angle) * radius };
}

function segmentPath(start: number, end: number) {
  const innerStart = point(79, start);
  const innerEnd = point(79, end);
  const outerEnd = point(168, end);
  const outerStart = point(168, start);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${innerStart.x} ${innerStart.y} A 79 79 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y} L ${outerEnd.x} ${outerEnd.y} A 168 168 0 ${largeArc} 0 ${outerStart.x} ${outerStart.y} Z`;
}

function FormatGlyph({ format, x, y }: { format: string; x: number; y: number }): ReactNode {
  const origin = `translate(${x - 12} ${y - 12})`;
  if (['png', 'jpg', 'webp', 'bmp'].includes(format)) {
    return <g transform={origin} className="format-glyph" aria-hidden="true">
      <rect x="2.5" y="3.5" width="19" height="17" rx="3"/>
      <circle cx="8.2" cy="8.5" r="1.8"/>
      <path d="m4.5 17 5.2-5.2 3.4 3.2 3.1-2.8 4.1 4.8"/>
    </g>;
  }
  if (format === 'csv') {
    return <g transform={origin} className="format-glyph" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"/>
      <path d="M9 4v16M15 4v16M3 9h18M3 15h18"/>
    </g>;
  }
  if (['json', 'yaml', 'xml'].includes(format)) {
    const symbol = format === 'json' ? '{ }' : format === 'xml' ? '</>' : 'Y';
    return <g transform={origin} className="format-glyph code-glyph" aria-hidden="true">
      <rect x="2.5" y="3.5" width="19" height="17" rx="4"/>
      <text x="12" y="16" textAnchor="middle">{symbol}</text>
    </g>;
  }
  const symbol = format === 'docx' ? 'W' : format === 'pptx' ? 'P' : format === 'pdf' ? 'P' : format === 'html' ? '<>' : format.slice(0, 1).toUpperCase();
  return <g transform={origin} className="format-glyph document-glyph" aria-hidden="true">
    <path d="M5 2.5h10l5 5V22H5z"/>
    <path d="M15 2.5v5h5M8.5 12h8M8.5 16h8"/>
    <text x="12.5" y="20" textAnchor="middle">{symbol}</text>
  </g>;
}

function FluxMark({ className = '' }: { className?: string }) {
  return <path className={`flux-mark ${className}`} d="M180 139 185.4 154.6 201 160 185.4 165.4 180 181 174.6 165.4 159 160 174.6 154.6Z"/>;
}

export default function FormatWheel({ item, count, formats, busy, status, error, dragging, onConvert, onBrowse }: Props) {
  const active = !!item && formats.length > 0 && !status;
  const standby = !item && !status && !busy;
  const success = !busy && !error && !!status && /\bSAVED\b/i.test(status);
  const failed = !!error;
  const options = active ? formats : [];
  const arc = options.length ? 360 / options.length : 0;
  const gap = Math.min(3.5, arc * 0.08);
  const startOffset = -90 - arc / 2;
  const centerAction = !active && !busy;
  const pointerStart = useRef<{ x: number; y: number; moving: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || busy || !isTauri()) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, moving: false };
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = pointerStart.current;
    if (!start || start.moving || busy) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 9) return;
    start.moving = true;
    suppressClick.current = true;
    void getCurrentWindow().startDragging().catch(() => { suppressClick.current = false; });
  };

  const onPointerEnd = () => {
    pointerStart.current = null;
    if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 300);
  };

  const centerActionLabel = standby ? 'FLUX file converter. Drop or choose a file. Drag the donut to move it on the desktop.'
    : active ? `Convert ${item?.file.name}; choose one of ${formats.join(', ')}.`
      : error ? `Conversion error: ${error}` : status || 'Browse files';
  const title: ReactNode = error || status ? <title>{error || status}</title> : null;
  const rootState = [
    dragging && 'is-dragging',
    active && 'has-file',
    standby && 'is-standby',
    busy && 'is-processing',
    success && 'is-success',
    failed && 'is-error',
  ].filter(Boolean).join(' ');

  return <main className={`donut-app ${rootState}`}>
    <svg
      className="donut"
      viewBox="0 0 360 360"
      role="group"
      aria-label={centerActionLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={event => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      <defs>
        <radialGradient id="wheel-backdrop" cx="38%" cy="23%" r="82%">
          <stop offset="0%" stopColor="#1c2941" stopOpacity=".97"/>
          <stop offset="72%" stopColor="#0c1322" stopOpacity=".98"/>
          <stop offset="100%" stopColor="#070b13" stopOpacity=".99"/>
        </radialGradient>
        <linearGradient id="segment-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#18243a" stopOpacity=".98"/>
          <stop offset="100%" stopColor="#0a1020" stopOpacity=".98"/>
        </linearGradient>
        <linearGradient id="segment-highlight" x1="0" y1="0" x2=".8" y2="1">
          <stop offset="0%" stopColor="#7657e9"/>
          <stop offset="58%" stopColor="#4439a5"/>
          <stop offset="100%" stopColor="#1a2750"/>
        </linearGradient>
        <radialGradient id="center-glass" cx="32%" cy="20%" r="88%">
          <stop offset="0%" stopColor="#1a2740"/>
          <stop offset="100%" stopColor="#070b15"/>
        </radialGradient>
        <linearGradient id="flux-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#dff9ff"/>
          <stop offset="42%" stopColor="#9da6ff"/>
          <stop offset="100%" stopColor="#c77aff"/>
        </linearGradient>
        <filter id="violet-lift" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#9572ff" floodOpacity=".55"/>
        </filter>
      </defs>

      {active ? <g className="wheel-expanded">
        <circle className="wheel-backdrop" cx="180" cy="180" r="173"/>
        <circle className="donut-aura" cx="180" cy="180" r="171"/>
        <g className="wheel-segments">
          {options.map((format, index) => {
            const center = startOffset + index * arc + arc / 2;
            const start = startOffset + index * arc + gap / 2;
            const end = startOffset + (index + 1) * arc - gap / 2;
            const iconPosition = point(122, center);
            const labelPosition = point(122, center);
            const activate = () => { if (!busy) onConvert(format); };
            return <g className="donut-slice convertible" key={format} role="button" tabIndex={busy ? -1 : 0}
              aria-label={`Convert to ${label(format)}`} aria-disabled={busy}
              onClick={activate}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }}>
              <path className="slice-surface" d={segmentPath(start, end)} fill="url(#segment-glass)"/>
              <FormatGlyph format={format} x={iconPosition.x} y={iconPosition.y - 9}/>
              <text x={labelPosition.x} y={labelPosition.y + 19} textAnchor="middle" className="donut-label">{label(format)}</text>
            </g>;
          })}
        </g>
        <circle className="donut-outline" cx="180" cy="180" r="173"/>
        <circle className="wheel-inner-outline" cx="180" cy="180" r="77"/>
      </g> : <g className="wheel-collapsed">
        <circle className="standby-halo" cx="180" cy="180" r="105"/>
        <circle className="standby-ring" cx="180" cy="180" r="96"/>
        <circle className="standby-ring inner" cx="180" cy="180" r="82"/>
      </g>}

      <g className={`donut-center${centerAction ? ' center-action' : ''}`} role={centerAction ? 'button' : 'group'} tabIndex={centerAction ? 0 : -1}
        aria-label={centerActionLabel} onClick={centerAction ? onBrowse : undefined}
        onKeyDown={centerAction ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onBrowse(); } } : undefined}>
        {title}
        <circle cx="180" cy="180" r="72" className="donut-center-disc"/>
        {dragging && <circle cx="180" cy="180" r="101" className="drag-ring" aria-hidden="true"/>}
        {busy && <circle cx="180" cy="180" r="67" className="processing-ring" aria-hidden="true"/>}
        {standby ? <g className="standby-content" aria-hidden="true">
          <FluxMark className="mark-idle"/>
          <text x="180" y="211" textAnchor="middle" className="brand-wordmark">FLUX</text>
        </g> : active ? <g className="active-content" aria-hidden="true">
          <FluxMark/>
          <text x="180" y="190" textAnchor="middle" className="brand-wordmark">FLUX</text>
          <text x="180" y="211" textAnchor="middle" className="center-caption">{count === 1 ? `${item.ext.toUpperCase()} READY` : `${count} FILES READY`}</text>
        </g> : busy ? <g className="processing-content" aria-hidden="true">
          <FluxMark/>
          <text x="180" y="190" textAnchor="middle" className="brand-wordmark">FLUX</text>
          <text x="180" y="211" textAnchor="middle" className="center-caption">{shorten(status || 'CONVERTING', 15)}</text>
        </g> : success ? <g className="success-content" aria-hidden="true">
          <path className="success-check" d="m163 159 12 12 24-27"/>
          <text x="180" y="194" textAnchor="middle" className="brand-wordmark">FLUX</text>
          <text x="180" y="214" textAnchor="middle" className="center-caption">SAVED</text>
        </g> : failed ? <g className="error-content" aria-hidden="true">
          <path className="error-cross" d="m166 145 28 28m0-28-28 28"/>
          <text x="180" y="194" textAnchor="middle" className="brand-wordmark">FLUX</text>
          <text x="180" y="214" textAnchor="middle" className="center-caption">CONVERSION ISSUE</text>
        </g> : <g className="status-content" aria-hidden="true">
          <FluxMark/>
          <text x="180" y="190" textAnchor="middle" className="brand-wordmark">FLUX</text>
          <text x="180" y="211" textAnchor="middle" className="center-caption">{shorten(status || 'READY', 15)}</text>
        </g>}
      </g>
    </svg>
  </main>;
}
