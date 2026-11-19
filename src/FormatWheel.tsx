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

const IDLE_SLICES = Array.from({ length: 8 }, (_, index) => `idle-${index}`);
const IDLE_FILLS = ['#faf8ff', '#fffefd', '#f5f2ff', '#ffffff', '#f8f6ff', '#fffefd', '#f3f5ff', '#ffffff'];
const label = (format: string) => format === 'jpg' ? 'JPG' : format.toUpperCase();
const shorten = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

function point(radius: number, degrees: number) {
  const angle = degrees * Math.PI / 180;
  return { x: 180 + Math.cos(angle) * radius, y: 180 + Math.sin(angle) * radius };
}

function segmentPath(start: number, end: number) {
  const innerStart = point(77, start);
  const innerEnd = point(77, end);
  const outerEnd = point(168, end);
  const outerStart = point(168, start);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${innerStart.x} ${innerStart.y} A 77 77 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y} L ${outerEnd.x} ${outerEnd.y} A 168 168 0 ${largeArc} 0 ${outerStart.x} ${outerStart.y} Z`;
}

export default function FormatWheel({ item, count, formats, busy, status, error, dragging, onConvert, onBrowse }: Props) {
  const active = !!item && formats.length > 0 && !status;
  const standby = !item && !status && !busy;
  const options = active ? formats : IDLE_SLICES;
  const arc = 360 / options.length;
  const gap = Math.min(3, arc * 0.08);
  const startOffset = -90 - arc / 2;
  const centerName = shorten(item?.file.name ?? '', 16);
  const centerIsAction = !active && !busy;
  const pointerStart = useRef<{ x: number; y: number; moving: boolean } | null>(null);
  const suppressClick = useRef(false);
  const centerAction = () => { if (!busy && (!active || !item)) onBrowse(); };

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

  const centerLines = busy
    ? ['EXPORTING', shorten(status || `${count} FILES`, 18), 'ESC TO CANCEL']
    : status
    ? error
      ? ['CONVERSION ISSUE', shorten(error.split('\n')[0], 18), 'CLICK TO TRY AGAIN']
      : ['SAVED', shorten(status, 18), 'CLICK TO ADD MORE']
      : active
        ? [count === 1 ? item.ext.toUpperCase() : `${count} FILES`, count === 1 ? centerName : `${item.ext.toUpperCase()} BATCH`, 'CHOOSE AN OUTPUT']
        : item
          ? ['NO OPTIONS', item.ext.toUpperCase(), 'CLICK TO PICK AGAIN']
          : ['FLUX', dragging ? 'DROP FILE HERE' : 'DROP A FILE', dragging ? 'RELEASE TO LOAD' : 'CLICK TO BROWSE'];

  const title: ReactNode = error || status ? <title>{error || status}</title> : null;

  return <main className={`donut-app${dragging ? ' is-dragging' : ''}${active ? ' has-file' : ''}${standby ? ' is-standby' : ''}`}>
    <svg
      className="donut"
      viewBox="0 0 360 360"
      role="group"
      aria-label={active ? `Convert ${item?.file.name}. Drag the donut to move it on the desktop.` : 'FLUX file converter. Drop or choose a file. Drag the donut to move it on the desktop.'}
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
        <radialGradient id="ring-wash" cx="36%" cy="22%" r="78%">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="67%" stopColor="#faf9ff"/>
          <stop offset="100%" stopColor="#efedfa"/>
        </radialGradient>
        <linearGradient id="center-wash" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff"/>
          <stop offset="100%" stopColor="#fbfaff"/>
        </linearGradient>
        <filter id="donut-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="5" stdDeviation="6" floodColor="#403774" floodOpacity=".17"/>
        </filter>
      </defs>

      <circle className="donut-aura" cx="180" cy="180" r="174"/>
      <circle className="donut-outline" cx="180" cy="180" r="173"/>
      <g filter="url(#donut-shadow)">
        {options.map((format, index) => {
          const center = startOffset + index * arc + arc / 2;
          const start = startOffset + index * arc + gap / 2;
          const end = startOffset + (index + 1) * arc - gap / 2;
          const textPosition = point(123, center);
          const converts = active && !busy;
          const activate = () => {
            if (busy) return;
            if (converts) onConvert(format);
            else onBrowse();
          };
          return <g className={`donut-slice${active ? ' convertible' : ' hint'}`} key={format} role={active ? 'button' : undefined} tabIndex={active && !busy ? 0 : -1} aria-label={active ? `Convert to ${format.toUpperCase()}` : undefined} aria-disabled={active ? busy : undefined} onClick={active ? activate : undefined} onKeyDown={active ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } } : undefined}>
            <path d={segmentPath(start, end)} fill={active ? (index % 2 ? '#fffefd' : '#faf9ff') : IDLE_FILLS[index % IDLE_FILLS.length]} stroke="#dedbe8" strokeWidth="1.1"/>
            {active && <text x={textPosition.x} y={textPosition.y + 4} textAnchor="middle" className="donut-label">{label(format)}</text>}
          </g>;
        })}
      </g>

      <g className={`donut-center${centerIsAction ? ' center-action' : ''}${active ? ' center-active' : ''}${status ? ' center-status' : ''}`} role={centerIsAction ? 'button' : 'group'} tabIndex={centerIsAction ? 0 : -1} aria-label={active ? `${count} files ready, choose a format around the ring` : 'Browse files'} onClick={centerIsAction ? centerAction : undefined} onKeyDown={centerIsAction ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); centerAction(); } } : undefined}>
        {title}
        <circle cx="180" cy="180" r="72" className="donut-center-disc"/>
        {standby ? <g className="standby-content" aria-hidden="true">
          <g className="flux-mark">
            <path d="M180 122v17m-7-7 7-7 7 7"/>
            <path d="M168 140v3.5a2.5 2.5 0 0 0 2.5 2.5h19a2.5 2.5 0 0 0 2.5-2.5V140"/>
          </g>
          <text x="180" y="165" textAnchor="middle" className="donut-center-primary">FLUX</text>
          <text x="180" y="188" textAnchor="middle" className="donut-center-secondary">{dragging ? 'DROP FILE HERE' : 'DROP A FILE'}</text>
          <text x="180" y="208" textAnchor="middle" className="donut-center-hint">{dragging ? 'RELEASE TO LOAD' : 'CLICK TO BROWSE'}</text>
          <g className="move-grip" aria-hidden="true">
            <circle cx="174" cy="225" r="1.6"/><circle cx="180" cy="225" r="1.6"/><circle cx="186" cy="225" r="1.6"/>
          </g>
          <text x="180" y="241" textAnchor="middle" className="move-hint">DRAG TO MOVE</text>
        </g> : <g aria-hidden="true">
          <text x="180" y="164" textAnchor="middle" className="donut-center-primary">{centerLines[0]}</text>
          <text x="180" y="187" textAnchor="middle" className="donut-center-secondary">{centerLines[1]}</text>
          <text x="180" y="210" textAnchor="middle" className="donut-center-hint">{centerLines[2]}</text>
        </g>}
      </g>
    </svg>
  </main>;
}

