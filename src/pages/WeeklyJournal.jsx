import { useState, useCallback, useRef, useEffect, useLayoutEffect, memo, useMemo, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import { trades } from '../data/trades.js';
import {
  setStoredImg, getStoredImgAsync,
  getStoredImg, getStoredThumb, revokeThumbUrl,
  getRemarks, setRemarks, getRemarksPreview,
  getWeekLabel, setWeekLabel,
  getExtraWeeks, setExtraWeeks, deleteWeekData,
  exportDatabase, importDatabase, formatDatabase, deleteIndex, getTradeDate,
  getDatasets, getCurrentDataset, createDataset, switchDataset, datasetIdFor, datasetLabel,
  subscribeThumbs, resolveMediumAsync, getSearchIndex
} from '../data/storage.js';



/* ═══════════════════════════════════════════
   Remarks Modal
═══════════════════════════════════════════ */

// The remarks editor (~200KB Quill) loads only when a remarks modal is
// opened (perf step 8) — WeeklyJournal never imports react-quill-new,
// so the journal's initial load carries no editor bundle.
const RemarksEditor = lazy(() => import('./RemarksEditor.jsx'));

function RemarksModal({ trade, onClose }) {
  const [content, setContent] = useState(() => getRemarks(trade.id) ?? trade.remarks ?? '');
  const [saveStatus, setSaveStatus] = useState('');
  const timeoutRef = useRef(null);

  const handleChange = (val) => {
    setContent(val);
    setRemarks(trade.id, val);

    setSaveStatus('Saving...');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setSaveStatus('Saved ✓');
      timeoutRef.current = setTimeout(() => setSaveStatus(''), 2000);
    }, 500);
  };

  // Escape closes
  useEffect(() => {
    const fn = (e) => {
      // Don't close if escaping out of Quill's link tooltip etc, but simple escape is fine if we aren't focused.
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  const weekLabel = getWeekLabel(trade.id) ?? { weekStart: trade.weekStart, weekEnd: trade.weekEnd };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-4xl layer-surface rounded-xl flex flex-col animate-expand remarks-modal-container"
        style={{ maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-xl pt-xl pb-md shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">calendar_month</span>
            <span className="font-label-md text-label-md text-on-surface-variant">
              {weekLabel.weekStart} – {weekLabel.weekEnd}
            </span>
            <span className="text-outline-variant">·</span>
            <span className="font-label-md text-label-md text-on-surface">Remarks</span>
            
            <div className="ml-4 w-16 text-left">
              <span className={`text-[11px] font-label-md transition-opacity duration-300 ${saveStatus === 'Saving...' ? 'text-on-surface-variant' : 'text-primary'}`}>
                {saveStatus}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full bg-[#212121] border border-[#424242] text-on-surface hover:bg-surface-bright transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="border-t border-[#424242] mx-xl shrink-0" />

        {/* Rich editor */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          <Suspense fallback={<div className="h-full min-h-[350px] text-on-surface-variant px-3 py-2">Loading editor…</div>}>
            <RemarksEditor value={content} onChange={handleChange} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   OutcomeBadge
═══════════════════════════════════════════ */
const OutcomeBadge = memo(function OutcomeBadge({ outcome }) {
  if (!outcome) return null;
  return (
    <div className={`absolute top-[calc(4px*var(--tz))] right-[calc(4px*var(--tz))] backdrop-blur-sm px-[calc(4px*var(--tz))] rounded text-[calc(9px*var(--tz))] font-label-md border border-[#424242]/50 z-10 ${
      outcome === 'W' ? 'bg-[#2f2f2f]/90 text-white' : 'bg-[#2f2f2f]/90 text-white'
    }`}>
      {outcome}
    </div>
  );
});

/* ═══════════════════════════════════════════
   DayCell
═══════════════════════════════════════════ */
const DayCell = memo(function DayCell({ day, weekId, weekStart, weekEnd, remarks, search, matchesSearch = false, thumbsVersion }) {
  const navigate = useNavigate();
  // Synchronous, zero-latency retrieval from pre-cached memory!
  // NOTE: this is intentionally the 480px THUMBNAIL, not the full image.
  // The grid must never decode full-res charts (that was the scroll-jank
  // cause in the old lazy-load path). The full image is loaded only when
  // navigating to the detail page — see goToDetail() below.
  const [cellImg, setCellImg] = useState(() => getStoredThumb(weekId, day.day) || day.img || null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cellRef = useRef(null);

  // Sync if stored thumbnail or day image changes — or when this week's
  // thumbnails stream in (its per-week thumbsVersion bumps, round-2
  // improvement 1); other weeks' arrivals don't touch this cell.
  useEffect(() => {
    const current = getStoredThumb(weekId, day.day) || day.img || null;
    setCellImg(current);
  }, [weekId, day.day, day.img, thumbsVersion]);

  // Lazy thumbnail URLs (perf step 7): when this row scrolls out of
  // view Virtuoso unmounts it — drop its object URL so off-screen
  // thumbnails don't stay in memory. The blob stays cached, so the URL
  // is re-created on the next mount. Skipped while the detail page is
  // open: goToDetail may have handed this very URL to the detail page
  // as its image fallback, and revoking it would blank that image.
  // (HashRouter keeps the route in location.hash: '#/trade/…'.)
  useEffect(() => () => {
    if (!window.location.hash.startsWith('#/trade/')) revokeThumbUrl(weekId, day.day);
  }, [weekId, day.day]);

  // Hover-intent preload (perf step 9): the detail page shows the 1600px
  // medium inline, so if the user pauses on a cell (~150ms — a deliberate
  // hover, not a scroll-by), generate/cache its medium now and opening
  // the trade feels instant. The timer is cancelled on leave and on
  // unmount, so a fast scroll past rows preloads nothing. Empty cells
  // have no chart, so they preload nothing. Already-cached mediums are
  // a cheap no-op inside resolveMediumAsync.
  const hoverTimerRef = useRef(null);
  const handleMouseEnter = useCallback(() => {
    if (!cellImg) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      resolveMediumAsync(weekId, day.day).catch(() => {});
    }, 150);
  }, [cellImg, weekId, day.day]);
  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  // matchesSearch comes from the parent's search index (built once per
  // search change, see searchHits below) — this cell never runs
  // getNotesText / getTags itself, so typing no longer costs O(n×5)
  // string ops on every keystroke.
  const saveFile = useCallback(async (file) => {
    if (!file?.type.startsWith('image/')) return;
    // Pass the File straight through: setStoredImg() stores the original
    // Blob losslessly and generates the grid thumbnail separately.
    // (Previously this went through fileToDataUrl() -> browser-image-
    // compression, max 1920px / 1MB, before storage.)
    const url = await setStoredImg(weekId, day.day, file);
    setCellImg(getStoredThumb(weekId, day.day) || url);
  }, [weekId, day.day]);

  const goToDetail = useCallback(async () => {
    const container = document.querySelector('[data-testid="main-scroll-container"]');
    if (container) {
      sessionStorage.setItem('sb_scroll_top', container.scrollTop.toString());
      sessionStorage.setItem('sb_scroll_left', container.scrollLeft.toString());
    }
    sessionStorage.setItem('sb_last_week_id', weekId);
    sessionStorage.setItem('sb_last_day', day.day);

    // Pre-load the FULL-RESOLUTION image before navigating. This is the
    // other half of the zoom fix: getStoredImg() returns null when the
    // full image was never cached (initStorage only pre-caches thumbs),
    // so the old code fell back to `cellImg` — the 480px thumbnail —
    // and the detail page / lightbox could only ever show that thumbnail.
    // An IndexedDB read + Blob URL is ~10-50ms, invisible next to a
    // navigation; if it fails we still navigate with the thumbnail.
    const fullImg = await getStoredImgAsync(weekId, day.day).catch(() => null);

    navigate(`/trade/${weekId}`, {
      state: {
        weekId,
        weekStart,
        weekEnd,
        remarks,
        search,
        day: { ...day, img: fullImg || getStoredImg(weekId, day.day) || cellImg },
        scrollLeft: container ? container.scrollLeft : undefined,
        scrollTop: container ? container.scrollTop : undefined,
      },
    });
  }, [navigate, weekId, weekStart, weekEnd, remarks, search, day, cellImg]);

  const handleDrop = async (e) => {
    e.preventDefault(); setDragging(false);
    const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'));
    if (file) await saveFile(file);
  };
  const handlePaste = useCallback(async (e) => {
    const imgItem = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (file) await saveFile(file);
  }, [saveFile]);

  if (cellImg) {
    return (
      <div
        className={`relative border-r border-[#424242] overflow-hidden p-[calc(4px*var(--tz))] cursor-pointer transition-colors aspect-[1916/1000] ${matchesSearch ? 'ring-2 ring-inset ring-amber-400 bg-amber-400/10' : ''}`}
        data-testid={`day-cell-${weekId}-${day.day}`}
        onDoubleClick={goToDetail}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title="Double-click to open detail"
      >
        <div className="absolute inset-[calc(4px*var(--tz))] border border-outline-variant/50 rounded bg-surface-container-lowest overflow-hidden">
          <img alt={`${day.day} chart`} src={cellImg} decoding="async" loading="lazy"
            fetchPriority="low" draggable={false} onLoad={() => setImgLoaded(true)}
            onError={() => setImgLoaded(true)}
            className={`w-full h-full object-cover transition-opacity duration-300 hover:opacity-100 ${imgLoaded ? 'opacity-90' : 'opacity-0'}`} />
          <OutcomeBadge outcome={day.outcome} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cellRef}
      tabIndex={0}
      className={`relative border-r border-[#424242] overflow-hidden p-[calc(4px*var(--tz))] outline-none cursor-pointer focus:ring-1 focus:ring-inset focus:ring-outline transition-colors aspect-[1916/1000] ${matchesSearch ? 'ring-2 ring-inset ring-amber-400 bg-amber-400/10' : ''}`}
      data-testid={`day-cell-${weekId}-${day.day}`}
      onDoubleClick={goToDetail}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onClick={() => cellRef.current?.focus()}
      title="Double-click to open · drag/drop or paste an image · click then Ctrl+V"
    >
      <div className={`absolute inset-[calc(4px*var(--tz))] rounded border flex flex-col items-center justify-center gap-[calc(2px*var(--tz))] transition-colors ${
        dragging
          ? 'border-primary bg-surface-container-high border-solid'
          : 'border-outline-variant/50 border-dashed bg-surface-container-lowest'
      }`}>
        {dragging
          ? <span className="material-symbols-outlined text-[calc(20px*var(--tz))] text-primary">file_upload</span>
          : <>
              <span className="text-on-surface-variant/40 font-label-md text-[calc(9px*var(--tz))] uppercase tracking-wide text-center px-[calc(4px*var(--tz))]">No Trade</span>
              <span className="text-on-surface-variant/25 font-label-md text-[calc(8px*var(--tz))] text-center px-[calc(4px*var(--tz))]">drop / paste</span>
            </>
        }
      </div>
    </div>
  );
});

/* ═══════════════════════════════════════════
   WeekRow
═══════════════════════════════════════════ */
const WeekRow = memo(function WeekRow({ trade, onOpenRemarks, onDeleteWeek, search, gridCols, searchHits, remarksVersion, thumbsVersion }) {
  const startRef  = useRef(null);
  const endRef    = useRef(null);

  // Search matches for the non-day cells: remarks column and week label.
  // Same amber outline as DayCell, so every shown row explains itself.
  const remarksMatch = searchHits ? searchHits.has(`rem:${trade.id}`) : false;
  const labelMatch = searchHits ? searchHits.has(`lbl:${trade.id}`) : false;

  // The front-page cell shows the first 5 lines of the remarks in bold
  // white; recompute when this week's remarks modal closes (its
  // per-week remarksVersion bumps), because the modal saves straight to
  // storage and nothing else here changes — without it the memoised row
  // would keep showing the old text. Other rows' versions don't move,
  // so their previews are not recomputed (perf step 10).
  const remarksPreview = useMemo(() => getRemarksPreview(trade.id), [trade.id, remarksVersion]);

  // Resolved label (localStorage > static)
  const labelStored = getWeekLabel(trade.id);
  const [weekStart, setWeekStart] = useState(labelStored?.weekStart ?? trade.weekStart);
  const [weekEnd, setWeekEnd] = useState(labelStored?.weekEnd ?? trade.weekEnd);

  // Sync if trade.id changes (Virtuoso reuse)
  useEffect(() => {
    const lbl = getWeekLabel(trade.id);
    setWeekStart(lbl?.weekStart ?? trade.weekStart);
    setWeekEnd(lbl?.weekEnd ?? trade.weekEnd);
  }, [trade.id, trade.weekStart, trade.weekEnd]);

  const saveLabel = (type, val) => {
    const newStart = type === 'start' ? val : weekStart;
    const newEnd = type === 'end' ? val : weekEnd;
    setWeekLabel(trade.id, { weekStart: newStart || trade.weekStart, weekEnd: newEnd || trade.weekEnd });
  };

  const colStyle = gridCols || '96px repeat(5, minmax(225px, 1fr)) 260px';

  return (
    <div 
      className="grid hover:bg-surface-container-high transition-colors group w-full"
      data-testid={`week-row-${trade.id}`}
      style={{ 
        gridTemplateColumns: colStyle, 
      }}
    >

      {/* ── Week label — editable ── */}
      <div data-testid={`week-label-${trade.id}`} className={`p-[calc(12px*var(--tz))] border-r border-outline-variant flex flex-col justify-center gap-[calc(4px*var(--tz))] relative group/del ${labelMatch ? 'ring-2 ring-inset ring-amber-400 bg-amber-400/10' : ''}`}>
        {trade.isCustom && (
          <button 
            onClick={() => onDeleteWeek(trade.id)}
            data-testid={`delete-week-${trade.id}`}
            aria-label="Delete week"
            className="absolute top-1 right-1 opacity-0 group-hover/del:opacity-100 hover:bg-error/20 hover:text-error text-on-surface-variant p-0.5 rounded transition-all"
            title="Delete custom week"
          >
            <span className="material-symbols-outlined text-[calc(14px*var(--tz))]">delete</span>
          </button>
        )}
        <input
          ref={startRef}
          type="text"
          placeholder="Month"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          onBlur={(e) => saveLabel('start', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'ArrowDown') { 
              e.preventDefault(); 
              e.stopPropagation();
              if (endRef.current) {
                endRef.current.focus();
                const len = endRef.current.value.length;
                endRef.current.setSelectionRange(len, len);
              }
            }
          }}
          title="Click to edit"
          className="font-label-md font-bold text-on-surface bg-transparent focus:outline-none focus:bg-surface-container hover:bg-surface-container/30 rounded px-[calc(4px*var(--tz))] py-[calc(2px*var(--tz))] w-full placeholder-on-surface-variant/50 border-0 ring-0 focus:ring-0"
          style={{ fontSize: 'calc(14px * var(--tz))', lineHeight: 'calc(20px * var(--tz))' }}
        />
        <input
          ref={endRef}
          type="text"
          placeholder="Dates"
          value={weekEnd}
          onChange={(e) => setWeekEnd(e.target.value)}
          onBlur={(e) => saveLabel('end', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { 
              e.preventDefault(); 
              e.stopPropagation();
              e.currentTarget.blur(); 
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              e.stopPropagation();
              if (startRef.current) {
                startRef.current.focus();
                const len = startRef.current.value.length;
                startRef.current.setSelectionRange(len, len);
              }
            }
          }}
          title="Click to edit"
          className="font-label-md font-bold text-on-surface-variant opacity-70 bg-transparent focus:outline-none focus:bg-surface-container hover:bg-surface-container/30 rounded px-[calc(4px*var(--tz))] py-[calc(2px*var(--tz))] w-full placeholder-on-surface-variant/50 border-0 ring-0 focus:ring-0"
          style={{ fontSize: 'calc(14px * var(--tz))', lineHeight: 'calc(20px * var(--tz))' }}
        />
      </div>

      {/* ── Day cells ── */}
      {trade.days.map((day) => (
        <DayCell
          key={day.day}
          day={day}
          weekId={trade.id}
          weekStart={weekStart}
          weekEnd={weekEnd}
          remarks={trade.remarks}
          search={search}
          matchesSearch={searchHits ? searchHits.has(`day:${trade.id}|${day.day}`) : false}
          thumbsVersion={thumbsVersion}
        />
      ))}

      {/* ── Remarks — click to expand ── */}
      <div 
        className={`p-[calc(12px*var(--tz))] flex items-start relative group/rem cursor-pointer hover:bg-surface-bright transition-colors ${remarksMatch ? 'ring-2 ring-inset ring-amber-400 bg-amber-400/10' : ''}`}
        data-testid={`remarks-cell-${trade.id}`}
        onClick={() => onOpenRemarks(trade)}
        title="Click to add or edit remarks"
      >
        <div className="w-full font-body-md text-[calc(13px*var(--tz))] leading-snug text-primary font-bold line-clamp-5 whitespace-pre-line">
          {remarksPreview || <span className="text-on-surface-variant/50 font-normal">Click to add remarks…</span>}
        </div>
        <button
          className="absolute top-[calc(6px*var(--tz))] right-[calc(6px*var(--tz))] opacity-0 group-hover/rem:opacity-60 hover:!opacity-100 transition-opacity text-on-surface-variant p-[calc(2px*var(--tz))] rounded bg-surface-container/50"
        >
          <span className="material-symbols-outlined text-[calc(14px*var(--tz))]">open_in_full</span>
        </button>
      </div>
    </div>
  );
});

/* ═══════════════════════════════════════════
   Settings Modal
═══════════════════════════════════════════ */
function SettingsModal({ onClose }) {
  const fileInputRef = useRef(null);

  /**
   * op: { status: 'idle' | 'exporting' | 'importing', step: string, done: number, total: number }
   * Controls all loading states and progress rendering.
   */
  const [op, setOp] = useState({ status: 'idle', step: '', done: 0, total: 0 });
  const isBusy = op.status !== 'idle';
  // confirm: null | 'wipe' | 'delete' — the in-panel data-loss confirmation step.
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    const handleEsc = (e) => {
      // Block Escape while an operation is running to prevent accidental cancellation
      if (e.key === 'Escape' && !isBusy) {
        // Escape first backs out of the confirmation step, then closes the panel.
        if (confirm) setConfirm(null);
        else onClose();
      }
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose, isBusy, confirm]);

  const currentDs = getCurrentDataset();

  const handleExport = async () => {
    try {
      setOp({ status: 'exporting', step: 'Reading database…', done: 0, total: 0 });
      // Yield so React can paint the loading state before the async work begins
      await new Promise(r => setTimeout(r, 0));

      const jsonString = await exportDatabase((done, total) => {
        setOp(s => ({ ...s, step: `Exporting images… ${done} / ${total}`, done, total }));
      });

      setOp(s => ({ ...s, step: 'Preparing download…', done: s.total, total: s.total }));
      await new Promise(r => setTimeout(r, 0));

      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snowball-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Small delay before revoking so the browser has time to pick up the download
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setOp({ status: 'idle', step: '', done: 0, total: 0 });
    } catch (err) {
      console.error('Export failed:', err);
      setOp({ status: 'idle', step: '', done: 0, total: 0 });
      alert(`Export failed: ${err.message}`);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-selected if needed
    e.target.value = '';
    try {
      setOp({ status: 'importing', step: 'Reading file…', done: 0, total: 0 });
      await new Promise(r => setTimeout(r, 0));

      const text = await file.text();

      setOp(s => ({ ...s, step: 'Parsing backup data…' }));
      // Yield before the synchronous JSON.parse so the UI can update
      await new Promise(r => setTimeout(r, 0));

      await importDatabase(text, (done, total) => {
        setOp(s => ({
          ...s,
          step: `Restoring images… ${done} / ${total}`,
          done,
          total,
        }));
      });

      setOp(s => ({ ...s, step: 'Finishing up…' }));
      window.location.reload();
    } catch (err) {
      console.error('Import failed:', err);
      setOp({ status: 'idle', step: '', done: 0, total: 0 });
      alert(`Import failed: ${err.message}`);
    }
  };

  // Wipe only the current (index, year) combination — other indexes and years are untouched.
  const handleWipe = async () => {
    if (isBusy) return;
    try {
      setOp({ status: 'wiping', step: `Wiping ${datasetLabel(currentDs)}…`, done: 0, total: 0 });
      await formatDatabase();
      window.location.reload();
    } catch (err) {
      console.error(err);
      setOp({ status: 'idle', step: '', done: 0, total: 0 });
      alert('Failed to wipe data.');
    }
  };

  // Delete the whole index — every year — with all its data.
  const handleDelete = async () => {
    if (isBusy) return;
    try {
      setOp({ status: 'deleting', step: `Deleting ${currentDs.index}…`, done: 0, total: 0 });
      await deleteIndex(currentDs.index);
      window.location.reload();
    } catch (err) {
      console.error(err);
      setOp({ status: 'idle', step: '', done: 0, total: 0 });
      alert('Failed to delete index.');
    }
  };

  const pct = op.total > 0 ? Math.round((op.done / op.total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => { if (e.target === e.currentTarget && !isBusy) onClose(); }}
    >
      {/* Panel: top-right corner, just under the 48px header, above the Remarks column. */}
      <div
        data-testid="settings-panel"
        className="absolute top-[60px] right-4 w-[380px] max-h-[calc(100vh-76px)] overflow-y-auto bg-black border border-[#424242] rounded-xl shadow-2xl flex flex-col p-4 gap-3"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-white font-bold text-[16px]">Settings</h2>
          <button
            onClick={() => { if (!isBusy) onClose(); }}
            disabled={isBusy}
            className="w-7 h-7 flex items-center justify-center rounded-full bg-black border border-[#424242] text-white hover:bg-[#1a1a1a] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
        <div className="border-t border-[#424242]" />

        {/* ── Progress panel (shown while exporting, importing, wiping or deleting) ── */}
        {isBusy && (
          <div className="flex flex-col items-center gap-3 py-4 px-2">
            <span className="material-symbols-outlined text-[32px] text-white animate-spin select-none">
              progress_activity
            </span>
            <p className="text-white font-bold text-center leading-snug">{op.step}</p>

            {op.total > 0 && (
              <div className="w-full flex flex-col gap-1.5">
                {/* Progress bar */}
                <div className="w-full bg-[#2f2f2f] rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {/* Count + percentage */}
                <div className="flex justify-between text-[11px] text-white/60 tabular-nums">
                  <span>{op.done} / {op.total}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            )}

            {(op.status === 'exporting' || op.status === 'importing') && (
              <p className="text-[11px] text-white/60 text-center mt-1">
                {op.status === 'exporting' ? 'Please keep this window open while exporting.' : 'Please keep this window open while importing.'}
              </p>
            )}
          </div>
        )}

        {/* ── Confirmation step (after tapping a Format option) ── */}
        {!isBusy && confirm && (
          <div data-testid="format-confirm" className="flex flex-col gap-3 py-1">
            <h3 data-testid="format-confirm-title" className="text-white font-bold text-[15px]">
              {confirm === 'wipe' ? `Wipe ${datasetLabel(currentDs)}` : `Delete ${currentDs.index} — all years`}
            </h3>
            <p className="text-[#dc2626] font-bold text-[13px] leading-snug">
              {confirm === 'wipe'
                ? `This will permanently wipe every week, remark and chart for ${datasetLabel(currentDs)} only. Other indexes and years are untouched. This cannot be undone.`
                : `This will permanently delete ${currentDs.index} for every year — all weeks, remarks and charts. This cannot be undone.`}
            </p>
            <div className="flex gap-3">
              <button
                data-testid="format-confirm-cancel"
                onClick={() => setConfirm(null)}
                className="flex-1 py-2 bg-black hover:bg-[#1a1a1a] border border-[#424242] rounded-lg text-white font-bold flex items-center justify-center transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="format-confirm-ok"
                onClick={confirm === 'wipe' ? handleWipe : handleDelete}
                className="flex-1 py-2 bg-[#dc2626] hover:bg-[#b91c1c] rounded-lg text-white font-bold flex items-center justify-center transition-colors"
              >
                {confirm === 'wipe' ? `Yes, wipe ${datasetLabel(currentDs)}` : `Yes, delete ${currentDs.index}`}
              </button>
            </div>
          </div>
        )}

        {/* ── Normal controls (hidden while busy or confirming) ── */}
        {!isBusy && !confirm && (
          <div className="flex flex-col gap-3 py-1">
            {/* Export */}
            <div>
              <h3 className="text-white font-bold text-[13px] tracking-wide">EXPORT DATABASE</h3>
              <p className="text-white/60 text-[13px] mb-2">
                Your whole journal — every index and every year — in one file, images at <strong className="text-white">full quality</strong>.
              </p>
              <button
                onClick={handleExport}
                className="w-full py-2 bg-black hover:bg-[#1a1a1a] border border-[#424242] rounded-lg text-white font-bold flex items-center justify-center gap-2 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">download</span>
                Export as JSON
              </button>
            </div>

            <div className="border-t border-[#424242]" />

            {/* Import */}
            <div>
              <h3 className="text-white font-bold text-[13px] tracking-wide">IMPORT DATABASE</h3>
              <p className="text-[#dc2626] font-bold text-[13px] mb-1">
                Warning: Importing replaces your entire local database.
              </p>
              <p className="text-white/60 text-[12px] mb-2">
                Do not close the app until it completes.
              </p>
              <input type="file" ref={fileInputRef} accept=".json" className="hidden" onChange={handleImport} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 bg-black hover:bg-[#1a1a1a] border border-[#424242] rounded-lg text-white font-bold flex items-center justify-center gap-2 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">upload</span>
                Import JSON Backup
              </button>
            </div>

            <div className="border-t border-[#424242]" />

            {/* Format */}
            <div>
              <h3 className="text-white font-bold text-[13px] tracking-wide">FORMAT</h3>
              <div className="flex flex-col gap-1.5 mt-2">
                <button
                  data-testid="format-wipe-btn"
                  onClick={() => setConfirm('wipe')}
                  className="w-full py-1.5 px-3 bg-black hover:bg-[#1a1a1a] border border-[#424242] rounded-lg text-white font-bold flex items-center gap-2 transition-colors text-left"
                >
                  <span className="material-symbols-outlined text-[18px] text-[#dc2626]">warning</span>
                  <span className="flex flex-col items-start leading-tight">
                    <span>Wipe {datasetLabel(currentDs)}</span>
                    <span className="text-white/60 font-normal text-[12px]">Wipe this Index × Year only</span>
                  </span>
                </button>
                <button
                  data-testid="format-delete-btn"
                  onClick={() => setConfirm('delete')}
                  className="w-full py-1.5 px-3 bg-black hover:bg-[#1a1a1a] border border-[#424242] rounded-lg text-white font-bold flex items-center gap-2 transition-colors text-left"
                >
                  <span className="material-symbols-outlined text-[18px] text-[#dc2626]">warning</span>
                  <span className="flex flex-col items-start leading-tight">
                    <span>Delete {currentDs.index} — all years</span>
                    <span className="text-white/60 font-normal text-[12px]">Delete this index with all its data</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

}

/* ═══════════════════════════════════════════
   GoTo Modal
═══════════════════════════════════════════ */
function GoToModal({ onClose, onApply }) {
  const [tab, setTab] = useState('date'); // 'date' | 'range'
  const [dateVal, setDateVal] = useState('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-surface-container-high rounded-xl p-6 w-[340px] shadow-2xl flex flex-col gap-4 animate-expand">
        <div className="flex justify-between items-center mb-2">
          <h2 className="font-headline-sm text-on-surface font-bold">Go to</h2>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded-full hover:bg-surface-bright">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 border-b border-outline-variant font-label-md">
          <button 
            className={`pb-2 ${tab === 'date' ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
            onClick={() => setTab('date')}
          >
            Date
          </button>
          <button 
            className={`pb-2 ${tab === 'range' ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
            onClick={() => setTab('range')}
          >
            Custom range
          </button>
        </div>

        {/* Form content */}
        {tab === 'date' ? (
          <div className="flex flex-col gap-2 py-2">
            <input 
              type="date" 
              value={dateVal}
              onChange={(e) => setDateVal(e.target.value)}
              className="w-full bg-surface-container-low border border-outline-variant rounded-md py-2 px-3 text-on-surface focus:outline-none focus:border-primary"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1">
              <label className="text-on-surface-variant text-[12px] font-label-sm">From</label>
              <input 
                type="date" 
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-md py-2 px-3 text-on-surface focus:outline-none focus:border-primary"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-on-surface-variant text-[12px] font-label-sm">To</label>
              <input 
                type="date" 
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                className="w-full bg-surface-container-low border border-outline-variant rounded-md py-2 px-3 text-on-surface focus:outline-none focus:border-primary"
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-outline-variant text-on-surface font-label-md hover:bg-surface-variant transition-colors">
            Cancel
          </button>
          <button 
            onClick={() => {
              if (tab === 'date' && dateVal) onApply({ type: 'date', date: dateVal });
              else if (tab === 'range' && rangeFrom && rangeTo) onApply({ type: 'range', from: rangeFrom, to: rangeTo });
              onClose();
            }}
            className="px-4 py-2 rounded-lg bg-surface-variant text-on-surface font-label-md hover:bg-surface-bright transition-colors shadow-sm"
          >
            Go to
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Add Dataset Modal — new (index, year) combination
═══════════════════════════════════════════ */
function AddDatasetModal({ onClose, onCreated }) {
  const [indexName, setIndexName] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const existingIndexes = [...new Set(getDatasets().map((d) => d.index))];

  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose, saving]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const ds = await createDataset(indexName, year);
      await onCreated(ds.id);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <form onSubmit={handleSubmit} className="bg-surface-container-high rounded-xl p-6 w-[340px] shadow-2xl flex flex-col gap-4 animate-expand">
        <div className="flex justify-between items-center">
          <h2 className="font-headline-sm text-on-surface font-bold">Add index / year</h2>
          <button type="button" onClick={onClose} disabled={saving} className="text-on-surface-variant hover:text-on-surface transition-colors p-1 rounded-full hover:bg-surface-bright disabled:opacity-30">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <p className="text-on-surface-variant text-[13px]">
          A new combination starts with an empty journal. Your other indexes and years are untouched.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-label-md text-on-surface-variant">Index</span>
          <input
            data-testid="add-dataset-index-input"
            list="dataset-index-list"
            value={indexName}
            onChange={(e) => setIndexName(e.target.value)}
            placeholder="e.g. Bank Nifty"
            autoFocus
            className="w-full bg-[#2f2f2f] rounded-full border border-[#424242] px-4 py-2 text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary text-[13px]"
          />
          <datalist id="dataset-index-list">
            {existingIndexes.map((idx) => <option key={idx} value={idx} />)}
          </datalist>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-label-md text-on-surface-variant">Year</span>
          <input
            data-testid="add-dataset-year-input"
            type="number"
            min={2000}
            max={2100}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-full bg-[#2f2f2f] rounded-full border border-[#424242] px-4 py-2 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary text-[13px]"
          />
        </label>
        {error && <p className="text-error text-[13px]" data-testid="add-dataset-error">{error}</p>}
        <button
          type="submit"
          data-testid="add-dataset-submit"
          disabled={saving}
          className="w-full py-2 bg-white text-black rounded-full font-label-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? 'Adding…' : 'Add dataset'}
        </button>
      </form>
    </div>
  );
}

/* ═══════════════════════════════════════════
   WeeklyJournal Page
═══════════════════════════════════════════ */
export default function WeeklyJournal() {
  const [allTrades, setAllTrades] = useState(() => [...trades, ...getExtraWeeks()]);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const search = searchParams.get('q') || '';
  const setSearch = useCallback((val) => {
    if (val) {
      setSearchParams({ q: val });
    } else {
      setSearchParams({});
    }
  }, [setSearchParams]);

  // Debounced search input (perf step 11): the input updates instantly
  // (the draft is local state), but the URL query — which drives the
  // searchHits index + row filtering — is written 100ms after the user
  // stops typing, so a fast typist doesn't pay a full index rebuild +
  // re-render per keystroke. The results are identical, just ~100ms
  // later. The × button clears immediately (no debounce on a clear),
  // and the draft follows the URL when it changes elsewhere (back /
  // forward navigation, dataset switch) — unless a commit is pending,
  // in which case the pending commit wins within 100ms anyway.
  const [searchDraft, setSearchDraft] = useState(search);
  const searchTimerRef = useRef(null);
  const handleSearchChange = useCallback((val) => {
    setSearchDraft(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      setSearch(val);
    }, 100);
  }, [setSearch]);
  const clearSearch = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    setSearchDraft('');
    setSearch('');
  }, [setSearch]);
  useEffect(() => {
    if (searchTimerRef.current) return;
    setSearchDraft(search);
  }, [search]);
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  }, []);
  const [remarksModal, setRemarksModal] = useState(null);  // trade object | null
  // Per-week versions (perf step 10): bumped for ONE week when its
  // remarks modal closes, so only that memoised WeekRow re-reads the
  // remarks it just saved (the modal writes to storage directly, and no
  // other prop of the row changes on close). Previously a single global
  // counter was passed to every row, so closing any modal recomputed
  // every row's preview.
  const [remarksVersions, setRemarksVersions] = useState({});
  // Per-week versions (round-2 improvement 1): bumped for ONE week when
  // its thumbnails stream in, so only that memoised row re-reads
  // getStoredThumb and its cells fill in as their thumbnails arrive.
  // Previously a single global counter was passed to every row, so each
  // thumb batch re-rendered the whole grid. Same pattern as
  // remarksVersions.
  const [thumbsVersions, setThumbsVersions] = useState({});
  useEffect(() => subscribeThumbs((weekIds) => setThumbsVersions((prev) => {
    const next = { ...prev };
    for (const w of weekIds ?? []) next[w] = (next[w] ?? 0) + 1;
    return next;
  })), []);
  const [showSettings, setShowSettings] = useState(false);
  const [showGoTo, setShowGoTo] = useState(false);
  const [datasets, setDatasets] = useState(() => getDatasets());
  const [currentDataset, setCurrentDataset] = useState(() => getCurrentDataset());
  const [showAddDataset, setShowAddDataset] = useState(false);
  const [switchingDataset, setSwitchingDataset] = useState(false);

  const [dateFilter, setDateFilter] = useState(() => {
    try {
      const saved = sessionStorage.getItem('sb_date_filter');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [tableZoom, setTableZoom] = useState(() => {
    const saved = sessionStorage.getItem('sb_zoom');
    const parsed = saved ? parseFloat(saved) : 1.0;
    return !isNaN(parsed) && parsed >= 0.5 && parsed <= 4.0 ? parsed : 1.0;
  });

  const gridBottomRef = useRef(null);
  const virtuosoRef = useRef(null);
  // True only until the first mount commits: a zoom change remounts
  // Virtuoso (key={tableZoom} below) and must NOT re-apply
  // initialTopMostItemIndex, or the list would jump back to the top.
  const isFirstVirtuosoMount = useRef(true);
  useEffect(() => { isFirstVirtuosoMount.current = false; });

  // Preserve the scroll position across the Virtuoso remount that a zoom
  // change triggers (key={tableZoom}): unmounting the list briefly
  // empties the container, so the browser clamps scrollTop to 0. The
  // saved position (captured in zoomIn/zoomOut before the change) is
  // scaled by the zoom ratio so the same rows stay in view.
  // useLayoutEffect runs before paint, so there is no flash of the top
  // of the list.
  const prevZoomRef = useRef(tableZoom);
  useLayoutEffect(() => {
    if (prevZoomRef.current === tableZoom) return;
    const ratio = tableZoom / prevZoomRef.current;
    prevZoomRef.current = tableZoom;
    const container = scrollContainerRef.current;
    const savedTop = zoomScrollTopRef.current;
    if (!container || savedTop <= 0) return;
    const targetTop = savedTop * ratio;
    // The fresh Virtuoso instance measures its rows over the next few
    // frames; until its total height can hold the target, the browser
    // clamps the assignment. Retry until it sticks (or 10 frames pass,
    // or another zoom change supersedes this one).
    let attempts = 0;
    const restore = () => {
      const el = scrollContainerRef.current;
      if (!el || prevZoomRef.current !== tableZoom) return;
      if (el.scrollTop !== targetTop) el.scrollTop = targetTop;
      if (el.scrollTop !== targetTop && attempts++ < 10) {
        requestAnimationFrame(restore);
      }
    };
    restore();
    requestAnimationFrame(restore);
  }, [tableZoom]);
  const scrollContainerRef = useRef(null);
  const scrollContentRef = useRef(null);  // Lenis content node (inner wrapper)
  // rAF handle used to throttle sessionStorage writes in handleScroll
  const scrollRAF = useRef(null);
  const [scrollParent, setScrollParent] = useState(null);
  const scrollPos = useRef({ top: 0, left: 0 });

  const targetWeekId = location.state?.returnWeekId || sessionStorage.getItem('sb_last_week_id');
  const targetDay = location.state?.returnDay || sessionStorage.getItem('sb_last_day');

  const isRestoringRef = useRef(Boolean(sessionStorage.getItem('sb_scroll_left') || sessionStorage.getItem('sb_scroll_top') || targetWeekId));

  // No Lenis here: the journal grid uses NATIVE scrolling. Virtuoso is
  // built for native scroll, and Lenis smoothing the same container was
  // the main source of scroll fight / lag (it re-rendered rows on every
  // smooth-scroll tick). Lenis lives on for window scrolling in
  // TradeDetail only. Scroll restoration below is a direct assignment,
  // which is safe now that nothing owns the scroll position.
  // Ref callback — called by React with the DOM node once it mounts
  const scrollContainerRefCallback = useCallback((node) => {
    if (node) {
      scrollContainerRef.current = node;
      setScrollParent(node);
    }
  }, []);

  /* ── Switch index/year dataset: reloads the grid with that dataset's weeks ── */
  const handleSwitchDataset = useCallback(async (id) => {
    if (id === getCurrentDataset().id || switchingDataset) return;
    setSwitchingDataset(true);
    try {
      await switchDataset(id);
      setDatasets(getDatasets());
      setCurrentDataset(getCurrentDataset());
      setAllTrades([...trades, ...getExtraWeeks()]);
      setSearch('');
      sessionStorage.removeItem('sb_last_week_id');
      sessionStorage.removeItem('sb_last_day');
      scrollContainerRef.current?.scrollTo({ top: 0, left: 0 });
    } finally {
      setSwitchingDataset(false);
    }
  }, [switchingDataset, setSearch]);

  // Multi-frame restoration to ensure Virtuoso and layout dimensions have settled
  useEffect(() => {
    if (!scrollParent) return;

    const savedLeft = sessionStorage.getItem('sb_scroll_left');
    const savedTop = sessionStorage.getItem('sb_scroll_top');
    const targetLeft = savedLeft ? parseFloat(savedLeft) : null;
    const targetTop = savedTop ? parseFloat(savedTop) : null;

    if (targetLeft === null && targetTop === null && !targetWeekId) {
      isRestoringRef.current = false;
      return;
    }

    let attempts = 0;
    const maxAttempts = 15; // ~250ms at 60fps — enough for Virtuoso's initial render
    let animationFrameId = null;
    const finishRestore = () => {
      scrollPos.current = { top: scrollParent.scrollTop, left: scrollParent.scrollLeft };
      isRestoringRef.current = false;
    };

    const tryRestore = () => {
      attempts++;
      const container = scrollParent;
      if (!container) return;

      let cellEl = null;
      if (targetWeekId && targetDay) {
        cellEl = container.querySelector(`[data-testid="day-cell-${targetWeekId}-${targetDay}"]`);
      }

      let restored = false;

      // 1. Restore scrollLeft if grid has expanded
      if (targetLeft !== null && !isNaN(targetLeft) && container.scrollWidth > container.clientWidth) {
        container.scrollLeft = targetLeft;
        restored = true;
      }

      // 2. Restore scrollTop if list has rendered
      if (targetTop !== null && !isNaN(targetTop) && container.scrollHeight > container.clientHeight) {
        container.scrollTop = targetTop;
        restored = true;
      }

      // 3. If cell element is located, ensure it is in view and highlight it
      if (cellEl) {
        const cellRect = cellEl.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        const inHView = cellRect.left >= contRect.left && cellRect.right <= contRect.right;
        const inVView = cellRect.top >= contRect.top && cellRect.bottom <= contRect.bottom;

        if (!inHView || !inVView || targetLeft === null) {
          cellEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }

        cellEl.classList.add('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-black');
        setTimeout(() => {
          cellEl?.classList.remove('ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-black');
        }, 2000);

        finishRestore();
        return;
      }

      if (restored && !targetWeekId && attempts >= 3) {
        finishRestore();
        return;
      }

      if (attempts < maxAttempts) {
        animationFrameId = requestAnimationFrame(tryRestore);
      } else {
        if (targetLeft !== null && !isNaN(targetLeft)) container.scrollLeft = targetLeft;
        if (targetTop !== null && !isNaN(targetTop)) container.scrollTop = targetTop;
        finishRestore();
      }
    };

    animationFrameId = requestAnimationFrame(tryRestore);

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, [scrollParent, targetWeekId, targetDay]);

  // Persist scroll position on unmount — but only while the container is
  // still in the document. This cleanup runs after the node is detached,
  // and a detached scroll container reports scrollTop/scrollLeft as 0;
  // writing that clobbered the position goToDetail() had just saved, so
  // coming back from a cell always started at the top of the journal.
  useEffect(() => {
    return () => {
      const el = scrollContainerRef.current;
      if (el?.isConnected && !isRestoringRef.current) {
        sessionStorage.setItem('sb_scroll_top', el.scrollTop.toString());
        sessionStorage.setItem('sb_scroll_left', el.scrollLeft.toString());
      }
    };
  }, []);

  useEffect(() => {
    sessionStorage.setItem('sb_zoom', tableZoom.toString());
  }, [tableZoom]);

  useEffect(() => {
    if (dateFilter) {
      sessionStorage.setItem('sb_date_filter', JSON.stringify(dateFilter));
    } else {
      sessionStorage.removeItem('sb_date_filter');
    }
  }, [dateFilter]);

  const handleScroll = useCallback((e) => {
    if (isRestoringRef.current) return;
    const el = e.target;
    const top = el.scrollTop;
    const left = el.scrollLeft;
    // Update the in-memory ref synchronously (safe — no layout triggered)
    scrollPos.current = { top, left };
    // rAF-throttle the sessionStorage writes: sessionStorage.setItem() is a
    // synchronous main-thread call that can block the compositor and cause
    // visible jank when fired at scroll frequency (60–120×/sec on fast devices).
    if (scrollRAF.current) cancelAnimationFrame(scrollRAF.current);
    scrollRAF.current = requestAnimationFrame(() => {
      // Skip the write if the container was detached since the scroll
      // event — its position reads as 0 and would clobber the position
      // saved for the return trip (same trap as the unmount cleanup).
      if (el.isConnected) {
        sessionStorage.setItem('sb_scroll_top', top.toString());
        sessionStorage.setItem('sb_scroll_left', left.toString());
      }
      scrollRAF.current = null;
    });
  }, []);

  // Scroll position captured BEFORE a zoom change: the zoom remounts
  // Virtuoso (key={tableZoom}), the list briefly unmounts, and the
  // browser clamps scrollTop to 0 — which also overwrites
  // scrollPos.current via handleScroll. So the pre-zoom position must be
  // saved here, at the moment the user asks to zoom.
  const zoomScrollTopRef = useRef(0);
  const captureZoomScroll = useCallback(() => {
    zoomScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? 0;
  }, []);
  const zoomIn  = useCallback(() => { captureZoomScroll(); setTableZoom(z => Math.min(3.0, parseFloat((z + 0.1).toFixed(1)))); }, [captureZoomScroll]);
  const zoomOut = useCallback(() => { captureZoomScroll(); setTableZoom(z => Math.max(0.5, parseFloat((z - 0.1).toFixed(1)))); }, [captureZoomScroll]);

  /* ── Add new row ── */
  const addRow = useCallback(() => {
    const weekId  = `week-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // random suffix: two rapid clicks must never share an id
    const newWeek = {
      id: weekId,
      weekStart: '',
      weekEnd:   '',
      remarks:   '',
      days: ['Monday','Tuesday','Wednesday','Thursday','Friday'].map((d) => ({
        day: d, img: null, outcome: null, notes: '', instrument: null, timeframe: null, session: null, rr: null,
      })),
      isCustom: true,
    };

    const extras = [...getExtraWeeks(), newWeek];
    setExtraWeeks(extras);
    setAllTrades([...trades, ...extras]);

    // Scroll the new row into view
    setTimeout(() => {
      gridBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 80);
  }, []);

  /* ── Delete row ── */
  const deleteRow = useCallback((weekId) => {
    if (window.confirm('Are you sure you want to delete this custom week? All associated notes and remarks will be permanently deleted.')) {
      const extras = getExtraWeeks().filter(w => w.id !== weekId);
      setExtraWeeks(extras);
      deleteWeekData(weekId);
      setAllTrades([...trades, ...extras]);
    }
  }, []);

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const handleKeyDown = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      // Ctrl+N — add new row
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        addRow();
        return;
      }

      // Ctrl++ / Ctrl+= — zoom in  ('+' requires Shift on most keyboards, '=' is the unshifted key)
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
        return;
      }

      // Ctrl+- — zoom out
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addRow, zoomIn, zoomOut]);

  /* ── Ctrl+Wheel to Zoom ── */
  useEffect(() => {
    const handleWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY > 0) zoomOut();
        else zoomIn();
      }
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [zoomIn, zoomOut]);

  /* ── Search filter & Date filter (Memoized for high performance) ── */
  // Lowercased search index (round-2 improvement 2): built once per data
  // change by getSearchIndex and cached in storage — the row filter and
  // the highlight below used to re-run the notes/remarks regexes and
  // re-lowercase every haystack on every search, twice over. Only built
  // when there is a query, so a journal that is never searched pays
  // nothing for it. Aligned with allTrades by position.
  const searchIndex = useMemo(() => (search.trim() ? getSearchIndex(allTrades) : null), [allTrades, search]);

  const filtered = useMemo(() => {
    return allTrades.filter((t, i) => {
      // 1. Date Filter Logic
      if (dateFilter) {
        let passesDateFilter = false;
        const cellDates = t.days
          .map(d => getTradeDate(t.id, d.day))
          .filter(d => d !== '');

        if (cellDates.length > 0) {
          if (dateFilter.type === 'date') {
            if (cellDates.some(d => d >= dateFilter.date)) passesDateFilter = true;
          } else if (dateFilter.type === 'range') {
            if (cellDates.some(d => d >= dateFilter.from && d <= dateFilter.to)) passesDateFilter = true;
          }
        }
        if (!passesDateFilter) return false;
      }

      // 2. Search Logic (case-insensitive: the index holds lowercased
      // haystacks, so this is just `includes()` per field).
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      const e = searchIndex[i];
      return (
        e.labelStart.includes(q) ||
        e.labelEnd.includes(q)   ||
        e.remarks.includes(q)    ||
        t.days.some((d) => {
          const de = e.days[d.day];
          return de.notes.includes(q) || de.tags.some((tag) => tag.includes(q));
        })
      );
    });
  }, [allTrades, dateFilter, search, searchIndex]);

  // Search index: the precomputed lowercase index (round-2 improvement
  // 2), so the highlights cost the same cheap `includes()` scan as the
  // row filter instead of a second full pass over the raw data.
  // Query is trimmed + lowercased, haystacks lowercased: search is fully
  // case-insensitive ("gapup" == "GapUp" == "GAPUP").
  const searchHits = useMemo(() => {
    const hits = new Set();
    if (!search.trim() || !searchIndex) return hits;
    const q = search.trim().toLowerCase();
    for (const e of searchIndex) {
      if (e.labelStart.includes(q) || e.labelEnd.includes(q)) hits.add(`lbl:${e.id}`);
      if (e.remarks.includes(q)) hits.add(`rem:${e.id}`);
      for (const [dayName, de] of Object.entries(e.days)) {
        if (de.notes.includes(q) || de.tags.some((tag) => tag.includes(q))) hits.add(`day:${e.id}|${dayName}`);
      }
    }
    return hits;
  }, [search, searchIndex]);

  const initialIndex = useMemo(() => {
    if (!targetWeekId) return 0;
    const idx = filtered.findIndex((t) => t.id === targetWeekId);
    return idx >= 0 ? idx : 0;
  }, [filtered, targetWeekId]);

  return (
    <>
      {/* ── Remarks modal ── */}
      {remarksModal && (
        <RemarksModal trade={remarksModal} onClose={() => { setRemarksVersions((prev) => ({ ...prev, [remarksModal.id]: (prev[remarksModal.id] ?? 0) + 1 })); setRemarksModal(null); }} />
      )}

      {/* ── Settings modal ── */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showAddDataset && <AddDatasetModal onClose={() => setShowAddDataset(false)} onCreated={handleSwitchDataset} />}
      
      {/* ── GoTo modal ── */}
      {showGoTo && <GoToModal onClose={() => setShowGoTo(false)} onApply={setDateFilter} />}

      <div className="flex h-screen w-full">
        <main className="flex-1 flex flex-col h-full bg-black relative overflow-hidden">

          {/* Top App Bar */}
          <header className="bg-[#212121] border-b border-[#424242] flex items-center w-full px-md md:px-lg h-12 shrink-0 z-30 gap-4">
            {/* Left: title + search */}
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <span className="font-headline-lg text-headline-lg font-bold text-primary shrink-0">Snowball</span>

              {/* Inline search bar — matte black with bold white text, like the header buttons */}
              <div className="relative flex items-center w-full max-w-sm">
                <span className="material-symbols-outlined absolute left-3 text-white text-[18px] pointer-events-none">search</span>
                <input
                  type="text"
                  data-testid="search-input"
                  value={searchDraft}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full bg-black rounded-full border border-black py-1.5 pl-9 pr-8 text-white font-bold placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-body-md text-body-md text-[13px]"
                  placeholder="Search remarks, notes, dates…"
                />
                {searchDraft && (
                  <button onClick={clearSearch}
                    className="absolute right-2 text-white hover:text-primary transition-colors">
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                )}
              </div>
              {search && (
                <span className="text-[11px] font-label-sm text-on-surface-variant shrink-0 whitespace-nowrap">
                  {filtered.length} matched
                </span>
              )}
              
              <button 
                onClick={() => setShowGoTo(true)} 
                className="p-1.5 ml-2 hover:bg-surface-bright rounded text-on-surface-variant transition-colors flex items-center justify-center relative" 
                title="Go to date filter"
              >
                <span className="material-symbols-outlined text-[20px]">calendar_month</span>
                {dateFilter && <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full"></span>}
              </button>
              {dateFilter && (
                <button 
                  onClick={() => setDateFilter(null)}
                  className="text-[11px] text-error hover:underline font-label-md shrink-0"
                >
                  Clear filter
                </button>
              )}
            </div>

            {/* Centre: index + year — between the search bar and the zoom controls */}
            <div className="flex items-center gap-2 shrink-0" data-testid="dataset-selector">
              <div className="relative">
                <select
                  data-testid="dataset-index-select"
                  aria-label="Index"
                  value={currentDataset.index}
                  disabled={switchingDataset}
                  onChange={(e) => {
                    const idx = e.target.value;
                    const years = datasets.filter((d) => d.index === idx).map((d) => d.year);
                    handleSwitchDataset(datasetIdFor(idx, Math.max(...years)));
                  }}
                  className="appearance-none bg-black border border-black rounded-full pl-3 pr-7 py-1.5 text-[13px] font-label-md font-bold text-white focus:outline-none focus:ring-2 focus:ring-primary cursor-pointer disabled:opacity-50"
                >
                  {[...new Set(datasets.map((d) => d.index))].map((idx) => (
                    <option key={idx} value={idx}>{idx}</option>
                  ))}
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-[16px] text-white pointer-events-none">expand_more</span>
              </div>
              <div className="relative">
                <select
                  data-testid="dataset-year-select"
                  aria-label="Year"
                  value={currentDataset.year}
                  disabled={switchingDataset}
                  onChange={(e) => handleSwitchDataset(datasetIdFor(currentDataset.index, Number(e.target.value)))}
                  className="appearance-none bg-black border border-black rounded-full pl-3 pr-7 py-1.5 text-[13px] font-label-md font-bold text-white focus:outline-none focus:ring-2 focus:ring-primary cursor-pointer disabled:opacity-50"
                >
                  {datasets.filter((d) => d.index === currentDataset.index).map((d) => d.year).sort((a, b) => b - a).map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-[16px] text-white pointer-events-none">expand_more</span>
              </div>
              <button
                onClick={() => setShowAddDataset(true)}
                data-testid="add-dataset-btn"
                aria-label="Add index or year"
                title="Add index / year"
                className="flex items-center justify-center w-8 h-8 rounded-full border border-black bg-black text-white hover:bg-[#1a1a1a] transition-colors shrink-0"
                style={{ fontSize: '18px', fontWeight: 700, lineHeight: 1 }}
              >
                +
              </button>
            </div>

            {/* Right: zoom + add-row + settings */}
            <div className="flex items-center gap-2 text-on-surface-variant shrink-0">
              {/* Zoom controls */}
              <div className="flex items-center gap-1 bg-black border border-black rounded-full px-1 py-0.5">
                <button
                  onClick={zoomOut}
                  data-testid="zoom-out-btn"
                  aria-label="Zoom Out"
                  disabled={tableZoom <= 0.5}
                  className="w-8 h-8 flex items-center justify-center rounded text-white font-bold leading-none hover:bg-surface-bright transition-colors disabled:opacity-30 disabled:cursor-not-allowed select-none"
                  title={`Zoom out (${Math.round(tableZoom * 100)}%)`}
                  style={{ fontSize: '22px', fontWeight: 900 }}
                >
                  −
                </button>
                <span className="text-[11px] font-bold text-white w-9 text-center select-none tabular-nums">
                  {Math.round(tableZoom * 100)}%
                </span>
                <button
                  onClick={zoomIn}
                  data-testid="zoom-in-btn"
                  aria-label="Zoom In"
                  disabled={tableZoom >= 4.0}
                  className="w-8 h-8 flex items-center justify-center rounded text-white font-bold leading-none hover:bg-surface-bright transition-colors disabled:opacity-30 disabled:cursor-not-allowed select-none"
                  title={`Zoom in (${Math.round(tableZoom * 100)}%)`}
                  style={{ fontSize: '22px', fontWeight: 900 }}
                >
                  +
                </button>
              </div>

              {/* Add new week row */}
              <button
                onClick={addRow}
                data-testid="add-week-btn"
                aria-label="Add new week"
                className="flex items-center justify-center w-9 h-9 rounded-full border border-black transition-colors hover:opacity-90 active:scale-95"
                style={{ backgroundColor: '#000000', color: '#ffffff', fontSize: '22px', fontWeight: 900, lineHeight: 1 }}
                title="Add new week (Ctrl+N)"
              >
                +
              </button>

              <button onClick={() => setShowSettings(true)} data-testid="settings-btn" aria-label="Settings" className="w-9 h-9 flex items-center justify-center rounded-full bg-black border border-black text-white hover:bg-[#1a1a1a] transition-colors" title="Settings">
                <span className="material-symbols-outlined">settings</span>
              </button>
            </div>
          </header>

          {/* Workspace — scrolls only on the inner grid area */}
          <div
            ref={scrollContainerRefCallback}
            data-testid="main-scroll-container"
            onScroll={handleScroll}
            className="flex-1 overflow-auto custom-scrollbar w-full"
          >
            <div ref={scrollContentRef} className="w-full h-full">

              {/* Grid */}
              <div className="w-full">
              {(() => {
                // Zoom is REAL layout scaling, not CSS `zoom`: the grid
                // carries a --tz variable and every size is calc(Npx *
                // var(--tz)). CSS `zoom` made Virtuoso measure rows in
                // visual px (getBoundingClientRect) while scrolling in
                // layout px — the mismatch accumulated down the list and
                // rows vanished from 110% up (worse at 120%). With layout
                // scaling, measured == scrolled at every zoom, and
                // WeekRow props (and their memo) still never change.
                const gridTemplateColumns = 'calc(96px * var(--tz)) repeat(5, minmax(calc(225px * var(--tz)), 1fr)) calc(260px * var(--tz))';

                return (
                  <div
                    className="bg-[#212121] border border-[#424242] rounded-xl shadow-sm flex flex-col custom-scrollbar"
                    style={{
                      '--tz': tableZoom,
                      width: '100%',
                      minWidth: 'calc(1481px * var(--tz))',
                    }}
                  >
                    {/* Header row — matte black with bold white text, like the header buttons */}
                    <div
                      className="grid border-b border-[#424242] bg-black font-label-md font-bold text-white uppercase tracking-wider w-full"
                      style={{
                        gridTemplateColumns,
                        fontSize: 'calc(14px * var(--tz))',
                        lineHeight: 'calc(20px * var(--tz))',
                      }}
                    >
                      <div className="p-[calc(8px*var(--tz))] border-r border-[#424242] flex items-center">Week</div>
                      {['Monday','Tuesday','Wednesday','Thursday','Friday'].map((day) => (
                        <div key={day} className="p-[calc(8px*var(--tz))] border-r border-[#424242] flex items-center justify-between">
                          {day}
                          <span className="material-symbols-outlined text-[calc(14px*var(--tz))] opacity-50">calendar_today</span>
                        </div>
                      ))}
                      <div className="p-[calc(8px*var(--tz))] flex items-center">Remarks</div>
                    </div>

                    {/* Data rows */}
                    <div className="flex flex-col divide-y divide-[#424242] w-full">
                      {filtered.length > 0 ? (
                        <Virtuoso
                          ref={virtuosoRef}
                          // Remount on zoom change: Virtuoso caches measured
                          // row heights per index, and sizes measured at the
                          // old zoom are wrong at the new one — the cached
                          // total stays short, the window is computed from
                          // it, and rows vanish while scrolling. A fresh
                          // instance measures everything at the new zoom.
                          // The scroll container itself is not remounted,
                          // so scrollTop survives; only the first mount
                          // takes initialTopMostItemIndex.
                          key={tableZoom}
                          customScrollParent={scrollParent}
                          data={filtered}
                          initialTopMostItemIndex={isFirstVirtuosoMount.current ? initialIndex : undefined}
                          // 600px overscan + 500px extra viewport rendered
                          // ~3x more rows (and decoded thumbnails) than the
                          // viewport needs — the main scroll-jank contributor
                          // with Lenis, which re-renders on every scroll tick.
                          // 200px is plenty for a smooth, gap-free scroll.
                          overscan={{ main: 200, reverse: 200 }}
                          increaseViewportBy={{ top: 200, bottom: 200 }}
                          itemContent={(index, trade) => (
                            <WeekRow 
                              key={trade.id} 
                              trade={trade} 
                              onOpenRemarks={setRemarksModal} 
                              onDeleteWeek={deleteRow} 
                              search={search}
                              gridCols={gridTemplateColumns}
                              searchHits={searchHits}
                              remarksVersion={remarksVersions[trade.id] ?? 0}
                              thumbsVersion={thumbsVersions[trade.id] ?? 0}
                            />
                          )}
                        />
                      ) : (
                        <div className="py-16 text-center text-on-surface-variant font-label-md text-label-md">
                          {search ? `No rows matched "${search}"` : 'No entries yet — click + to add a week'}
                        </div>
                      )}
                      <div ref={gridBottomRef} />
                    </div>
                  </div>
                );
              })()}
              </div>{/* end grid wrapper */}

            </div>
          </div>

        </main>
      </div>
    </>
  );
}
