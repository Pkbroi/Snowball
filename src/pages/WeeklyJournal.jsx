import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { trades } from '../data/trades.js';
import {
  setStoredImg, getStoredImgAsync,
  getStoredImg, getStoredThumb,
  getRemarks, setRemarks, getRemarksText,
  getWeekLabel, setWeekLabel,
  getExtraWeeks, setExtraWeeks, getNotesText, deleteWeekData,
  exportDatabase, importDatabase, formatDatabase, getTags, getTradeDate
} from '../data/storage.js';



/* ═══════════════════════════════════════════
   Remarks Modal
═══════════════════════════════════════════ */
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
            className="flex items-center justify-center w-8 h-8 rounded-full bg-[#111111] border border-[#222222] text-on-surface hover:bg-surface-bright transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="border-t border-[#222222] mx-xl shrink-0" />

        {/* Rich editor */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          <ReactQuill 
            theme="snow"
            value={content}
            onChange={handleChange}
            placeholder="Start writing… (formatting toolbar available)"
            className="h-full min-h-[350px] text-on-surface"
            modules={{
              toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                ['link', 'image'],
                ['clean']
              ]
            }}
          />
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
    <div className={`absolute top-1 right-1 backdrop-blur-sm px-1 rounded text-[9px] font-label-md border border-[#222222]/50 z-10 ${
      outcome === 'W' ? 'bg-[#111111]/80 text-tertiary' : 'bg-[#111111]/80 text-error'
    }`}>
      {outcome}
    </div>
  );
});

/* ═══════════════════════════════════════════
   DayCell
═══════════════════════════════════════════ */
const DayCell = memo(function DayCell({ day, weekId, weekStart, weekEnd, remarks, search, matchesSearch = false }) {
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

  // Sync if stored thumbnail or day image changes
  useEffect(() => {
    const current = getStoredThumb(weekId, day.day) || day.img || null;
    setCellImg(current);
  }, [weekId, day.day, day.img]);

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
        className={`relative border-r border-[#222222] overflow-hidden p-1 cursor-pointer transition-colors aspect-[1916/1000] ${matchesSearch ? 'bg-blue-900/60' : ''}`}
        data-testid={`day-cell-${weekId}-${day.day}`}
        onDoubleClick={goToDetail}
        title="Double-click to open detail"
      >
        <div className="absolute inset-1 border border-outline-variant/50 rounded bg-surface-container-lowest overflow-hidden">
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
      className={`relative border-r border-[#222222] overflow-hidden p-1 outline-none cursor-pointer focus:ring-1 focus:ring-inset focus:ring-outline transition-colors aspect-[1916/1000] ${matchesSearch ? 'bg-blue-900/60' : ''}`}
      data-testid={`day-cell-${weekId}-${day.day}`}
      onDoubleClick={goToDetail}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onClick={() => cellRef.current?.focus()}
      title="Double-click to open · drag/drop or paste an image · click then Ctrl+V"
    >
      <div className={`absolute inset-1 rounded border flex flex-col items-center justify-center gap-0.5 transition-colors ${
        dragging
          ? 'border-primary bg-surface-container-high border-solid'
          : 'border-outline-variant/50 border-dashed bg-surface-container-lowest'
      }`}>
        {dragging
          ? <span className="material-symbols-outlined text-[20px] text-primary">file_upload</span>
          : <>
              <span className="text-on-surface-variant/40 font-label-md text-[9px] uppercase tracking-wide text-center px-1">No Trade</span>
              <span className="text-on-surface-variant/25 font-label-md text-[8px] text-center px-1">drop / paste</span>
            </>
        }
      </div>
    </div>
  );
});

/* ═══════════════════════════════════════════
   WeekRow
═══════════════════════════════════════════ */
const WeekRow = memo(function WeekRow({ trade, onOpenRemarks, onDeleteWeek, search, gridCols, searchHits }) {
  const startRef  = useRef(null);
  const endRef    = useRef(null);

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
      <div className="p-3 border-r border-outline-variant flex flex-col justify-center gap-1 relative group/del">
        {trade.isCustom && (
          <button 
            onClick={() => onDeleteWeek(trade.id)}
            data-testid={`delete-week-${trade.id}`}
            aria-label="Delete week"
            className="absolute top-1 right-1 opacity-0 group-hover/del:opacity-100 hover:bg-error/20 hover:text-error text-on-surface-variant p-0.5 rounded transition-all"
            title="Delete custom week"
          >
            <span className="material-symbols-outlined text-[14px]">delete</span>
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
          className="font-label-md text-label-md text-on-surface bg-transparent focus:outline-none focus:bg-surface-container hover:bg-surface-container/30 rounded px-1 py-0.5 w-full placeholder-on-surface-variant/50 border-0 ring-0 focus:ring-0"
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
          className="font-label-md text-label-md text-on-surface-variant opacity-70 bg-transparent focus:outline-none focus:bg-surface-container hover:bg-surface-container/30 rounded px-1 py-0.5 w-full placeholder-on-surface-variant/50 border-0 ring-0 focus:ring-0"
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
          matchesSearch={searchHits ? searchHits.has(`${trade.id}|${day.day}`) : false}
        />
      ))}

      {/* ── Remarks — click to expand ── */}
      <div 
        className="p-3 flex items-start relative group/rem cursor-pointer hover:bg-surface-bright transition-colors"
        data-testid={`remarks-cell-${trade.id}`}
        onClick={() => onOpenRemarks(trade)}
        title="Click to add or edit remarks"
      >
        <div className="w-full font-body-md text-[13px] leading-snug text-primary font-bold line-clamp-4">
          {getRemarksText(trade.id) || <span className="text-on-surface-variant/50 font-normal">Click to add remarks…</span>}
        </div>
        <button
          className="absolute top-1.5 right-1.5 opacity-0 group-hover/rem:opacity-60 hover:!opacity-100 transition-opacity text-on-surface-variant p-0.5 rounded bg-surface-container/50"
        >
          <span className="material-symbols-outlined text-[14px]">open_in_full</span>
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

  useEffect(() => {
    const handleEsc = (e) => {
      // Block Escape while an operation is running to prevent accidental cancellation
      if (e.key === 'Escape' && !isBusy) onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose, isBusy]);

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

  const handleFormat = async () => {
    if (isBusy) return;
    if (window.confirm('Are you sure you want to delete all data? This action cannot be undone.')) {
      try {
        await formatDatabase();
        alert('All data wiped successfully. App will reload.');
        window.location.reload();
      } catch (err) {
        console.error(err);
        alert('Failed to wipe data.');
      }
    }
  };

  const pct = op.total > 0 ? Math.round((op.done / op.total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isBusy) onClose(); }}
    >
      <div className="w-full max-w-md layer-surface rounded-xl flex flex-col p-xl gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Settings</h2>
          <button
            onClick={() => { if (!isBusy) onClose(); }}
            disabled={isBusy}
            className="p-2 hover:bg-surface-bright rounded-full text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="border-t border-outline-variant" />

        {/* ── Progress panel (shown while exporting or importing) ── */}
        {isBusy && (
          <div className="flex flex-col items-center gap-3 py-4 px-2">
            <span className="material-symbols-outlined text-[32px] text-primary animate-spin select-none">
              progress_activity
            </span>
            <p className="text-on-surface font-label-md text-center leading-snug">{op.step}</p>

            {op.total > 0 && (
              <div className="w-full flex flex-col gap-1.5">
                {/* Progress bar */}
                <div className="w-full bg-surface-container-high rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300 ease-out"
                    style={{
                      width: `${pct}%`,
                      background: 'linear-gradient(90deg, var(--md-sys-color-primary, #4a8fff), var(--md-sys-color-tertiary, #1a437e))',
                    }}
                  />
                </div>
                {/* Count + percentage */}
                <div className="flex justify-between text-[11px] text-on-surface-variant tabular-nums">
                  <span>{op.done} / {op.total}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            )}

            <p className="text-[11px] text-on-surface-variant text-center mt-1">
              {op.status === 'exporting' ? 'Please keep this window open while exporting.' : 'Please keep this window open while importing.'}
            </p>
          </div>
        )}

        {/* ── Normal controls (hidden while busy) ── */}
        {!isBusy && (
          <div className="flex flex-col gap-4 py-2">
            {/* Export */}
            <div>
              <h3 className="font-label-lg text-label-lg text-on-surface">Export Database</h3>
              <p className="text-on-surface-variant text-[13px] mb-3">
                Download all your journals, remarks, and charts as a single portable file.
                Images are exported at <strong>full quality</strong> — no re-compression.
              </p>
              <button
                onClick={handleExport}
                className="w-full py-2 bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant rounded-lg text-on-surface font-label-md flex items-center justify-center gap-2 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">download</span>
                Export as JSON
              </button>
            </div>

            <div className="border-t border-outline-variant" />

            {/* Import */}
            <div>
              <h3 className="font-label-lg text-label-lg text-on-surface">Import Database</h3>
              <p className="text-on-surface-variant text-[13px] mb-1 text-error">
                Warning: Importing will overwrite your current local database!
              </p>
              <p className="text-on-surface-variant text-[12px] mb-3">
                A progress bar will appear — do not close the app until it completes.
              </p>
              <input type="file" ref={fileInputRef} accept=".json" className="hidden" onChange={handleImport} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 bg-red-900/20 hover:bg-red-900/40 border border-error/50 rounded-lg text-error font-label-md flex items-center justify-center gap-2 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">upload</span>
                Import JSON Backup
              </button>
            </div>

            <div className="border-t border-outline-variant" />

            {/* Format */}
            <div>
              <h3 className="font-label-lg text-label-lg text-on-surface">Format All Data</h3>
              <p className="text-on-surface-variant text-[13px] mb-3 text-error">
                Warning: This will permanently wipe all your journals, remarks, and charts.
              </p>
              <button
                onClick={handleFormat}
                className="w-full py-2 bg-error text-on-error hover:bg-error/90 rounded-lg font-label-md flex items-center justify-center gap-2 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">delete_forever</span>
                Wipe Clean
              </button>
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
   WeeklyJournal Page
═══════════════════════════════════════════ */
export default function WeeklyJournal() {
  const [allTrades, setAllTrades] = useState(() => [...trades, ...getExtraWeeks()]);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const search = searchParams.get('q') || '';
  const setSearch = (val) => {
    if (val) {
      setSearchParams({ q: val });
    } else {
      setSearchParams({});
    }
  };
  const [remarksModal, setRemarksModal] = useState(null);  // trade object | null
  const [showSettings, setShowSettings] = useState(false);
  const [showGoTo, setShowGoTo] = useState(false);
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

  // Persist scroll position on unmount
  useEffect(() => {
    return () => {
      if (scrollContainerRef.current && !isRestoringRef.current) {
        sessionStorage.setItem('sb_scroll_top', scrollContainerRef.current.scrollTop.toString());
        sessionStorage.setItem('sb_scroll_left', scrollContainerRef.current.scrollLeft.toString());
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
    const top = e.target.scrollTop;
    const left = e.target.scrollLeft;
    // Update the in-memory ref synchronously (safe — no layout triggered)
    scrollPos.current = { top, left };
    // rAF-throttle the sessionStorage writes: sessionStorage.setItem() is a
    // synchronous main-thread call that can block the compositor and cause
    // visible jank when fired at scroll frequency (60–120×/sec on fast devices).
    if (scrollRAF.current) cancelAnimationFrame(scrollRAF.current);
    scrollRAF.current = requestAnimationFrame(() => {
      sessionStorage.setItem('sb_scroll_top', top.toString());
      sessionStorage.setItem('sb_scroll_left', left.toString());
      scrollRAF.current = null;
    });
  }, []);

  const zoomIn  = useCallback(() => setTableZoom(z => Math.min(3.0, parseFloat((z + 0.1).toFixed(1)))), []);
  const zoomOut = useCallback(() => setTableZoom(z => Math.max(0.5, parseFloat((z - 0.1).toFixed(1)))), []);

  /* ── Add new row ── */
  const addRow = useCallback(() => {
    const weekId  = `week-custom-${Date.now()}`;
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
  const filtered = useMemo(() => {
    return allTrades.filter((t) => {
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

      // 2. Search Logic
      if (!search.trim()) return true;
      const q   = search.toLowerCase();
      const lbl = getWeekLabel(t.id) ?? { weekStart: t.weekStart, weekEnd: t.weekEnd };
      const rem = getRemarksText(t.id, t.remarks ?? '');
      return (
        lbl.weekStart.toLowerCase().includes(q) ||
        lbl.weekEnd.toLowerCase().includes(q)   ||
        rem.toLowerCase().includes(q)            ||
        t.days.some((d) => {
          const notesMatch = getNotesText(t.id, d.day, d.notes ?? '').toLowerCase().includes(q);
          const tagsMatch = getTags(t.id, d.day).some(tag => tag.toLowerCase().includes(q));
          return notesMatch || tagsMatch;
        })
      );
    });
  }, [allTrades, dateFilter, search]);

  // Search index: built ONCE per search change (one pass over all trades),
  // as a Set of "weekId|day" keys. DayCell/WeekRow just look keys up —
  // previously every cell ran getNotesText + getTags on every render,
  // so typing a search query cost O(n×5) string ops per keystroke.
  const searchHits = useMemo(() => {
    const hits = new Set();
    if (!search.trim()) return hits;
    const q = search.trim().toLowerCase();
    for (const t of allTrades) {
      for (const d of t.days) {
        const notesMatch = getNotesText(t.id, d.day, d.notes ?? '').toLowerCase().includes(q);
        const tagsMatch = getTags(t.id, d.day).some(tag => tag.toLowerCase().includes(q));
        if (notesMatch || tagsMatch) hits.add(`${t.id}|${d.day}`);
      }
    }
    return hits;
  }, [allTrades, search]);

  const initialIndex = useMemo(() => {
    if (!targetWeekId) return 0;
    const idx = filtered.findIndex((t) => t.id === targetWeekId);
    return idx >= 0 ? idx : 0;
  }, [filtered, targetWeekId]);

  return (
    <>
      {/* ── Remarks modal ── */}
      {remarksModal && (
        <RemarksModal trade={remarksModal} onClose={() => setRemarksModal(null)} />
      )}

      {/* ── Settings modal ── */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      
      {/* ── GoTo modal ── */}
      {showGoTo && <GoToModal onClose={() => setShowGoTo(false)} onApply={setDateFilter} />}

      <div className="flex h-screen w-full">
        <main className="flex-1 flex flex-col h-full bg-black relative overflow-hidden">

          {/* Top App Bar */}
          <header className="bg-[#111111] border-b border-[#222222] flex items-center w-full px-md md:px-lg h-16 shrink-0 z-30 gap-4">
            {/* Left: title + search */}
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <span className="font-headline-lg text-headline-lg font-bold text-primary shrink-0">Snowball</span>

              {/* Inline search bar */}
              <div className="relative flex items-center w-full max-w-sm">
                <span className="material-symbols-outlined absolute left-3 text-on-surface-variant text-[18px] pointer-events-none">search</span>
                <input
                  type="text"
                  data-testid="search-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-[#0a0a0a] rounded-lg border border-[#222222] py-1.5 pl-9 pr-8 text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent font-body-md text-body-md text-[13px]"
                  placeholder="Search remarks, notes, dates…"
                />
                {search && (
                  <button onClick={() => setSearch('')}
                    className="absolute right-2 text-on-surface-variant hover:text-primary transition-colors">
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

            {/* Right: zoom + add-row + settings */}
            <div className="flex items-center gap-2 text-on-surface-variant shrink-0">
              {/* Zoom controls */}
              <div className="flex items-center gap-1 bg-[#111111] border border-[#222222] rounded-lg px-1 py-0.5">
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
                <span className="text-[11px] font-bold text-on-surface-variant w-9 text-center select-none tabular-nums">
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
                className="flex items-center justify-center w-9 h-9 rounded-full border border-outline-variant transition-colors hover:opacity-90 active:scale-95"
                style={{ backgroundColor: 'rgb(26,67,126)', color: '#fff', fontSize: '22px', fontWeight: 900, lineHeight: 1 }}
                title="Add new week (Ctrl+N)"
              >
                +
              </button>

              <button onClick={() => setShowSettings(true)} data-testid="settings-btn" aria-label="Settings" className="p-2 hover:bg-surface-bright transition-colors rounded-full flex items-center justify-center" title="Settings">
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
                // Zoom is a single CSS `zoom` on the container, not a new
                // gridTemplateColumns + fontSize for every row. The old
                // approach re-laid-out and re-rendered every WeekRow on
                // each zoom step; zoom scales the fixed 1× layout instead,
                // so WeekRow props (and their memo) never change.
                const gridTemplateColumns = '96px repeat(5, minmax(225px, 1fr)) 260px';

                return (
                  <div
                    className="bg-[#111111] border border-[#222222] rounded-xl shadow-sm flex flex-col custom-scrollbar"
                    style={{
                      width: '100%',
                      minWidth: '1481px',
                      zoom: tableZoom,
                    }}
                  >
                    {/* Header row */}
                    <div
                      className="grid border-b border-[#222222] bg-[#0a0a0a] font-label-md text-label-md text-on-surface-variant uppercase tracking-wider w-full"
                      style={{
                        gridTemplateColumns,
                      }}
                    >
                      <div className="p-3 border-r border-[#222222] flex items-center">Week</div>
                      {['Monday','Tuesday','Wednesday','Thursday','Friday'].map((day) => (
                        <div key={day} className="p-3 border-r border-[#222222] flex items-center justify-between">
                          {day}
                          <span className="material-symbols-outlined text-[14px] opacity-50">calendar_today</span>
                        </div>
                      ))}
                      <div className="p-3 flex items-center">Remarks</div>
                    </div>

                    {/* Data rows */}
                    <div className="flex flex-col divide-y divide-[#222222] w-full">
                      {filtered.length > 0 ? (
                        <Virtuoso
                          ref={virtuosoRef}
                          customScrollParent={scrollParent}
                          data={filtered}
                          initialTopMostItemIndex={initialIndex}
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
