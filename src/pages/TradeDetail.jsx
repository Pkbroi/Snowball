import { useRef, useState, useCallback, useEffect } from 'react';
import { useLenis } from '../hooks/useLenis.js';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { getTradeById } from '../data/trades.js';
import { resolveImg, getStoredImgAsync, resolveMediumAsync, getImageMeta, formatBytes, preloadNeighbourImages, setStoredImg, fileToDataUrl, getNotes, setNotes, getTags, setTags, getTradeDate, setTradeDate, getAnnotations, setAnnotations } from '../data/storage.js';
import ReactQuill, { Quill } from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';



/* ─── Image Resize Handler ─────────────────────────────────────────────────
   Attaches MS-Word–style resize handles to images inside the Quill editor.
   Right-click (or click) an image → it is selected: a dotted outline with
   8 handles appears, plus a × button at the top-right corner that deletes
   the picture. Drag a handle to change the picture's width / height.
   No external deps.

   The overlay lives on the editor's CONTAINER (.ql-container), not inside
   the editor root (.ql-editor): Quill's own DOM reconciliation removes
   foreign nodes from the root, so an overlay appended there vanishes a
   moment after it appears. The container is outside Quill's blot tree
   and is position:relative, so the overlay stays put. ─────────────────── */
function ImageResizeHandler({ quillRef }) {
  useEffect(() => {
    let cleanup = () => {};

    // Quill editor may not be mounted on first tick — retry a few times
    let attempts = 0;
    const tryAttach = () => {
      attempts++;
      const quill = quillRef.current?.getEditor?.();
      const editorRoot = quill?.root;
      if (!editorRoot) {
        if (attempts < 20) setTimeout(tryAttach, 100);
        return;
      }
    // The overlay's parent: the editor container, outside Quill's blot tree.
    const container = editorRoot.parentNode;
    let overlay = null;
    let activeImg = null;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let currentHandle = null;
    let dragged = false;
    // Set on mouseup after a drag: the click that follows a drag lands on
    // the nearest common ancestor of the handle and the release point
    // (the container), which the document click handler would read as
    // "clicked outside" and use to dismiss the overlay. Skip that once.
    let justDragged = false;

    const HANDLE_SIZE = 10;

    const removeOverlay = () => {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      activeImg = null;
    };

    const makeHandle = (cursor, key) => {
      const h = document.createElement('div');
      h.dataset.handle = key;
      h.style.cssText = `
        position:absolute; width:${HANDLE_SIZE}px; height:${HANDLE_SIZE}px;
        background:#ececec; border:1.5px solid #fff; border-radius:2px;
        cursor:${cursor}; box-shadow:0 1px 3px rgba(0,0,0,.5);
        z-index:9999; transform:translate(-50%,-50%);
      `;
      return h;
    };

    const positionOverlay = (img) => {
      if (!overlay || !img) return;
      const rect = img.getBoundingClientRect();
      const contRect = container.getBoundingClientRect();
      // Both rects are viewport-relative, so no scroll offsets are needed —
      // but the picture moves when the page scrolls, so re-position on scroll.
      overlay.style.left   = `${rect.left - contRect.left}px`;
      overlay.style.top    = `${rect.top  - contRect.top}px`;
      overlay.style.width  = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };

    const reposition = () => { if (overlay && activeImg) positionOverlay(activeImg); };

    // Delete the selected picture through Quill, so the change is saved
    // like any other edit (autosave picks it up).
    const deleteActiveImg = () => {
      if (!activeImg) return;
      const blot = Quill.find(activeImg);
      if (quill && blot) {
        quill.deleteText(quill.getIndex(blot), 1);
      } else {
        activeImg.remove();
      }
      removeOverlay();
    };

    const attachOverlay = (img) => {
      removeOverlay();
      activeImg = img;

      overlay = document.createElement('div');
      overlay.dataset.testid = 'notes-img-overlay';
      overlay.style.cssText = `
        position:absolute; box-sizing:border-box;
        border:2px dotted #ececec; pointer-events:none;
        z-index:9998;
      `;

      // 8 handles: corners + edge midpoints
      const handles = [
        { key:'nw', cursor:'nw-resize',  tx:0,    ty:0    },
        { key:'n',  cursor:'n-resize',   tx:0.5,  ty:0    },
        { key:'ne', cursor:'ne-resize',  tx:1,    ty:0    },
        { key:'e',  cursor:'e-resize',   tx:1,    ty:0.5  },
        { key:'se', cursor:'se-resize',  tx:1,    ty:1    },
        { key:'s',  cursor:'s-resize',   tx:0.5,  ty:1    },
        { key:'sw', cursor:'sw-resize',  tx:0,    ty:1    },
        { key:'w',  cursor:'w-resize',   tx:0,    ty:0.5  },
      ];

      handles.forEach(({ key, cursor, tx, ty }) => {
        const h = makeHandle(cursor, key);
        h.style.pointerEvents = 'all';
        h.style.left = `${tx * 100}%`;
        h.style.top  = `${ty * 100}%`;
        h.dataset.tx = tx;
        h.dataset.ty = ty;

        h.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          currentHandle = { tx: parseFloat(h.dataset.tx), ty: parseFloat(h.dataset.ty) };
          dragged = false;
          startX = e.clientX;
          startY = e.clientY;
          startW = activeImg.offsetWidth  || activeImg.naturalWidth  || 200;
          startH = activeImg.offsetHeight || activeImg.naturalHeight || 150;
        });

        overlay.appendChild(h);
      });

      // × button at the top-right corner — deletes the picture.
      const delBtn = document.createElement('button');
      delBtn.dataset.testid = 'notes-img-delete';
      delBtn.title = 'Delete this picture';
      delBtn.setAttribute('aria-label', 'Delete this picture');
      delBtn.style.cssText = `
        position:absolute; top:0; right:0; transform:translate(50%,-50%);
        width:20px; height:20px; border-radius:9999px;
        background:#000; color:#fff; border:1px solid #fff;
        display:flex; align-items:center; justify-content:center;
        cursor:pointer; pointer-events:all; z-index:10000;
        box-shadow:0 1px 4px rgba(0,0,0,.6); padding:0;
      `;
      delBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;line-height:1">close</span>';
      delBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      delBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); deleteActiveImg(); });
      overlay.appendChild(delBtn);

      // Size label
      const label = document.createElement('div');
      label.className = '_qir_label';
      label.style.cssText = `
        position:absolute; bottom:-22px; left:0; background:#000; color:#fff;
        font-size:10px; padding:1px 5px; border-radius:3px; white-space:nowrap;
        pointer-events:none; z-index:9999;
      `;
      overlay.appendChild(label);
      overlay._label = label;

      container.appendChild(overlay);

      positionOverlay(img);
      overlay._label.textContent = `${Math.round(img.offsetWidth)} × ${Math.round(img.offsetHeight)}`;
    };

    const onMouseMove = (e) => {
      if (!currentHandle || !activeImg) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;

      const { tx, ty } = currentHandle;

      // Keep the picture's proportions while resizing: the size is saved
      // through Quill as width/height attributes, and the app's stylesheet
      // renders pictures at their natural aspect ratio for a given width
      // (height:auto), so a stretched picture would snap back to its
      // proportions on reload. Locking the ratio makes the drag and the
      // saved size agree exactly.
      const ratio = startW / startH;
      let newW = startW;
      let newH = startH;
      if (tx === 1) newW = startW + dx;
      if (tx === 0) newW = startW - dx;
      if (ty === 1) newH = startH + dy;
      if (ty === 0) newH = startH - dy;
      if (tx === 0.5) {
        // Top / bottom edge: height leads, width follows.
        newH = Math.max(20, newH);
        newW = newH * ratio;
        if (newW < 20) { newW = 20; newH = newW / ratio; }
      } else {
        // Corners and left / right edges: width leads, height follows.
        newW = Math.max(20, newW);
        newH = newW / ratio;
        if (newH < 20) { newH = 20; newW = newH * ratio; }
      }

      activeImg.style.width  = `${newW}px`;
      activeImg.style.height = `${newH}px`;

      positionOverlay(activeImg);
      if (overlay._label) {
        overlay._label.textContent = `${Math.round(newW)} × ${Math.round(newH)}`;
      }
    };

    const onMouseUp = () => {
      if (currentHandle && dragged && activeImg) {
        justDragged = true;
        // Persist the new size through Quill: a width/height set directly
        // on the img's style is not part of Quill's Delta, so it is lost
        // on reload — but the image blot stores width/height as attributes,
        // which Quill saves with the notes. Apply both, then re-point at
        // the live node in case the editor rebuilt it.
        try {
          const blot = Quill.find(activeImg);
          if (quill && blot) {
            const index = quill.getIndex(blot);
            const w = `${Math.round(activeImg.offsetWidth)}`;
            const h = `${Math.round(activeImg.offsetHeight)}`;
            quill.formatText(index, 1, 'width', w);
            quill.formatText(index, 1, 'height', h);
            const leaf = quill.getLeaf(index);
            if (leaf && leaf[0] && leaf[0].domNode) {
              activeImg = leaf[0].domNode;
              positionOverlay(activeImg);
            }
          }
        } catch { /* keep the drag's live size; saving stays best-effort */ }
      }
      currentHandle = null;
      dragged = false;
    };

    const onImgClick = (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG') return;
      e.stopPropagation();
      attachOverlay(img);
    };

    // Right-click a picture: select it (same overlay) without the
    // browser's own context menu.
    const onImgContextMenu = (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      e.preventDefault();
      e.stopPropagation();
      attachOverlay(img);
    };

    const onDocClick = (e) => {
      if (justDragged) { justDragged = false; return; }
      if (overlay && !overlay.contains(e.target) && e.target !== activeImg) {
        removeOverlay();
      }
    };

    editorRoot.addEventListener('click', onImgClick);
    editorRoot.addEventListener('contextmenu', onImgContextMenu);
    editorRoot.addEventListener('scroll', reposition);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('click', onDocClick);

    cleanup = () => {
      editorRoot.removeEventListener('click', onImgClick);
      editorRoot.removeEventListener('contextmenu', onImgContextMenu);
      editorRoot.removeEventListener('scroll', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('click', onDocClick);
      removeOverlay();
    };
    }; // end tryAttach

    tryAttach();
    return () => cleanup();
  }, [quillRef]);

  return null;
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

export default function TradeDetail() {
  const navigate  = useNavigate();
  const { id }    = useParams();
  const { state } = useLocation();
  const search = state?.search || '';

  // Apply smooth scrolling to the window for this page
  const lenisRef = useLenis();

  // Resolve trade data — prefer router state, fall back to lookup
  const trade = state ?? (() => {
    const t = getTradeById(id);
    if (!t) return null;
    const day = t.days.find((d) => d.outcome) ?? t.days[0];
    return { weekId: t.id, weekStart: t.weekStart, weekEnd: t.weekEnd, remarks: t.remarks, day };
  })();

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
     stroke until it is tapped again (or Escape). ─────────────────── */
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
  // A click that places a mark fires on the nearest common ancestor of
  // the mousedown/mouseup targets — the overlay, not the new mark — so
  // without this the click right after placing a comment (which disarms
  // to select) would look like an empty select-mode click and close the
  // lightbox. Placement stamps the time; the close handler ignores
  // clicks in the same gesture (the follow-up click lands <50ms later).
  const justPlacedRef = useRef(0);

  const persistAnnotations = useCallback((next) => {
    setAnnotationsState(next);
    setAnnotations(weekId, dayName, next);
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

  const updateAnnText = useCallback((id, text) => {
    persistAnnotations(annotations.map((a) => (a.id === id ? { ...a, text } : a)));
  }, [annotations, persistAnnotations]);

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

  // Load images in tiers: medium (1600px) first for the inline chart,
  // then the full original for the lightbox. Each tier swaps in only after
  // it has decoded, so there is no flicker. The thumbnail stays as the
  // blurred placeholder until the medium lands.
  useEffect(() => {
    let cancelled = false;
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
        if (cancelled) return;
        const done = () => onReady(url);
        if (typeof img.decode === 'function') img.decode().then(done).catch(done);
        else done();
      };
      img.onerror = () => { /* keep the placeholder / lower tier */ };
      img.src = url;
    };

    // Medium first — fast, and what the user actually sees inline.
    resolveMediumAsync(weekId, dayName).then((medUrl) => {
      if (cancelled || !medUrl) return;
      if (medUrl === placeholder) { setMediumImg(medUrl); setMediumLoaded(true); return; }
      preload(medUrl, (url) => { setMediumImg(url); setMediumLoaded(true); });
    }).catch(() => {});

    // Full original — for the lightbox only; also refreshes metadata.
    getStoredImgAsync(weekId, dayName).then((url) => {
      if (cancelled || !url) return;
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
    return () => { cancelled = true; };
  }, [weekId, dayName, trade?.day?.img]);

  // Attach the testid the notes editor tests look for (Quill renders
  // its own DOM, so the id has to be set on the editor root directly).
  useEffect(() => {
    const attachTestId = () => {
      const root = quillRef.current?.getEditor?.()?.root;
      if (root) {
        root.setAttribute('data-testid', 'notes-editor');
      }
    };
    attachTestId();
    const timer = setTimeout(attachTestId, 100);
    return () => clearTimeout(timer);
  }, []);

  /* ── Save chart image to localStorage + state ── */
  const persistChart = useCallback(async (fileOrDataUrl) => {
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
        if (medUrl) { setMediumImg(medUrl); setMediumLoaded(true); }
      }).catch(() => {});
    };
    if (fileOrDataUrl instanceof File || fileOrDataUrl instanceof Blob) {
      const url = await setStoredImg(weekId, dayName, fileOrDataUrl);
      if (url) applyUpload(url);
    } else {
      const dataUrl = fileOrDataUrl;
      const url = await setStoredImg(weekId, dayName, dataUrl);
      if (url) applyUpload(url);
    }
    triggerSaveIndicator();
  }, [weekId, dayName, triggerSaveIndicator]);

  /* ── Delete main chart ── */
  const deleteChart = useCallback(() => {
    setStoredImg(weekId, dayName, 'DELETED');
    setChartImg(null);
    setFullImg(null);
    setFullLoaded(false);
    setMediumImg(null);
    setMediumLoaded(false);
    setImgMeta(null);
  }, [weekId, dayName]);

  /* ── Main chart file input ── */
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) persistChart(file);
    e.target.value = '';
  };

  /* ── Main chart double-click ── */
  const handleChartDoubleClick = () => {
    if (chartImg) setExpanded(true);
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
      const newTags = [...tags, tagInput.trim()];
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
                      style={{ left: `${a.x}%`, top: `${a.y}%`, width: 180 }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (annTool === 'select' && !e.target.closest('textarea')) onAnnPointerDown(e, a);
                      }}
                      onContextMenu={(e) => onAnnContextMenu(e, a)}
                      onPointerMove={onAnnPointerMove}
                      onPointerUp={onAnnPointerUp}
                    >
                      <textarea
                        data-testid="ann-comment-text"
                        value={a.text ?? ''}
                        rows={2}
                        placeholder="Type a comment…"
                        ref={(el) => { autoGrowComment(el); if (el && a.id === focusAnnId) { el.focus(); setFocusAnnId(null); } }}
                        onChange={(e) => { updateAnnText(a.id, e.target.value); autoGrowComment(e.target); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); e.stopPropagation(); }}
                        className="w-full min-h-[48px] max-h-[200px] overflow-y-auto resize-none rounded bg-black/85 border border-white/40 p-2 text-[13px] font-bold text-white outline-none placeholder:text-white/40 placeholder:font-bold"
                      />
                      {annDeleteBtn(a, '-right-2 -top-2')}
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
          {chartImg ? (
            /* Image present: show with delete button, double-click expands */
            <div
              ref={inlineContainerRef}
              className="w-full rounded-lg overflow-hidden border border-outline-variant aspect-[1916/1000] bg-surface-container-lowest relative cursor-crosshair group"
              data-testid="chart-image-container"
              onDoubleClick={handleChartDoubleClick}
              title="Double-click to expand"
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
              {chartImg && inlinePicRect && annotations.length > 0 && (
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
                          style={{ left: `${a.x}%`, top: `${a.y}%`, width: 180 }}
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
        {imgMeta && imgMeta.width && chartImg && (
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
          <ReactQuill 
            ref={quillRef}
            theme="snow"
            value={notesContent}
            onChange={persistNotes}
            placeholder="Type notes here… Drag & drop or paste images anytime."
            className="flex-1 text-on-surface"
            modules={{ toolbar: false }}
          />
          <ImageResizeHandler quillRef={quillRef} />
        </section>
      </main>

    </div>
  );
}
