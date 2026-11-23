import { useRef, useState, useCallback, useEffect, useMemo, lazy, Suspense } from 'react';
import { useLenis } from '../hooks/useLenis.js';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { getTradeById } from '../data/trades.js';
import { resolveImg, getStoredImgAsync, resolveMediumAsync, getImageMeta, formatBytes, preloadNeighbourImages, setStoredImg, fileToDataUrl, getNotes, setNotes, getTags, setTags, getTradeDate, setTradeDate, getAnnotations, setAnnotations, flushAllWeekDocs, flushWeekDoc, evictDetailImageUrls } from '../data/storage.js';

// The Quill editor (~200KB) loads only when the notes section is needed
// (perf step 8) — see the mount logic in TradeDetail below. TradeDetail
// itself never imports react-quill-new, so the detail page paints with
// chart + tags first and the editor chunk follows on demand.
const NotesEditor = lazy(() => import('./NotesEditor.jsx'));

/* Placeholder shown while the editor is not yet mounted: the notes as
   read-only text (same bold look), or the hint when empty. Clicking or
   focusing it mounts the real editor — see onMount in TradeDetail. */
function NotesPlaceholder({ value, onMount }) {
  if (value) {
    return (
      <div
        data-testid="notes-editor-placeholder"
        tabIndex={0}
        onPointerDown={onMount}
        onFocus={onMount}
        className="flex-1 text-on-surface font-bold min-h-[200px] cursor-text px-3 py-2 [&_img]:max-w-full"
        dangerouslySetInnerHTML={{ __html: value }}
      />
    );
  }
  return (
    <div
      data-testid="notes-editor-placeholder"
      tabIndex={0}
      onPointerDown={onMount}
      onFocus={onMount}
      className="flex-1 text-on-surface min-h-[200px] cursor-text px-3 py-2"
    >
      <span className="text-on-surface-variant/50 font-normal">Type notes here… Drag &amp; drop or paste images anytime.</span>
    </div>
  );
}




/* ─── Page ─── */
// Thick filled arrow for chart annotations (toolbar + placed marks).
// dir 'up' | 'down'; the tip is the point that lands on the chart.
function AnnArrow({ color, dir = 'up', size = 26 }) {
  const d = dir === 'up'
    ? 'M12 1 L21 13 H15.5 V31 H8.5 V13 H3 Z'
    : 'M12 31 L3 19 H8.5 V1 H15.5 V19 H21 Z';
  return (
    <svg width={size} height={(size * 32) / 24} viewBox="0 0 24 32" aria-hidden="true">
      <path d={d} fill={color} stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
    </svg>
  );
}

const ANN_ARROW_STYLE = {
  'arrow-green-up': { color: '#22c55e', dir: 'up' },
  'arrow-green-down': { color: '#22c55e', dir: 'down' },
  'arrow-red-up': { color: '#ef4444', dir: 'up' },
  'arrow-red-down': { color: '#ef4444', dir: 'down' },
  'arrow-yellow': { color: '#eab308', dir: 'down' },
};

// Pencil icon for the toolbar: a black pencil with a thin white outline,
// so it reads on the dark toolbar (and stays black on the white active pill).
function AnnPencil({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#000000" stroke="#ffffff" strokeWidth="1" />
    </svg>
  );
}

// A freehand pencil stroke: points are [[x, y], ...] in % of the displayed
// picture. A bold black core over a wider white edge, so the black stays
// visible on dark charts. vector-effect keeps the stroke width in px even
// though the viewBox is stretched to the picture rect.
function PencilStroke({ points, selected }) {
  const d = points.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" stroke="#ffffff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <polyline points={d} fill="none" stroke={selected ? '#fbbf24' : '#000000'} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Topmost point of a stroke — where its right-click delete (×) sits.
const pencilTopPoint = (points) => {
  let top = points[0];
  for (const p of points) if (p[1] < top[1]) top = p;
  return top;
};

// Dotted resize handles for comment boxes: 8 handles, sides + corners,
// sitting on the box's own dotted border (no second box around it).
const RESIZE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RESIZE_HANDLE_POS = {
  nw: '-left-1.5 -top-1.5 cursor-nwse-resize',
  n: 'left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize',
  ne: '-right-1.5 -top-1.5 cursor-nesw-resize',
  e: '-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize',
  se: '-right-1.5 -bottom-1.5 cursor-nwse-resize',
  s: 'left-1/2 -bottom-1.5 -translate-x-1/2 cursor-ns-resize',
  sw: '-left-1.5 -bottom-1.5 cursor-nesw-resize',
  w: '-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize',
};

export default function TradeDetail() {
  const navigate  = useNavigate();
  const { id }    = useParams();
  const { state } = useLocation();
  const search = state?.search || '';

  // Apply smooth scrolling to the window for this page
  const lenisRef = useLenis();

  // Resolve trade data — prefer router state, fall back to a rebuild
  // from storage (bug 5): a reload or deep link has no router state,
  // and the old stub getTradeById returned null, so the page showed
  // "Trade not found". Memoised so the trade's identity is stable
  // across renders — effects that depend on `trade` must not re-run
  // (and clobber in-progress edits) on every render.
  const trade = useMemo(() => {
    if (state) return state;
    const t = getTradeById(id);
    if (!t) return null;
    // Day pick: the last-visited day in this tab first (the user was
    // looking at it when they reloaded), then the first day with any
    // content, then Monday.
    const lastDay = sessionStorage.getItem('sb_last_day');
    const day = t.days.find((d) => d.day === lastDay)
      ?? t.days.find((d) => d.hasContent)
      ?? t.days[0];
    return { weekId: t.id, weekStart: t.weekStart, weekEnd: t.weekEnd, remarks: t.remarks, day };
  }, [state, id]);

  const handleBack = () => {
    sessionStorage.setItem('sb_last_week_id', weekId);
    sessionStorage.setItem('sb_last_day', dayName);
    navigate(search ? `/?q=${encodeURIComponent(search)}` : '/', {
      state: {
        returnWeekId: weekId,
        returnDay: dayName,
        search,
      }
    });
  };

  const fileInputRef = useRef(null);
  const quillRef     = useRef(null);
  const editorRef    = useRef(null);
  const savedRange   = useRef(null);
  const hLineRef     = useRef(null);
  const vLineRef     = useRef(null);
  const hLineInlineRef = useRef(null);
  const vLineInlineRef = useRef(null);

  const [expanded, setExpanded] = useState(false);

  // Lightbox pan/zoom: scale is a multiplier on the fit size (1 = fit),
  // pan is in CSS pixels, both applied as one GPU transform so zooming
  // never re-decodes or re-lays-out the image.
  const [lbZoom, setLbZoom] = useState(1);
  const [lbPan, setLbPan] = useState({ x: 0, y: 0 });
  const lbImgRef = useRef(null);
  const lbContainerRef = useRef(null);
  const lbPointers = useRef(new Map());
  const lbLastPinch = useRef(0);
  const lbDragged = useRef(false);
  const lbZoomRef = useRef(1);
  const lbPanRef = useRef({ x: 0, y: 0 });
  // Annotation actions (disarm / delete-selected / reset), assigned by the
  // annotation state block below — the Escape handler above the state
  // declarations calls through this ref so it never closes over stale
  // tool/selection values.
  const annActionsRef = useRef({});

  // Clamp pan so the zoomed image can't be dragged off-screen.
  const clampLbPan = useCallback((pan, zoom) => {
    const img = lbImgRef.current;
    const cont = lbContainerRef.current;
    if (!img || !cont || !img.naturalWidth) return pan;
    const rect = cont.getBoundingClientRect();
    const fit = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const dispW = img.naturalWidth * fit * zoom;
    const dispH = img.naturalHeight * fit * zoom;
    const maxX = Math.max(0, (dispW - rect.width) / 2);
    const maxY = Math.max(0, (dispH - rect.height) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) };
  }, []);

  const applyLbZoom = useCallback((zoom, pan) => {
    const z = Math.max(1, Math.min(8, zoom));
    const p = clampLbPan(pan ?? lbPanRef.current, z);
    lbZoomRef.current = z;
    lbPanRef.current = p;
    setLbZoom(z);
    setLbPan(p);
  }, [clampLbPan]);

  const lbZoomToOneToOne = useCallback(() => {
    const img = lbImgRef.current;
    const cont = lbContainerRef.current;
    if (!img || !cont || !img.naturalWidth) return;
    const rect = cont.getBoundingClientRect();
    const fit = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    applyLbZoom(1 / fit, { x: 0, y: 0 });
  }, [applyLbZoom]);

  const lbResetZoom = useCallback(() => applyLbZoom(1, { x: 0, y: 0 }), [applyLbZoom]);

  // Wheel zoom (non-passive: the browser would otherwise scroll the page
  // behind the lightbox) and pinch zoom via pointer events.
  useEffect(() => {
    if (!expanded) return;
    const cont = lbContainerRef.current;
    if (!cont) return;
    const onWheel = (e) => {
      e.preventDefault();
      applyLbZoom(lbZoomRef.current * Math.exp(-e.deltaY * 0.0015));
    };
    cont.addEventListener('wheel', onWheel, { passive: false });
    return () => cont.removeEventListener('wheel', onWheel);
  }, [expanded, applyLbZoom]);

  // Reset zoom/pan every time the lightbox opens.
  useEffect(() => {
    if (expanded) { lbZoomRef.current = 1; lbPanRef.current = { x: 0, y: 0 }; setLbZoom(1); setLbPan({ x: 0, y: 0 }); }
  }, [expanded]);

  const onLbPointerDown = (e) => {
    lbPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lbDragged.current = false;
    if (lbPointers.current.size === 2) {
      const pts = [...lbPointers.current.values()];
      lbLastPinch.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };
  const onLbPointerMove = (e) => {
    const prev = lbPointers.current.get(e.pointerId);
    if (!prev) return;
    lbPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lbPointers.current.size === 2) {
      const pts = [...lbPointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lbLastPinch.current > 0 && dist > 0) {
        applyLbZoom(lbZoomRef.current * (dist / lbLastPinch.current));
      }
      lbLastPinch.current = dist;
      return;
    }
    // Drag to pan (only meaningful when zoomed in).
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) lbDragged.current = true;
    if (lbZoomRef.current > 1) {
      applyLbZoom(lbZoomRef.current, { x: lbPanRef.current.x + dx, y: lbPanRef.current.y + dy });
    }
  };
  const onLbPointerUp = (e) => {
    lbPointers.current.delete(e.pointerId);
    if (lbPointers.current.size < 2) lbLastPinch.current = 0;
  };

  // Lightbox: Escape closes, background scroll is locked, and Lenis is
  // stopped while open so wheel input cannot scroll the page behind it.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => {
      // While typing in a comment box, Escape only leaves the box.
      const ae = document.activeElement;
      if (e.key === 'Escape' && ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) { ae.blur(); return; }
      // With a tool armed or a mark selected, Escape disarms/deselects
      // instead of closing the lightbox.
      if (e.key === 'Escape' && annActionsRef.current.disarm?.()) return;
      if (e.key === 'Escape') setExpanded(false);
      // Delete / Backspace removes the selected mark (never while typing).
      if ((e.key === 'Delete' || e.key === 'Backspace') && ae?.tagName !== 'TEXTAREA' && ae?.tagName !== 'INPUT') {
        annActionsRef.current.deleteSelected?.();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    lenisRef.current?.stop();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      lenisRef.current?.start();
    };
  }, [expanded, lenisRef]);
  const [saveStatus, setSaveStatus] = useState('');
  const timeoutRef = useRef(null);

  const triggerSaveIndicator = useCallback(() => {
    setSaveStatus('Saving...');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setSaveStatus('Saved ✓');
      timeoutRef.current = setTimeout(() => setSaveStatus(''), 2000);
    }, 500);
  }, []);

  // Resolve the main chart: localStorage > router state img > static day.img
  const weekId  = trade?.weekId  ?? id;
  const dayName = trade?.day?.day ?? '';

  // chartImg is the fast placeholder (thumbnail / router-state image).
  // fullImg is the original, uncompressed chart, loaded lazily below.
  // The lightbox MUST use fullImg — showing the 480px thumbnail at
  // 95vw was the zoom regression (see storage.js / BUG-REPORT.md).
  const [chartImg, setChartImg] = useState(() => resolveImg(weekId, dayName, trade?.day?.img));
  const [fullImg, setFullImg] = useState(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  // Medium (1600px) is what the inline chart shows: decoding a 2560px+
  // original just to display it at ~900px wide was the remaining inline
  // jank. The full original is only decoded for the lightbox.
  const [mediumImg, setMediumImg] = useState(null);
  const [mediumLoaded, setMediumLoaded] = useState(false);
  // Image generation (bug 7): every async image continuation checks
  // this epoch before touching state. The image-load effect bumps it
  // on each run (navigation / a new trade), deleteChart bumps it, and
  // persistChart captures it at the start of an upload — so a load
  // that resolves after a delete, or an uploaded medium that lands
  // after the user moved to another day, is dropped instead of
  // resurrecting the old chart or landing on the wrong day. The
  // effect's `cancelled` flag alone could not cover a delete: the
  // effect never re-runs for one, so its continuations stayed live.
  const imgGenRef = useRef(0);
  // Whether any image tier is in hand. The chart container, the
  // Original badge and the double-click-to-expand gate must use this,
  // not chartImg alone: on a reload or deep link (bug 5) there is no
  // preloaded image, so chartImg starts null and the chart only
  // appears once the medium/full tiers land — gating on chartImg
  // alone left the page showing the empty dropzone for a day that
  // has a chart, even with the image cached and the meta loaded.
  // (Declared here, after all three tier states, so none of them is
  // read before its initialization.)
  const hasChart = Boolean(chartImg || mediumImg || fullImg);
  const [imgMeta, setImgMeta] = useState(() => getImageMeta(weekId, dayName));
  const [tags, setTagsState] = useState(() => getTags(weekId, dayName));
  const [tagInput, setTagInput] = useState('');
  const [tradeDate, setTradeDateState] = useState(() => getTradeDate(weekId, dayName));
  const [pickerValue, setPickerValue] = useState(() => getTradeDate(weekId, dayName));
  const dateInputRef = useRef(null);

  /* ── Chart annotations (lightbox only) ─────────────────────────────
     A mark is { id, type, x, y, text? } with x/y in % of the displayed
     picture. Types: 'line' (TradingView-style horizontal line),
     'arrow-green-up' | 'arrow-green-down' (entry), 'arrow-red-up' |
     'arrow-red-down' (exit), 'arrow-yellow' (spot marker), 'comment',
     and 'pencil' — a freehand stroke, { id, type: 'pencil', points }
     with points as [[x, y], ...] in % of the picture. Stored per
     week+day (storage.js) so marks survive reload and are included in
     the whole-database backup. The overlay is sized to the displayed
     picture rect, so % coords stay glued to the chart under pan/zoom.
     The toolbar is icons only and floats on top of the zoomed chart.
     Other tools are one-shot; the pencil stays armed stroke after
     stroke until it is tapped again (or Escape). A comment box carries
     an optional w/h in px once it has been resized. A double-click on
     a comment places the text cursor (and selects the word); holding
     the second press and dragging moves the whole box instead — the
     text area covers the box, so a plain drag could never grab it.
     Right-clicking a comment turns the box's own border dotted and
     shows 8 handles on its perimeter for free-form resizing, with the
     delete (×) button riding on the top dotted line near the right
     end — there is no second box around it. ─────────────────────── */
  const [annotations, setAnnotationsState] = useState(() => getAnnotations(weekId, dayName));
  const [annTool, setAnnTool] = useState('select');
  const [selectedAnnId, setSelectedAnnId] = useState(null);
  // Mark showing its right-click delete (×) button, if any.
  const [annMenuId, setAnnMenuId] = useState(null);
  const [focusAnnId, setFocusAnnId] = useState(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [picRect, setPicRect] = useState(null);
  const annDragRef = useRef(null);
  // The stroke currently being drawn with the pencil (live preview).
  const [pencilDraft, setPencilDraft] = useState(null);
  const pencilDrawRef = useRef(null);
  // A double-click press on a comment box that may become a move-drag.
  const dblDragRef = useRef(null);
  // A resize drag on a comment box's dotted frame.
  const resizeDragRef = useRef(null);
  // A click that places a mark fires on the nearest common ancestor of
  // the mousedown/mouseup targets — the overlay, not the new mark — so
  // without this the click right after placing a comment (which disarms
  // to select) would look like an empty select-mode click and close the
  // lightbox. Placement stamps the time; the close handler ignores
  // clicks in the same gesture (the follow-up click lands <50ms later).
  const justPlacedRef = useRef(0);

  const persistAnnotations = useCallback(async (next) => {
    setAnnotationsState(next);
    // Awaited: a mark placed then a reload in the same instant used to
    // lose the mark. This fires once per gesture (place / drag end /
    // resize end / delete), never per pointermove, so awaiting is cheap.
    await setAnnotations(weekId, dayName, next);
  }, [weekId, dayName]);

  // Displayed picture rect (viewport px): the lightbox image is
  // object-contain in a full-viewport box, scaled by fit*zoom about the
  // centre, then panned — same math as clampLbPan.
  const computePicRect = useCallback(() => {
    const img = lbImgRef.current;
    const cont = lbContainerRef.current;
    if (!img || !cont || !img.naturalWidth) return null;
    const r = cont.getBoundingClientRect();
    const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * fit * lbZoomRef.current;
    const h = img.naturalHeight * fit * lbZoomRef.current;
    return {
      left: (r.width - w) / 2 + lbPanRef.current.x,
      top: (r.height - h) / 2 + lbPanRef.current.y,
      width: w, height: h,
    };
  }, []);

  useEffect(() => {
    if (!expanded) { setPicRect(null); return; }
    const update = () => setPicRect(computePicRect());
    update();
    const cont = lbContainerRef.current;
    const ro = cont ? new ResizeObserver(update) : null;
    ro?.observe(cont);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, [expanded, computePicRect, lbZoom, lbPan, fullImg, mediumImg, chartImg]);

  // Inline chart (notes page): the same marks, read-only, over the chart
  // at the top of the detail page. The inline image is object-cover in a
  // fixed-aspect box, so the overlay is sized to the displayed picture
  // rect (cover math) — % coords then map exactly as in the lightbox.
  const inlineContainerRef = useRef(null);
  const inlineImgRef = useRef(null);
  const [inlinePicRect, setInlinePicRect] = useState(null);

  const computeInlinePicRect = useCallback(() => {
    const img = inlineImgRef.current;
    const cont = inlineContainerRef.current;
    if (!img || !cont || !img.naturalWidth) return null;
    const r = cont.getBoundingClientRect();
    const scale = Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    return { left: (r.width - w) / 2, top: (r.height - h) / 2, width: w, height: h };
  }, []);

  useEffect(() => {
    const update = () => setInlinePicRect(computeInlinePicRect());
    update();
    const cont = inlineContainerRef.current;
    const ro = cont ? new ResizeObserver(update) : null;
    ro?.observe(cont);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, [computeInlinePicRect, chartImg, mediumImg, fullImg]);

  const pointToPct = useCallback((clientX, clientY) => {
    const r = picRect;
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)),
    };
  }, [picRect]);

  const placeAnnotation = useCallback((e) => {
    if (annTool === 'pencil') return; // the pencil draws via its own pointer handlers
    const p = pointToPct(e.clientX, e.clientY);
    if (!p) return;
    justPlacedRef.current = Date.now();
    const nid = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (annTool === 'line') {
      persistAnnotations([...annotations, { id: nid, type: 'line', x: 50, y: p.y }]);
    } else if (annTool === 'comment') {
      persistAnnotations([...annotations, { id: nid, type: 'comment', x: Math.min(p.x, 86), y: Math.min(p.y, 86), text: '' }]);
      setSelectedAnnId(nid);
      setFocusAnnId(nid);
    } else {
      persistAnnotations([...annotations, { id: nid, type: annTool, x: p.x, y: p.y }]);
    }
    // One-shot tools: placing once deselects, so the next click does
    // nothing until the tool is picked again (comment already disarmed
    // here too, so the cursor can go straight into typing).
    setAnnTool('select');
    setClearArmed(false);
  }, [annTool, annotations, persistAnnotations, pointToPct]);

  // Pencil drawing: pointerdown starts a stroke, pointermove extends it,
  // pointerup stores it. Unlike the one-shot tools, the pencil stays
  // armed afterwards — tap the pencil button again (or Escape) to stop.
  const startPencilDraw = (e) => {
    const p = pointToPct(e.clientX, e.clientY);
    if (!p) return;
    const nid = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pencilDrawRef.current = { id: nid, pointerId: e.pointerId, points: [[p.x, p.y]] };
    setPencilDraft([[p.x, p.y]]);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const movePencilDraw = (e) => {
    const d = pencilDrawRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = pointToPct(e.clientX, e.clientY);
    if (!p) return;
    const last = d.points[d.points.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 0.15) return;
    d.points.push([p.x, p.y]);
    setPencilDraft([...d.points]);
  };
  const endPencilDraw = (e) => {
    const d = pencilDrawRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    pencilDrawRef.current = null;
    // A tap with no drag is a dot, not an empty stroke.
    const pts = d.points.length < 2 ? [d.points[0], d.points[0]] : d.points;
    setPencilDraft(null);
    justPlacedRef.current = Date.now();
    persistAnnotations([...annotations, { id: d.id, type: 'pencil', points: pts }]);
  };

  const deleteAnn = useCallback((id) => {
    persistAnnotations(annotations.filter((a) => a.id !== id));
    if (selectedAnnId === id) setSelectedAnnId(null);
    setAnnMenuId(null);
  }, [annotations, persistAnnotations, selectedAnnId]);

  const deleteSelectedAnn = useCallback(() => {
    if (!selectedAnnId) return false;
    deleteAnn(selectedAnnId);
    return true;
  }, [selectedAnnId, deleteAnn]);

  // Actions the document-level Escape/Delete handler calls through.
  useEffect(() => {
    annActionsRef.current = {
      disarm: () => {
        if (annTool === 'select' && !selectedAnnId) return false;
        setAnnTool('select');
        setSelectedAnnId(null);
        setAnnMenuId(null);
        setClearArmed(false);
        return true;
      },
      deleteSelected: () => { deleteSelectedAnn(); },
      reset: () => { setAnnTool('select'); setSelectedAnnId(null); setAnnMenuId(null); setClearArmed(false); },
    };
  }, [annTool, selectedAnnId, deleteSelectedAnn]);

  // Drag a mark in select mode (lines move vertically only).
  const onAnnPointerDown = (e, ann) => {
    if (annTool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    setSelectedAnnId(ann.id);
    setAnnMenuId(null);
    setClearArmed(false);
    annDragRef.current = {
      id: ann.id, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      origX: ann.x, origY: ann.y, origPoints: ann.points ?? null, moved: false, latest: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onAnnPointerMove = (e) => {
    const d = annDragRef.current;
    if (!d || d.pointerId !== e.pointerId || !picRect) return;
    const dxPct = ((e.clientX - d.startX) / picRect.width) * 100;
    const dyPct = ((e.clientY - d.startY) / picRect.height) * 100;
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 2) d.moved = true;
    const clamp01 = (v) => Math.max(0, Math.min(100, v));
    const next = annotations.map((a) => {
      if (a.id !== d.id) return a;
      if (a.type === 'line') return { ...a, y: clamp01(d.origY + dyPct) };
      if (a.type === 'pencil' && d.origPoints) return { ...a, points: d.origPoints.map(([px, py]) => [clamp01(px + dxPct), clamp01(py + dyPct)]) };
      return { ...a, x: clamp01(d.origX + dxPct), y: clamp01(d.origY + dyPct) };
    });
    d.latest = next;
    setAnnotationsState(next);
  };
  const onAnnPointerUp = (e) => {
    const d = annDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    annDragRef.current = null;
    if (d.moved && d.latest) persistAnnotations(d.latest);
  };

  // Typing in a comment box grows it downward to fit the text.
  // - No fixed height yet: the old auto-grow — the textarea's own inline
  //   height follows its scrollHeight, up to 200px, then it scrolls.
  // - Fixed height (the box was resized): if the text needs more room
  //   than the box has, the stored h grows to fit (capped by the room
  //   left on the chart); if it fits, the inline height is cleared so
  //   the textarea fills the box via h-full. The inline height must
  //   never be left stale: it beats the h-full class, so a box resized
  //   taller would otherwise leave the text box behind at its old
  //   height — the "second box" the vertical resize showed.
  const updateAnnText = useCallback((id, text, taEl) => {
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    let nextH;
    if (taEl) {
      taEl.style.height = 'auto';
      const need = taEl.scrollHeight;
      if (!ann.h) {
        taEl.style.height = `${Math.min(need, 200)}px`;
      } else if (need > ann.h) {
        const topPx = (ann.y / 100) * (picRect?.height ?? 0);
        const maxH = picRect ? Math.max(84, picRect.height - topPx) : 400;
        nextH = Math.max(84, Math.min(need, maxH));
        taEl.style.height = '';
      } else {
        taEl.style.height = '';
      }
    }
    persistAnnotations(annotations.map((a) => (a.id === id ? { ...a, text, ...(nextH != null ? { h: nextH } : {}) } : a)));
  }, [annotations, persistAnnotations, picRect]);

  // Grow a comment box to fit its text (up to 200px, then it scrolls).
  const autoGrowComment = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // Right-click a mark: select it and show its delete (×) button at its
  // top-right corner. The button is the only thing that shows it — a
  // plain left-click select does not.
  const onAnnContextMenu = (e, ann) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedAnnId(ann.id);
    setAnnMenuId(ann.id);
  };

  // Double-click a comment box: focus its text and put the caret where
  // the click landed, selecting the word there — the way a double-click
  // in a text field behaves. Done by hand (caretRangeFromPoint) because
  // the box's pointer handling would otherwise swallow the browser's
  // own word selection.
  const placeCursorInComment = (e) => {
    const ta = e.currentTarget.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const text = ta.value;
    let off = null;
    const doc = ta.ownerDocument;
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && ta.contains(range.startContainer)) off = range.startOffset;
    } else if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos && ta.contains(pos.offsetNode)) off = pos.offset;
    }
    if (off == null) off = text.length;
    let s = off, en = off;
    while (s > 0 && /\S/.test(text[s - 1])) s--;
    while (en < text.length && /\S/.test(text[en])) en++;
    ta.setSelectionRange(s, en);
  };

  // Resize a comment box by dragging the handles on its own dotted
  // border. Width/height are px; x/y stay in % of the picture. The box
  // is kept inside the chart, and the size is stored on the mark (w/h)
  // so it survives reload like the other marks.
  const startResize = (e, ann, dir) => {
    if (annTool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const boxEl = e.currentTarget.closest('[data-ann-type="comment"]');
    const origW = ann.w ?? 180;
    const origH = ann.h ?? boxEl?.offsetHeight ?? 120;
    resizeDragRef.current = {
      id: ann.id, pointerId: e.pointerId, dir,
      startX: e.clientX, startY: e.clientY,
      origX: ann.x, origY: ann.y, origW, origH, latest: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onResizePointerMove = (e) => {
    const d = resizeDragRef.current;
    if (!d || d.pointerId !== e.pointerId || !picRect) return;
    const dxPx = e.clientX - d.startX;
    const dyPx = e.clientY - d.startY;
    const minW = 140, minH = 84;
    let w = d.origW, h = d.origH, x = d.origX, y = d.origY;
    if (d.dir.includes('e')) w = Math.max(minW, d.origW + dxPx);
    if (d.dir.includes('w')) {
      w = Math.max(minW, d.origW - dxPx);
      x = d.origX + ((d.origW - w) / picRect.width) * 100;
    }
    if (d.dir.includes('s')) h = Math.max(minH, d.origH + dyPx);
    if (d.dir.includes('n')) {
      h = Math.max(minH, d.origH - dyPx);
      y = d.origY + ((d.origH - h) / picRect.height) * 100;
    }
    // Keep the box inside the picture (only the sides being dragged).
    if (d.dir.includes('w') && x < 0) { w = d.origW + (d.origX / 100) * picRect.width; x = 0; }
    if (d.dir.includes('n') && y < 0) { h = d.origH + (d.origY / 100) * picRect.height; y = 0; }
    const maxW = picRect.width - (x / 100) * picRect.width;
    if ((d.dir.includes('e') || d.dir.includes('w')) && w > maxW) w = Math.max(minW, maxW);
    const maxH = picRect.height - (y / 100) * picRect.height;
    if ((d.dir.includes('n') || d.dir.includes('s')) && h > maxH) h = Math.max(minH, maxH);
    // Only the dimension being dragged is stored: a sideways drag must
    // not freeze the height (an untouched h keeps the box auto-growing
    // as text is typed), and a vertical drag must not touch the width.
    const next = annotations.map((a) => {
      if (a.id !== d.id) return a;
      const out = { ...a };
      if (d.dir.includes('e') || d.dir.includes('w')) { out.w = Math.round(w); out.x = x; }
      if (d.dir.includes('n') || d.dir.includes('s')) { out.h = Math.round(h); out.y = y; }
      return out;
    });
    d.latest = next;
    setAnnotationsState(next);
  };
  const onResizePointerUp = (e) => {
    const d = resizeDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    resizeDragRef.current = null;
    if (d.latest) persistAnnotations(d.latest);
  };

  // The × button a right-clicked mark shows at its top-right corner
  // (at a pencil stroke's topmost point). Black with a white ring so it
  // reads on light and dark charts alike. positionStyle pins it for
  // marks whose box is the whole overlay, like a pencil stroke.
  const annDeleteBtn = (ann, positionClass, positionStyle) => (
    annMenuId === ann.id ? (
      <button
        data-testid="ann-mark-delete"
        aria-label="Delete this mark"
        title="Delete this mark"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); deleteAnn(ann.id); }}
        style={positionStyle}
        className={`absolute z-10 pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full bg-black text-white ring-1 ring-white shadow-md ${positionClass}`}
      >
        <span className="material-symbols-outlined text-[14px] leading-none">close</span>
      </button>
    ) : null
  );

  // One toolbar button: icon only, no text. Active tool inverts to white.
  const annToolBtn = (tool, label, content) => (
    <button
      key={tool}
      data-testid={`ann-tool-${tool}`}
      title={label}
      aria-label={label}
      aria-pressed={annTool === tool}
      onClick={(ev) => {
        ev.stopPropagation();
        setAnnTool(annTool === tool ? 'select' : tool);
        setSelectedAnnId(null);
        setAnnMenuId(null);
        setClearArmed(false);
      }}
      className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${annTool === tool ? 'bg-white text-black' : 'text-on-surface hover:bg-surface-bright'}`}
    >
      {content}
    </button>
  );

  useEffect(() => {
    if (trade) {
      setChartImg(resolveImg(weekId, dayName, trade.day?.img));
      setTagsState(getTags(weekId, dayName));
      setAnnotationsState(getAnnotations(weekId, dayName));
      setAnnTool('select');
      setSelectedAnnId(null);
      setAnnMenuId(null);
      setPencilDraft(null);
      pencilDrawRef.current = null;

      const savedTradeDate = getTradeDate(weekId, dayName);
      setTradeDateState(savedTradeDate);
      setPickerValue(savedTradeDate);
    }
  }, [trade, weekId, dayName]);

  // Perf 3: week-doc saves are debounced 500ms, so leaving the detail
  // page flushes the pending save for this week — a fast navigation
  // must not lose the last keystrokes. Fire-and-forget: the write
  // starts synchronously and completes in the background.
  useEffect(() => () => { flushWeekDoc(weekId); }, [weekId]);

  // Load images in tiers: medium (1600px) first for the inline chart,
  // then the full original for the lightbox. Each tier swaps in only after
  // it has decoded, so there is no flicker. The thumbnail stays as the
  // blurred placeholder until the medium lands.
  useEffect(() => {
    let cancelled = false;
    const gen = ++imgGenRef.current;
    setFullImg(null);
    setFullLoaded(false);
    setMediumImg(null);
    setMediumLoaded(false);
    setImgMeta(getImageMeta(weekId, dayName));
    const placeholder = resolveImg(weekId, dayName, trade?.day?.img);

    const preload = (url, onReady) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (cancelled || gen !== imgGenRef.current) return;
        // The decode is async: re-check the generation when it
        // resolves, not just when the load fires. Without this a
        // delete landing between onload and decode-resolve let the
        // stale tier through (bug 7, found by the noise-image spec:
        // storage was empty yet the container reappeared).
        const done = () => {
          if (cancelled || gen !== imgGenRef.current) return;
          onReady(url);
        };
        if (typeof img.decode === 'function') img.decode().then(done).catch(done);
        else done();
      };
      img.onerror = () => { /* keep the placeholder / lower tier */ };
      img.src = url;
    };

    // Medium first — fast, and what the user actually sees inline.
    resolveMediumAsync(weekId, dayName).then((medUrl) => {
      if (cancelled || gen !== imgGenRef.current || !medUrl) return;
      if (medUrl === placeholder) { setMediumImg(medUrl); setMediumLoaded(true); return; }
      preload(medUrl, (url) => { setMediumImg(url); setMediumLoaded(true); });
    }).catch(() => {});

    // Full original — for the lightbox only; also refreshes metadata.
    getStoredImgAsync(weekId, dayName).then((url) => {
      if (cancelled || gen !== imgGenRef.current || !url) return;
      setImgMeta(getImageMeta(weekId, dayName));
      if (url === placeholder) { setFullImg(url); setFullLoaded(true); return; }
      preload(url, (u) => {
        setFullImg(u); setFullLoaded(true);
        setImgMeta(getImageMeta(weekId, dayName));
        // Neighbours' medium images, when idle — opening the next trade
        // then feels instant, without decoding full charts in the background.
        preloadNeighbourImages(weekId, dayName);
      });
    }).catch(() => { /* keep the thumbnail placeholder */ });
    return () => {
      cancelled = true;
      // Perf 2: leaving the detail page (or the day changing) drops
      // this day's full + medium object URLs — the IndexedDB Blobs
      // stay, so the next visit re-creates them on demand. Without
      // this every visit leaked both tiers (~15–30 MB over 30 visits).
      evictDetailImageUrls(weekId, dayName);
    };
  }, [weekId, dayName, trade?.day?.img]);

  /* ── Save chart image to localStorage + state ── */
  const persistChart = useCallback(async (fileOrDataUrl) => {
    // Generation captured up front: if the user deletes the chart or
    // moves to another day while the upload is still in flight, the
    // epoch has moved on and this upload must not touch state (bug 7).
    const gen = imgGenRef.current;
    // Files/Blobs go straight to setStoredImg(), which stores the original
    // Blob losslessly. Do NOT run them through fileToDataUrl() first:
    // that used to compress them (max 1920px / 1MB) before storage.
    const applyUpload = (url) => {
      setChartImg(url); setFullImg(url); setFullLoaded(true); setImgMeta(getImageMeta(weekId, dayName));
      // Swap the inline chart to the 1600px medium once it exists (it is
      // generated in the background by setStoredImg, or on demand here).
      // Without this the inline chart stayed on the full 2560px image
      // after every upload, defeating the whole medium tier.
      resolveMediumAsync(weekId, dayName).then((medUrl) => {
        if (gen !== imgGenRef.current) return;
        if (medUrl) { setMediumImg(medUrl); setMediumLoaded(true); }
      }).catch(() => {});
    };
    if (fileOrDataUrl instanceof File || fileOrDataUrl instanceof Blob) {
      const url = await setStoredImg(weekId, dayName, fileOrDataUrl);
      if (gen !== imgGenRef.current) return;
      if (url) applyUpload(url);
    } else {
      const dataUrl = fileOrDataUrl;
      const url = await setStoredImg(weekId, dayName, dataUrl);
      if (gen !== imgGenRef.current) return;
      if (url) applyUpload(url);
    }
    triggerSaveIndicator();
  }, [weekId, dayName, triggerSaveIndicator]);

  /* ── Delete main chart ── */
  const deleteChart = useCallback(async () => {
    // Bump the image generation FIRST: any load or upload still in
    // flight belongs to the old chart and must not set state once it
    // resolves (bug 7 — a deleted chart reappearing ~100–500ms later).
    imgGenRef.current++;
    // UI updates first so the chart disappears instantly; the storage
    // delete is awaited afterwards, and the pending week-document save
    // (which drops the image meta) is flushed too — a reload in the same
    // instant must not resurrect the chart or its metadata.
    setChartImg(null);
    setFullImg(null);
    setFullLoaded(false);
    setMediumImg(null);
    setMediumLoaded(false);
    setImgMeta(null);
    await setStoredImg(weekId, dayName, 'DELETED');
    await flushAllWeekDocs();
  }, [weekId, dayName]);

  /* ── Main chart file input ── */
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) persistChart(file);
    e.target.value = '';
  };

  /* ── Main chart double-click ── */
  const handleChartDoubleClick = () => {
    if (hasChart) setExpanded(true);
    else fileInputRef.current?.click();
  };

  /* ── Main chart drag-and-drop ── */
  const [chartDragging, setChartDragging] = useState(false);
  const handleChartDrop = async (e) => {
    e.preventDefault();
    setChartDragging(false);
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (file) persistChart(file);
  };

  /* ── Main chart paste ── */
  const handleChartPaste = async (e) => {
    const file = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (file) {
      e.preventDefault();
      persistChart(file);
    }
  };

  /* ── Init Notes ── */
  const [notesContent, setNotesContent] = useState('');
  useEffect(() => {
    if (trade) {
      setNotesContent(getNotes(weekId, dayName) ?? trade.day?.notes ?? '');
    }
  }, [weekId, dayName, trade]);

  // Lazy editor mount (perf step 8): the notes section starts as a
  // read-only placeholder; the real Quill editor mounts when the section
  // scrolls into view (200px early, so it is ready by the time the user
  // clicks) or when the user clicks / focuses the placeholder. A click
  // also sets editorAutoFocus, so the mount puts the cursor inside —
  // the click that opens the editor never needs a second click, and no
  // keystroke typed right after it is lost to an unfocused editor.
  const notesSectionRef = useRef(null);
  const [editorMounted, setEditorMounted] = useState(false);
  const [editorAutoFocus, setEditorAutoFocus] = useState(false);
  useEffect(() => {
    if (editorMounted) return;
    const el = notesSectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setEditorMounted(true);
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [editorMounted]);
  const mountEditor = useCallback((focus) => {
    setEditorMounted(true);
    if (focus) setEditorAutoFocus(true);
  }, []);

  const persistNotes = useCallback((val) => {
    setNotesContent(val);
    setNotes(weekId, dayName, val);
    triggerSaveIndicator();
  }, [weekId, dayName, triggerSaveIndicator]);

  /* ── Trade Date ── */
  const handleDateChange = (e) => {
    const val = e.target.value;
    if (val) {
      localStorage.setItem('sb_last_trade_date', val);
    }
    setTradeDateState(val);
    setPickerValue(val);
    setTradeDate(weekId, dayName, val);
    triggerSaveIndicator();
  };
  const displayDate = tradeDate ? tradeDate.split('-').reverse().join('-') : 'Select date';

  /* ── Tags Handling ── */
  const addTag = (e) => {
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      const tag = tagInput.trim();
      // Bug 11: ignore a tag that already exists (case-insensitive) —
      // "gapup" then "GapUp" used to land as two chips, and removeTag
      // then removed all matches at once. Still clear the input, so
      // the user isn't left holding the rejected text.
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        setTagInput('');
        return;
      }
      const newTags = [...tags, tag];
      setTagsState(newTags);
      setTags(weekId, dayName, newTags);
      setTagInput('');
      triggerSaveIndicator();
    }
  };

  const removeTag = (tagToRemove) => {
    const newTags = tags.filter(t => t !== tagToRemove);
    setTagsState(newTags);
    setTags(weekId, dayName, newTags);
    triggerSaveIndicator();
  };



  if (!trade) {
    return (
      <div className="min-h-screen flex items-center justify-center text-on-surface-variant">
        <div className="text-center">
          <span className="material-symbols-outlined text-[48px] mb-4 block">search_off</span>
          <p className="font-headline-md text-headline-md">Trade not found</p>
          <button onClick={handleBack} className="mt-4 text-primary underline font-label-md">
            ← Back to journal
          </button>
        </div>
      </div>
    );
  }

  const { weekStart, weekEnd, day } = trade;

  return (
    <div
      className="antialiased min-h-screen flex flex-col items-center px-margin-desktop font-sans pt-sm pb-xl"
    >
      {/* Hidden file input for chart upload */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* ── Fullscreen lightbox ── */}
      {expanded && (
        <div
          data-testid="chart-lightbox"
          ref={lbContainerRef}
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center animate-expand cursor-crosshair touch-none select-none"
          onClick={(e) => { if (e.target === e.currentTarget && !lbDragged.current) setExpanded(false); }}
          onMouseMove={(e) => {
            if (hLineRef.current && vLineRef.current) {
              hLineRef.current.style.top = `${e.clientY}px`;
              vLineRef.current.style.left = `${e.clientX}px`;
            }
          }}
          onPointerDown={onLbPointerDown}
          onPointerMove={onLbPointerMove}
          onPointerUp={onLbPointerUp}
          onPointerCancel={onLbPointerUp}
          onDoubleClick={() => { if (lbZoomRef.current > 1) lbResetZoom(); else applyLbZoom(2); }}
        >
          {/* Crosshair Lines */}
          <div ref={hLineRef} className="pointer-events-none fixed left-0 right-0 border-t border-dashed border-white/70 z-40 mix-blend-difference" style={{ top: '-10px' }} />
          <div ref={vLineRef} className="pointer-events-none fixed top-0 bottom-0 border-l border-dashed border-white/70 z-40 mix-blend-difference" style={{ left: '-10px' }} />

          <button
            onClick={() => setExpanded(false)}
            className="absolute top-4 right-4 flex items-center justify-center w-10 h-10 rounded-full bg-surface-container border border-outline-variant text-on-surface hover:bg-surface-bright transition-colors z-[60] cursor-default"
          >
            <span className="material-symbols-outlined">close</span>
          </button>

          {/* ── Annotation toolbar — icons only, floating on top of the zoomed chart ── */}
          {picRect && (
            <div
              data-testid="ann-toolbar"
              className="absolute top-4 left-1/2 -translate-x-1/2 z-[70] flex flex-row items-center gap-1 rounded-full bg-surface-container/90 border border-outline-variant p-1.5"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {annToolBtn('select', 'Select / move', <span className="material-symbols-outlined text-[20px]">near_me</span>)}
              {annToolBtn('line', 'Horizontal line', <span className="material-symbols-outlined text-[20px]">horizontal_rule</span>)}
              {annToolBtn('pencil', 'Pencil — draw freehand', <AnnPencil size={20} />)}
              <div className="h-6 border-l border-outline-variant/50" />
              {annToolBtn('arrow-green-up', 'Green up arrow — entry', <AnnArrow color="#22c55e" dir="up" size={20} />)}
              {annToolBtn('arrow-green-down', 'Green down arrow — entry', <AnnArrow color="#22c55e" dir="down" size={20} />)}
              {annToolBtn('arrow-red-up', 'Red up arrow — exit', <AnnArrow color="#ef4444" dir="up" size={20} />)}
              {annToolBtn('arrow-red-down', 'Red down arrow — exit', <AnnArrow color="#ef4444" dir="down" size={20} />)}
              {annToolBtn('arrow-yellow', 'Yellow marker arrow', <AnnArrow color="#eab308" dir="down" size={20} />)}
              {annToolBtn('comment', 'Comment box', <span className="material-symbols-outlined text-[20px]">add_comment</span>)}
              <div className="h-6 border-l border-outline-variant/50" />
              <button data-testid="ann-delete" title="Delete selected mark" aria-label="Delete selected mark" disabled={!selectedAnnId} onClick={(e) => { e.stopPropagation(); deleteSelectedAnn(); }} className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface hover:bg-surface-bright disabled:opacity-30 transition-colors">
                <span className="material-symbols-outlined text-[20px]">delete</span>
              </button>
              <button data-testid="ann-clear" title={clearArmed ? 'Tap again to clear all marks' : 'Clear all marks'} aria-label="Clear all marks" disabled={annotations.length === 0} onClick={(e) => { e.stopPropagation(); if (clearArmed) { persistAnnotations([]); setSelectedAnnId(null); setAnnMenuId(null); setClearArmed(false); } else { setClearArmed(true); setTimeout(() => setClearArmed(false), 3000); } }} className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-30 ${clearArmed ? 'bg-red-500/20 text-red-400' : 'text-on-surface hover:bg-surface-bright'}`}>
                <span className="material-symbols-outlined text-[20px]">delete_sweep</span>
              </button>
            </div>
          )}
          {/* Full-res source, sized to FILL the viewport (not its natural
              480px thumbnail size). w-full/h-full + object-contain scales
              the image up to the viewport while preserving aspect ratio;
              the old maxHeight/maxWidth-only sizing left a small image
              centred at its natural size. While the full image is still
              decoding, the thumbnail shows blurred as a placeholder.
              Zoom/pan is a single GPU transform on this element — the
              image is never re-decoded while zooming. */}
          <img
            ref={lbImgRef}
            src={fullImg || mediumImg || chartImg}
            alt="Chart fullscreen"
            data-testid="chart-lightbox-image"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            onLoad={() => setPicRect(computePicRect())}
            style={{ transform: `translate(${lbPan.x}px, ${lbPan.y}px) scale(${lbZoom})`, transformOrigin: 'center center' }}
            className={`relative z-30 pointer-events-none h-full w-full object-contain transition-opacity duration-200 ${fullLoaded ? 'opacity-100' : 'opacity-60 blur-[2px]'}`}
          />
          {/* ── Annotation overlay — sized to the displayed picture so % coords track pan/zoom ── */}
          {picRect && (
            <div
              data-testid="ann-overlay"
              className="absolute z-40"
              style={{ left: picRect.left, top: picRect.top, width: picRect.width, height: picRect.height }}
              onPointerDown={(e) => {
                if (annTool === 'pencil' && e.button === 0) {
                  // The pencil draws freehand: pointerdown starts the
                  // stroke, pointermove extends it, pointerup stores it.
                  e.preventDefault();
                  e.stopPropagation();
                  startPencilDraw(e);
                  return;
                }
                if (annTool !== 'select' && e.button === 0) {
                  // preventDefault stops the compatibility mousedown whose
                  // default action would blur the comment box React just
                  // focused during this same pointerdown.
                  e.preventDefault();
                  e.stopPropagation();
                  placeAnnotation(e);
                }
                // Select mode: let the event bubble to the container (pan / backdrop close).
                // A right-click never places — it is for the mark menu instead.
              }}
              onPointerMove={movePencilDraw}
              onPointerUp={endPencilDraw}
              onPointerCancel={endPencilDraw}
              onClick={(e) => {
                if (annTool !== 'select' || e.target !== e.currentTarget || lbDragged.current || Date.now() - justPlacedRef.current <= 300) return;
                // An empty click dismisses the right-click delete button,
                // and closes the lightbox only while no mark is on the
                // chart yet — once a mark is there, it does nothing
                // (close with the × button or Escape instead).
                setAnnMenuId(null);
                if (annotations.length === 0) setExpanded(false);
              }}
            >
              {annotations.map((a) => {
                const selected = a.id === selectedAnnId;
                if (a.type === 'line') {
                  return (
                    <div key={a.id} data-testid="ann-mark" data-ann-type="line"
                      className="absolute left-0 right-0 cursor-move touch-none"
                      style={{ top: `${a.y}%`, height: 12, transform: 'translateY(-50%)' }}
                      onPointerDown={(e) => { if (annTool === 'select') onAnnPointerDown(e, a); }}
                      onContextMenu={(e) => onAnnContextMenu(e, a)}
                      onPointerMove={onAnnPointerMove}
                      onPointerUp={onAnnPointerUp}
                    >
                      <div className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 ${selected ? 'h-[3px] bg-amber-400' : 'h-[2px] bg-black'}`} style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.65)' }} />
                      {selected && (
                        <>
                          <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-amber-400 rounded-sm" />
                          <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-2.5 h-2.5 bg-amber-400 rounded-sm" />
                        </>
                      )}
                      {annDeleteBtn(a, 'right-2 -top-3')}
                    </div>
                  );
                }
                if (a.type === 'comment') {
                  return (
                    <div key={a.id} data-testid="ann-mark" data-ann-type="comment"
                      className={`absolute rounded ${selected ? 'ring-2 ring-white/70' : ''}`}
                      style={{ left: `${a.x}%`, top: `${a.y}%`, width: a.w ?? 180, height: a.h ?? undefined }}
                      onPointerDown={(e) => {
                        // Bug 8: swallow the event only in select mode,
                        // where the box itself handles the pointer
                        // (drag-to-move, text editing). With a draw tool
                        // armed, let it bubble to the overlay so the
                        // mark is placed / the pencil stroke starts at
                        // the click; the overlay preventDefaults, so the
                        // textarea never steals focus for the tool.
                        if (annTool === 'select') {
                          e.stopPropagation();
                          if (e.button === 0 && !e.target.closest('textarea')) onAnnPointerDown(e, a);
                        }
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        if (annTool !== 'select' || e.button !== 0) return;
                        if (e.detail === 2) {
                          // Chromium reports pointerdown detail as 0, so the
                          // click count is read from mousedown instead: the
                          // second press of a double-click arms a move that
                          // only starts once the pointer actually moves (see
                          // onPointerMove); a still double-click places the
                          // cursor instead (see onDoubleClick).
                          dblDragRef.current = { id: a.id, startX: e.clientX, startY: e.clientY, origX: a.x, origY: a.y };
                        }
                      }}
                      onPointerMove={(e) => {
                        const d = dblDragRef.current;
                        if (d && d.id === a.id) {
                          if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 7) {
                            // The double-click became a drag: move the box.
                            dblDragRef.current = null;
                            annDragRef.current = { id: d.id, pointerId: e.pointerId, startX: d.startX, startY: d.startY, origX: d.origX, origY: d.origY, origPoints: null, moved: true, latest: null };
                            e.currentTarget.setPointerCapture?.(e.pointerId);
                            onAnnPointerMove(e);
                          }
                          return;
                        }
                        onAnnPointerMove(e);
                      }}
                      onPointerUp={(e) => {
                        dblDragRef.current = null;
                        onAnnPointerUp(e);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (annTool !== 'select') return;
                        placeCursorInComment(e);
                      }}
                      onContextMenu={(e) => onAnnContextMenu(e, a)}
                    >
                      <textarea
                        data-testid="ann-comment-text"
                        value={a.text ?? ''}
                        rows={2}
                        placeholder="Type a comment…"
                        ref={(el) => { if (!el) return; if (a.h) el.style.height = ''; else autoGrowComment(el); if (a.id === focusAnnId) { el.focus(); setFocusAnnId(null); } }}
                        onChange={(e) => { updateAnnText(a.id, e.target.value, e.target); }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); e.stopPropagation(); }}
                        className={`w-full ${a.h ? 'h-full max-h-none min-h-0' : 'min-h-[48px] max-h-[200px]'} overflow-y-auto resize-none rounded bg-black/85 ${annMenuId === a.id ? 'border-2 border-dotted border-amber-400 focus:border-amber-400' : 'border border-white/40'} p-2 text-[13px] font-bold text-white outline-none placeholder:text-white/40 placeholder:font-bold`}
                      />
                      {annDeleteBtn(a, 'right-3 top-0 -translate-y-1/2')}
                      {annMenuId === a.id && (
                        <div data-testid="ann-comment-resize" className="pointer-events-none absolute inset-0 z-20">
                          {RESIZE_DIRS.map((dir) => (
                            <button
                              key={dir}
                              data-testid={`ann-resize-${dir}`}
                              aria-label={`Resize comment ${dir}`}
                              onPointerDown={(e) => startResize(e, a, dir)}
                              onPointerMove={onResizePointerMove}
                              onPointerUp={onResizePointerUp}
                              onPointerCancel={onResizePointerUp}
                              className={`pointer-events-auto absolute h-3 w-3 rounded-[2px] bg-white border border-black shadow ${RESIZE_HANDLE_POS[dir]}`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                if (a.type === 'pencil') {
                  const top = pencilTopPoint(a.points);
                  return (
                    <div key={a.id} data-testid="ann-mark" data-ann-type="pencil"
                      className="absolute inset-0 pointer-events-none"
                    >
                      <PencilStroke points={a.points} selected={selected} />
                      {/* Wide invisible hit stroke so the line is easy to
                          grab, right-click and drag — the visible stroke
                          itself is only a few px wide. */}
                      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                        <polyline
                          points={a.points.map(([x, y]) => `${x},${y}`).join(' ')}
                          fill="none" stroke="rgba(0,0,0,0)" strokeWidth="18"
                          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                          style={{ pointerEvents: 'stroke', cursor: 'move' }}
                          onPointerDown={(e) => { if (annTool === 'select') onAnnPointerDown(e, a); }}
                          onContextMenu={(e) => onAnnContextMenu(e, a)}
                          onPointerMove={onAnnPointerMove}
                          onPointerUp={onAnnPointerUp}
                        />
                      </svg>
                      {annDeleteBtn(a, '', { left: `${top[0]}%`, top: `${top[1]}%`, transform: 'translate(-50%, -50%)' })}
                    </div>
                  );
                }
                const style = ANN_ARROW_STYLE[a.type];
                if (!style) return null;
                const isUp = style.dir === 'up';
                return (
                  <div key={a.id} data-testid="ann-mark" data-ann-type={a.type}
                    className={`absolute cursor-move touch-none ${selected ? 'outline outline-2 outline-white rounded-sm' : ''}`}
                    style={{ left: `${a.x}%`, top: `${a.y}%`, transform: isUp ? 'translate(-50%, 0)' : 'translate(-50%, -100%)', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.7))' }}
                    onPointerDown={(e) => { if (annTool === 'select') onAnnPointerDown(e, a); }}
                    onContextMenu={(e) => onAnnContextMenu(e, a)}
                    onPointerMove={onAnnPointerMove}
                    onPointerUp={onAnnPointerUp}
                  >
                    <AnnArrow color={style.color} dir={style.dir} size={26} />
                    {annDeleteBtn(a, 'right-0 top-0 translate-x-1/2 -translate-y-1/2')}
                  </div>
                );
              })}
              {/* The stroke being drawn right now (live preview). */}
              {pencilDraft && <PencilStroke points={pencilDraft} selected={false} />}
            </div>
          )}
          {/* Zoom controls */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-1 rounded-full bg-surface-container/90 border border-outline-variant px-2 py-1" data-testid="lightbox-zoom-controls">
            <button onClick={(e) => { e.stopPropagation(); applyLbZoom(lbZoomRef.current / 1.25); }} data-testid="lightbox-zoom-out" aria-label="Zoom out" className="w-8 h-8 rounded-full text-on-surface hover:bg-surface-bright flex items-center justify-center"><span className="material-symbols-outlined text-[18px]">zoom_out</span></button>
            <button onClick={(e) => { e.stopPropagation(); lbResetZoom(); }} data-testid="lightbox-zoom-fit" aria-label="Fit to screen" className="px-2 h-8 rounded-full text-on-surface hover:bg-surface-bright text-[12px] font-label-md"><span data-testid="lightbox-zoom-label">{Math.round(lbZoom * 100)}%</span></button>
            <button onClick={(e) => { e.stopPropagation(); applyLbZoom(lbZoomRef.current * 1.25); }} data-testid="lightbox-zoom-in" aria-label="Zoom in" className="w-8 h-8 rounded-full text-on-surface hover:bg-surface-bright flex items-center justify-center"><span className="material-symbols-outlined text-[18px]">zoom_in</span></button>
            <button onClick={(e) => { e.stopPropagation(); lbZoomToOneToOne(); }} data-testid="lightbox-zoom-1-1" aria-label="Show at 1:1 pixels" title="1:1 pixels" className="px-2 h-8 rounded-full text-on-surface hover:bg-surface-bright text-[12px] font-label-md">1:1</button>
          </div>
        </div>
      )}

      {/* ── Back button (Floating) ── */}
      <button 
        onClick={handleBack} 
        data-testid="back-button" 
        aria-label="Back to Journal" 
        className="fixed top-4 left-4 md:top-6 md:left-6 z-40 flex items-center gap-1.5 text-on-surface-variant/80 hover:text-primary transition-all bg-[#212121]/50 backdrop-blur-md border border-[#424242]/50 px-3 py-1.5 rounded-full shadow-sm hover:bg-[#212121]/80 hover:shadow-md duration-200"
      >
        <span className="material-symbols-outlined text-[16px]">arrow_back</span>
        <span className="text-[11px] font-medium tracking-wide uppercase">Back</span>
      </button>

      {/* ── Document container ── */}
      <main
        className="w-full max-w-4xl layer-surface rounded-xl p-xl flex flex-col animate-expand flex-grow gap-md"
        style={{ animationDelay: '50ms' }}
      >
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div 
                className="flex items-center gap-2 text-on-surface-variant relative cursor-pointer" 
                onClick={() => {
                  if (!tradeDate) {
                    const lastDate = localStorage.getItem('sb_last_trade_date') || new Date().toISOString().split('T')[0];
                    setPickerValue(lastDate);
                  }
                  setTimeout(() => dateInputRef.current?.showPicker?.(), 0);
                }}
              >
                <span className="font-label-md text-label-md bg-surface-container-high px-3 py-1.5 rounded-md border border-outline-variant hover:border-primary transition-colors flex items-center gap-2">
                  {displayDate}
                  <span className="material-symbols-outlined text-[18px]">calendar_month</span>
                </span>
                <input 
                  type="date" 
                  ref={dateInputRef} 
                  value={pickerValue}
                  onChange={handleDateChange}
                  className="absolute opacity-0 pointer-events-none w-0 h-0"
                />
              </div>
              <span className="text-outline-variant">·</span>
              <span className="font-label-md text-label-md text-on-surface">{day.day}</span>
              <div className="ml-4 w-16 text-left">
                <span className={`text-[11px] font-label-md transition-opacity duration-300 ${saveStatus === 'Saving...' ? 'text-on-surface-variant' : 'text-primary'}`}>
                  {saveStatus}
                </span>
              </div>
            </div>
          </div>
          
          {/* Tags */}
          <div className="flex items-center gap-2 flex-wrap text-sm">
            {tags.map(tag => (
              <span key={tag} className="flex items-center gap-1 bg-surface-variant text-on-surface px-2 py-1 rounded-md text-[12px]">
                {tag}
                <button onClick={() => removeTag(tag)} className="text-on-surface-variant hover:text-primary mt-0.5">
                  <span className="material-symbols-outlined text-[12px]">close</span>
                </button>
              </span>
            ))}
            <input
              type="text"
              placeholder="Add tag..."
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={addTag}
              className="bg-transparent border-none text-[12px] text-on-surface-variant focus:outline-none focus:ring-0 placeholder-on-surface-variant w-24"
            />
          </div>

          <div className="border-t border-outline-variant" />
        </div>

        {/* ── Main chart ── */}
        <section className="w-full">
          {hasChart ? (
            /* Image present: show with delete button, double-click expands */
            <div
              ref={inlineContainerRef}
              className="w-full rounded-lg overflow-hidden border border-outline-variant aspect-[1916/1000] bg-surface-container-lowest relative cursor-crosshair group"
              data-testid="chart-image-container"
              tabIndex={0}
              onDoubleClick={handleChartDoubleClick}
              // Bug 3: this container used to have no drop/paste handlers,
              // so dropping a file onto the existing chart navigated the
              // whole app away to the raw image. Same handlers as the
              // empty dropzone — the drop replaces the chart.
              onDragOver={(e) => { e.preventDefault(); setChartDragging(true); }}
              onDragLeave={() => setChartDragging(false)}
              onDrop={handleChartDrop}
              onPaste={handleChartPaste}
              title="Double-click to expand · drag/drop or paste an image to replace"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                if (hLineInlineRef.current && vLineInlineRef.current) {
                  hLineInlineRef.current.style.top = `${y}px`;
                  vLineInlineRef.current.style.left = `${x}px`;
                }
              }}
            >
              {/* Inline Crosshair Lines */}
              <div ref={hLineInlineRef} className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/70 z-20 mix-blend-difference" style={{ top: '-10px' }} />
              <div ref={vLineInlineRef} className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/70 z-20 mix-blend-difference" style={{ left: '-10px' }} />

              <img
                ref={inlineImgRef}
                src={mediumImg || fullImg || chartImg}
                alt={`${day.day} chart`}
                decoding="async"
                fetchPriority="high"
                draggable={false}
                onLoad={() => setInlinePicRect(computeInlinePicRect())}
                className={`w-full h-full object-cover pointer-events-none transition-opacity duration-300 ${mediumLoaded || fullLoaded ? 'opacity-100' : 'opacity-70'}`}
              />
              {/* Read-only marks over the inline chart — the same arrows,
                  line, comments and pencil strokes from the fullscreen
                  chart, so they stay visible on the notes page. Not
                  interactive: open the fullscreen chart to move, edit or
                  delete a mark. */}
              {hasChart && inlinePicRect && annotations.length > 0 && (
                <div
                  data-testid="inline-ann-overlay"
                  className="absolute z-[5] pointer-events-none"
                  style={{ left: inlinePicRect.left, top: inlinePicRect.top, width: inlinePicRect.width, height: inlinePicRect.height }}
                >
                  {annotations.map((a) => {
                    if (a.type === 'line') {
                      return (
                        <div key={a.id} data-testid="inline-ann-mark" data-ann-type="line"
                          className="absolute left-0 right-0"
                          style={{ top: `${a.y}%`, height: 12, transform: 'translateY(-50%)' }}
                        >
                          <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-black" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.65)' }} />
                        </div>
                      );
                    }
                    if (a.type === 'comment') {
                      if (!a.text || !a.text.trim()) return null;
                      return (
                        <div key={a.id} data-testid="inline-ann-mark" data-ann-type="comment"
                          className="absolute rounded bg-black/85 border border-white/40 p-2 text-[13px] font-bold text-white whitespace-pre-wrap break-words"
                          style={{ left: `${a.x}%`, top: `${a.y}%`, width: a.w ?? 180, height: a.h ?? undefined, overflow: a.h ? 'hidden' : undefined }}
                        >
                          {a.text}
                        </div>
                      );
                    }
                    if (a.type === 'pencil') {
                      return (
                        <div key={a.id} data-testid="inline-ann-mark" data-ann-type="pencil"
                          className="absolute inset-0 pointer-events-none"
                        >
                          <PencilStroke points={a.points} selected={false} />
                        </div>
                      );
                    }
                    const style = ANN_ARROW_STYLE[a.type];
                    if (!style) return null;
                    const isUp = style.dir === 'up';
                    return (
                      <div key={a.id} data-testid="inline-ann-mark" data-ann-type={a.type}
                        className="absolute"
                        style={{ left: `${a.x}%`, top: `${a.y}%`, transform: isUp ? 'translate(-50%, 0)' : 'translate(-50%, -100%)', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.7))' }}
                      >
                        <AnnArrow color={style.color} dir={style.dir} size={26} />
                      </div>
                    );
                  })}
                </div>
              )}
              {chartDragging && (
                <div className="absolute inset-0 z-30 pointer-events-none flex flex-col items-center justify-center gap-2 bg-black/60">
                  <span className="material-symbols-outlined text-[48px] text-white">file_upload</span>
                  <p className="font-body-md text-body-md text-white text-center">Drop to replace</p>
                </div>
              )}
              <button
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); deleteChart(); }}
                className="absolute top-2 right-2 flex items-center justify-center w-8 h-8 rounded-full bg-black/60 border border-white/20 text-white opacity-0 group-hover:opacity-100 hover:bg-red-900/80 transition-all z-10"
                title="Remove image"
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
              </button>
            </div>
          ) : (
            /* No image: drag/drop zone + double-click to pick file */
            <div
              onDoubleClick={handleChartDoubleClick}
              onDragOver={(e) => { e.preventDefault(); setChartDragging(true); }}
              onDragLeave={() => setChartDragging(false)}
              onDrop={handleChartDrop}
              onPaste={handleChartPaste}
              tabIndex={0}
              data-testid="chart-dropzone"
              className={`w-full rounded-lg border-2 aspect-[1916/1000] transition-colors flex flex-col items-center justify-center cursor-pointer group focus:outline-none focus:border-primary/50 focus:bg-surface-container-high ${
                chartDragging
                  ? 'border-primary bg-surface-container-high border-solid'
                  : 'border-dashed border-outline-variant bg-surface-container-low hover:bg-surface-container-highest'
              }`}
            >
              <span
                className="material-symbols-outlined text-[48px] text-outline group-hover:text-primary-fixed-dim transition-colors mb-sm"
                style={{ fontVariationSettings: "'FILL' 0" }}
              >
                {chartDragging ? 'file_upload' : 'add_photo_alternate'}
              </span>
              <p className="font-body-md text-body-md text-on-surface-variant group-hover:text-primary transition-colors text-center px-4">
                {chartDragging ? 'Drop to upload' : 'Double-click to upload · drag & drop · or click here & Ctrl+V'}
              </p>
            </div>
          )}
        </section>

        {/* Original-image badge: proves the stored file was not downscaled */}
        {imgMeta && imgMeta.width && hasChart && (
          <div className="flex justify-end" data-testid="original-badge">
            <span className="text-[11px] font-label-md text-on-surface-variant/70 tabular-nums">
              Original · {imgMeta.width} × {imgMeta.height}
              {imgMeta.size ? ` · ${formatBytes(imgMeta.size)}` : ''}
              {imgMeta.type ? ` · ${imgMeta.type.replace('image/', '').toUpperCase()}` : ''}
            </span>
          </div>
        )}

        {/* ── Notes / freewrite area (seamless blank space, no rectangle) ── */}
        <section
          ref={notesSectionRef}
          className="w-full flex-1 flex flex-col mb-8"
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
              e.preventDefault();
            }
          }}
          onDrop={async (e) => {
            const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
            if (file) {
              e.preventDefault();
              e.stopPropagation();
              const dataUrl = await fileToDataUrl(file);
              const quill = quillRef.current?.getEditor();
              if (quill) {
                const range = quill.getSelection(true) || { index: quill.getLength() };
                quill.insertEmbed(range.index, 'image', dataUrl);
                quill.setSelection(range.index + 1);
              } else {
                persistNotes((notesContent || '') + `<p><img src="${dataUrl}" /></p>`);
              }
            }
          }}
        >
          {editorMounted ? (
            <Suspense fallback={<NotesPlaceholder value={notesContent} onMount={() => mountEditor(true)} />}>
              <NotesEditor quillRef={quillRef} value={notesContent} onChange={persistNotes} autoFocus={editorAutoFocus} />
            </Suspense>
          ) : (
            <NotesPlaceholder value={notesContent} onMount={() => mountEditor(true)} />
          )}
        </section>
      </main>

    </div>
  );
}
