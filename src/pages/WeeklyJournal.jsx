import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trades } from '../data/trades.js';
import {
  resolveImg, resolveImgAsync, setStoredImg, fileToDataUrl, getStoredImgAsync,
  getRemarks, setRemarks, getRemarksText,
  getWeekLabel, setWeekLabel,
  getExtraWeeks, setExtraWeeks, getNotesText, deleteWeekData,
  exportDatabase, importDatabase, formatDatabase, getTags, getTradeDate
} from '../data/storage.js';

/* ═══════════════════════════════════════════
   Global IntersectionObserver for Lazy Loading
═══════════════════════════════════════════ */
let globalObserver = null;
const observerCallbacks = new Map();

function getGlobalObserver() {
  if (!globalObserver) {
    globalObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const cb = observerCallbacks.get(entry.target);
          if (cb) {
            cb();
            globalObserver.unobserve(entry.target);
            observerCallbacks.delete(entry.target);
          }
        }
      });
    }, { rootMargin: '300px' });
  }
  return globalObserver;
}

function observeElement(el, callback) {
  observerCallbacks.set(el, callback);
  getGlobalObserver().observe(el);
}

function unobserveElement(el) {
  observerCallbacks.delete(el);
  if (globalObserver) globalObserver.unobserve(el);
}

/* ═══════════════════════════════════════════
   Shared rich-editor DOM helpers
═══════════════════════════════════════════ */
function attachResizeHandles(wrapper, img) {
  const handles = [
    { dir: 'n', css: 'top:-5px;left:50%;transform:translateX(-50%);width:44px;height:10px;cursor:n-resize;' },
    { dir: 'e', css: 'top:50%;right:-5px;transform:translateY(-50%);width:10px;height:44px;cursor:e-resize;' },
    { dir: 's', css: 'bottom:-5px;left:50%;transform:translateX(-50%);width:44px;height:10px;cursor:s-resize;' },
    { dir: 'w', css: 'top:50%;left:-5px;transform:translateY(-50%);width:10px;height:44px;cursor:w-resize;' },
  ];
  handles.forEach(({ dir, css }) => {
    const h = document.createElement('span');
    h.dataset.resizeDir = dir;
    h.style.cssText = `position:absolute;${css}background:#6b7280;border-radius:6px;opacity:0;transition:opacity 0.15s;z-index:20;`;
    h.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, sw = img.offsetWidth, sh = img.offsetHeight;
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (dir === 'e') img.style.width  = `${Math.max(60, sw + dx)}px`;
        if (dir === 'w') img.style.width  = `${Math.max(60, sw - dx)}px`;
        if (dir === 's') img.style.height = `${Math.max(40, sh + dy)}px`;
        if (dir === 'n') img.style.height = `${Math.max(40, sh - dy)}px`;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    wrapper.appendChild(h);
  });
  const show = () => wrapper.querySelectorAll('[data-resize-dir]').forEach(h => (h.style.opacity = '1'));
  const hide = () => wrapper.querySelectorAll('[data-resize-dir]').forEach(h => (h.style.opacity = '0'));
  wrapper.addEventListener('mouseenter', show);
  wrapper.addEventListener('mouseleave', hide);
}

function insertResizableImage(src, editor) {
  if (!editor) return;
  editor.focus();
  const wrapper = document.createElement('span');
  wrapper.contentEditable = 'false';
  wrapper.style.cssText = 'display:inline-block;position:relative;line-height:0;margin:6px 2px;vertical-align:middle;user-select:none;';
  const img = document.createElement('img');
  img.src = src; img.draggable = false;
  img.style.cssText = 'display:block;width:320px;height:auto;border-radius:4px;';
  wrapper.appendChild(img);
  attachResizeHandles(wrapper, img);
  const sel = window.getSelection();
  if (sel?.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents(); range.insertNode(wrapper);
    const after = document.createRange();
    after.setStartAfter(wrapper); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);
  } else { editor.appendChild(wrapper); }
}

/* ─── Hook: rich editor (font-size menu + image paste) ─── */
function useRichEditor(editorRef, onContentChange) {
  const savedRange = useRef(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28];

  const handleCtxMenu = useCallback((e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel?.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const dismissCtxMenu = useCallback(() => setCtxMenu(null), []);

  const applyFontSize = useCallback((size) => {
    setCtxMenu(null);
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    if (savedRange.current) {
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(savedRange.current);
    }
    const span = document.createElement('span');
    span.style.fontSize = `${size}px`; span.style.lineHeight = '1.7';
    span.appendChild(document.createTextNode('\u200B'));
    const sel = window.getSelection();
    if (sel?.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.collapse(true); range.insertNode(span);
      const nr = document.createRange();
      nr.setStart(span.firstChild, 1); nr.collapse(true);
      sel.removeAllRanges(); sel.addRange(nr);
    }
    if (onContentChange) onContentChange();
  }, [editorRef, onContentChange]);

  const handlePaste = useCallback((e) => {
    const imgItem = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const blob = imgItem.getAsFile();
    if (blob) {
      fileToDataUrl(blob).then(dataUrl => {
        insertResizableImage(dataUrl, editorRef.current);
        if (onContentChange) onContentChange();
      });
    }
  }, [editorRef, onContentChange]);

  const CtxMenuEl = ctxMenu ? (
    <div
      className="fixed z-[70] layer-overlay rounded-lg py-1 shadow-xl min-w-[160px]"
      style={{ top: ctxMenu.y, left: ctxMenu.x }}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="px-3 py-1 text-[10px] uppercase tracking-widest text-on-surface-variant font-label-sm border-b border-outline-variant mb-1">
        Font size
      </p>
      {FONT_SIZES.map((size) => (
        <button key={size} onClick={() => applyFontSize(size)}
          className="w-full text-left px-4 py-1.5 text-[13px] font-label-md hover:bg-surface-bright transition-colors text-on-surface">
          {size}px
        </button>
      ))}
    </div>
  ) : null;

  return { handleCtxMenu, dismissCtxMenu, handlePaste, CtxMenuEl };
}

/* ═══════════════════════════════════════════
   Remarks Modal
═══════════════════════════════════════════ */
function RemarksModal({ trade, onClose }) {
  const editorRef = useRef(null);
  const [saveStatus, setSaveStatus] = useState('');
  const timeoutRef = useRef(null);

  // Save on every keystroke
  const persist = useCallback(() => {
    const el = editorRef.current;
    if (el) setRemarks(trade.id, el.innerHTML);

    setSaveStatus('Saving...');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setSaveStatus('Saved ✓');
      timeoutRef.current = setTimeout(() => setSaveStatus(''), 2000);
    }, 500);
  }, [trade.id]);

  const { handleCtxMenu, dismissCtxMenu, handlePaste, CtxMenuEl } = useRichEditor(editorRef, persist);

  // Init content
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = getRemarks(trade.id) ?? trade.remarks ?? '';
    el.focus();
  }, [trade.id, trade.remarks]);

  // Escape closes
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);

  const weekLabel = getWeekLabel(trade.id) ?? { weekStart: trade.weekStart, weekEnd: trade.weekEnd };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); dismissCtxMenu(); }}
    >
      <div
        className="w-full max-w-4xl layer-surface rounded-xl flex flex-col animate-expand"
        style={{ maxHeight: '90vh' }}
        onClick={dismissCtxMenu}
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
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onContextMenu={handleCtxMenu}
          onPaste={handlePaste}
          onInput={persist}
          placeholder="Start writing… right-click to change font size, paste images"
          spellCheck={false}
          className="flex-1 overflow-y-auto bg-transparent text-on-surface focus:outline-none cursor-text custom-scrollbar px-xl py-md"
          style={{ fontSize: '16px', lineHeight: 1.7, wordBreak: 'break-word', minHeight: '400px' }}
        />
      </div>

      {CtxMenuEl}
    </div>
  );
}

/* ═══════════════════════════════════════════
   OutcomeBadge
═══════════════════════════════════════════ */
function OutcomeBadge({ outcome }) {
  if (!outcome) return null;
  return (
    <div className={`absolute top-1 right-1 backdrop-blur-sm px-1 rounded text-[9px] font-label-md border border-[#222222]/50 z-10 ${
      outcome === 'W' ? 'bg-[#111111]/80 text-tertiary' : 'bg-[#111111]/80 text-error'
    }`}>
      {outcome}
    </div>
  );
}

/* ═══════════════════════════════════════════
   DayCell
═══════════════════════════════════════════ */
function DayCell({ day, weekId, weekStart, weekEnd, remarks, search }) {
  const navigate = useNavigate();
  const [cellImg, setCellImg] = useState(() => day.img || null);
  const [isVisible, setIsVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cellRef = useRef(null);
  
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    observeElement(el, () => setIsVisible(true));
    return () => unobserveElement(el);
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    let active = true;
    getStoredImgAsync(weekId, day.day).then(img => {
      if (!active) return;
      if (img !== undefined && img !== null) {
        setCellImg(img);
      } else if (day.img) {
        setCellImg(day.img);
      } else {
        setCellImg(null);
      }
    });
    return () => { active = false; };
  }, [isVisible, weekId, day.day, day.img]);

  const notesText = getNotesText(weekId, day.day, day.notes ?? '');
  const tags = getTags(weekId, day.day);
  const matchesSearch = search && search.trim() !== '' && (notesText.toLowerCase().includes(search.toLowerCase()) || tags.some(t => t.toLowerCase().includes(search.toLowerCase())));

  const saveFile = useCallback(async (file) => {
    if (!file?.type.startsWith('image/')) return;
    const dataUrl = await fileToDataUrl(file);
    setStoredImg(weekId, day.day, dataUrl);
    setCellImg(dataUrl);
  }, [weekId, day.day]);

  const goToDetail = useCallback(() => {
    navigate(`/trade/${weekId}`, {
      state: { weekId, weekStart, weekEnd, remarks, search, day: { ...day, img: cellImg } },
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
        className={`relative border-r border-[#222222] overflow-hidden p-1 cursor-pointer transition-colors ${matchesSearch ? 'bg-blue-900/60' : ''}`}
        data-testid={`day-cell-${weekId}-${day.day}`}
        onDoubleClick={goToDetail}
        title="Double-click to open detail"
      >
        <div className="absolute inset-1 border border-outline-variant/50 rounded bg-surface-container-lowest overflow-hidden">
          <img alt={`${day.day} chart`} src={cellImg} loading="lazy" decoding="async"
            className="w-full h-full object-cover opacity-80 hover:opacity-100 transition-opacity" />
          <OutcomeBadge outcome={day.outcome} />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cellRef}
      tabIndex={0}
      className={`relative border-r border-[#222222] overflow-hidden p-1 outline-none cursor-pointer focus:ring-1 focus:ring-inset focus:ring-outline transition-colors ${matchesSearch ? 'bg-blue-900/60' : ''}`}
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
}

/* ═══════════════════════════════════════════
   WeekRow
═══════════════════════════════════════════ */
function WeekRow({ trade, onOpenRemarks, onDeleteWeek, search }) {
  const startRef  = useRef(null);
  const endRef    = useRef(null);

  // Resolved label (localStorage > static)
  const labelStored = getWeekLabel(trade.id);
  const weekStart = labelStored?.weekStart ?? trade.weekStart;
  const weekEnd   = labelStored?.weekEnd   ?? trade.weekEnd;

  // Init week label
  useEffect(() => {
    if (startRef.current) startRef.current.innerText = weekStart;
    if (endRef.current)   endRef.current.innerText   = weekEnd;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.id]);

  const saveLabel = () => {
    setWeekLabel(trade.id, {
      weekStart: startRef.current?.innerText.trim() || trade.weekStart,
      weekEnd:   endRef.current?.innerText.trim()   || trade.weekEnd,
    });
  };

  return (
    <div 
      className="grid hover:bg-surface-container-high transition-colors group w-full"
      data-testid={`week-row-${trade.id}`}
      style={{ 
        gridTemplateColumns: '96px repeat(5, minmax(225px, 1fr)) 260px', 
        minHeight: '144px',
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
        <div
          ref={startRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); endRef.current?.focus(); return; }
            if (e.key === 'ArrowDown') {
              // move to second line only when caret is on the last visual line
              const sel = window.getSelection();
              if (!sel || !sel.rangeCount) return;
              const range = sel.getRangeAt(0);
              const rects = range.getClientRects();
              const elRect = e.currentTarget.getBoundingClientRect();
              const caretBottom = rects.length ? rects[rects.length - 1].bottom : 0;
              if (caretBottom >= elRect.bottom - 2) {
                e.preventDefault();
                endRef.current?.focus();
              }
            }
          }}
          title="Click to edit"
          className="font-label-md text-label-md text-on-surface focus:outline-none focus:bg-surface-container rounded px-0.5 cursor-text"
        />
        <div
          ref={endRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); return; }
            if (e.key === 'ArrowUp') {
              const sel = window.getSelection();
              if (!sel || !sel.rangeCount) return;
              const range = sel.getRangeAt(0);
              const rects = range.getClientRects();
              const elRect = e.currentTarget.getBoundingClientRect();
              const caretTop = rects.length ? rects[0].top : Infinity;
              if (caretTop <= elRect.top + 2) {
                e.preventDefault();
                startRef.current?.focus();
              }
            }
          }}
          title="Click to edit"
          className="font-label-md text-label-md text-on-surface-variant opacity-70 focus:outline-none focus:bg-surface-container rounded px-0.5 cursor-text"
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
}

/* ═══════════════════════════════════════════
   Settings Modal
═══════════════════════════════════════════ */
function SettingsModal({ onClose }) {
  const fileInputRef = useRef(null);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleExport = async () => {
    try {
      const jsonString = await exportDatabase();
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snowball-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Export failed.');
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importDatabase(text);
      alert('Import successful! App will reload.');
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert('Import failed. Invalid format or corrupted file.');
    }
  };

  const handleFormat = async () => {
    if (window.confirm("Are you sure you want to delete all data? This action cannot be undone.")) {
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

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md layer-surface rounded-xl flex flex-col p-xl gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">Settings</h2>
          <button onClick={onClose} className="p-2 hover:bg-surface-bright rounded-full text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="border-t border-outline-variant" />
        
        <div className="flex flex-col gap-4 py-2">
          <div>
            <h3 className="font-label-lg text-label-lg text-on-surface">Export Database</h3>
            <p className="text-on-surface-variant text-[13px] mb-3">Download all your journals, remarks, and charts as a single portable file.</p>
            <button onClick={handleExport} className="w-full py-2 bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant rounded-lg text-on-surface font-label-md flex items-center justify-center gap-2 transition-colors">
              <span className="material-symbols-outlined text-[18px]">download</span> Export as JSON
            </button>
          </div>
          
          <div className="border-t border-outline-variant" />

          <div>
            <h3 className="font-label-lg text-label-lg text-on-surface">Import Database</h3>
            <p className="text-on-surface-variant text-[13px] mb-3 text-error">Warning: Importing will overwrite your current local database!</p>
            <input type="file" ref={fileInputRef} accept=".json" className="hidden" onChange={handleImport} />
            <button onClick={() => fileInputRef.current?.click()} className="w-full py-2 bg-red-900/20 hover:bg-red-900/40 border border-error/50 rounded-lg text-error font-label-md flex items-center justify-center gap-2 transition-colors">
              <span className="material-symbols-outlined text-[18px]">upload</span> Import JSON Backup
            </button>
          </div>

          <div className="border-t border-outline-variant" />

          <div>
            <h3 className="font-label-lg text-label-lg text-on-surface">Format All Data</h3>
            <p className="text-on-surface-variant text-[13px] mb-3 text-error">Warning: This will permanently wipe all your journals, remarks, and charts.</p>
            <button onClick={handleFormat} className="w-full py-2 bg-error text-on-error hover:bg-error/90 rounded-lg font-label-md flex items-center justify-center gap-2 transition-colors">
              <span className="material-symbols-outlined text-[18px]">delete_forever</span> Wipe Clean
            </button>
          </div>
        </div>
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
  const [dateFilter, setDateFilter] = useState(null);
  const [tableZoom, setTableZoom] = useState(() => {
    const saved = sessionStorage.getItem('sb_zoom');
    return saved ? parseFloat(saved) : 1.0;
  });
  const gridBottomRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const scrollPos = useRef({ top: 0, left: 0 });

  useEffect(() => {
    sessionStorage.setItem('sb_zoom', tableZoom.toString());
  }, [tableZoom]);

  useEffect(() => {
    const savedTop = sessionStorage.getItem('sb_scroll_top');
    const savedLeft = sessionStorage.getItem('sb_scroll_left');
    if (scrollContainerRef.current) {
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          if (savedTop) scrollContainerRef.current.scrollTop = parseFloat(savedTop);
          if (savedLeft) scrollContainerRef.current.scrollLeft = parseFloat(savedLeft);
        }
      });
    }
    return () => {
      sessionStorage.setItem('sb_scroll_top', scrollPos.current.top.toString());
      sessionStorage.setItem('sb_scroll_left', scrollPos.current.left.toString());
    };
  }, []);

  const handleScroll = useCallback((e) => {
    scrollPos.current = { top: e.target.scrollTop, left: e.target.scrollLeft };
  }, []);

  const zoomIn  = useCallback(() => setTableZoom(z => Math.min(4.0, parseFloat((z + 0.1).toFixed(1)))), []);
  const zoomOut = useCallback(() => setTableZoom(z => Math.max(0.5, parseFloat((z - 0.1).toFixed(1)))), []);

  /* ── Add new row ── */
  const addRow = useCallback(() => {
    const today = new Date();
    const dow   = today.getDay();
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today); monday.setDate(today.getDate() + diffToMon);
    const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
    const fmt    = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const weekId  = `week-custom-${Date.now()}`;
    const newWeek = {
      id: weekId,
      weekStart: fmt(monday),
      weekEnd:   fmt(friday),
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

  /* ── Search filter & Date filter ── */
  const filtered = allTrades.filter((t) => {
    // 1. Date Filter Logic
    if (dateFilter) {
      let passesDateFilter = false;
      const cellDates = t.days
        .map(d => getTradeDate(t.id, d.day))
        .filter(d => d !== '');
      
      if (cellDates.length > 0) {
        if (dateFilter.type === 'date') {
          // If any cell date >= selected date
          if (cellDates.some(d => d >= dateFilter.date)) passesDateFilter = true;
        } else if (dateFilter.type === 'range') {
          // If any cell date is between from and to
          if (cellDates.some(d => d >= dateFilter.from && d <= dateFilter.to)) passesDateFilter = true;
        }
      }
      if (!passesDateFilter) return false; // Filter out if no dates match or no dates are set
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
            ref={scrollContainerRef} 
            onScroll={handleScroll} 
            className="flex-1 overflow-auto custom-scrollbar w-full"
          >
            <div className="w-full h-full">

              {/* Grid */}
              <div
                style={{
                  transformOrigin: 'top left',
                  transform: `scale(${tableZoom})`,
                  width: `${(100 / tableZoom).toFixed(4)}%`,
                  marginBottom: `calc((${tableZoom} - 1) * 100%)`,
                  transition: 'transform 0.15s ease, width 0.15s ease',
                }}
              >
              <div className="bg-[#111111] border border-[#222222] rounded-xl shadow-sm flex flex-col min-w-[1481px] w-full overflow-auto custom-scrollbar">
                {/* Header row */}
                <div 
                  className="grid border-b border-[#222222] bg-[#0a0a0a] font-label-md text-label-md text-on-surface-variant uppercase tracking-wider w-full"
                  style={{ gridTemplateColumns: '96px repeat(5, minmax(225px, 1fr)) 260px' }}
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
                    filtered.map((trade) => (
                      <WeekRow key={trade.id} trade={trade} onOpenRemarks={setRemarksModal} onDeleteWeek={deleteRow} search={search} />
                    ))
                  ) : (
                    <div className="py-16 text-center text-on-surface-variant font-label-md text-label-md">
                      {search ? `No rows matched "${search}"` : 'No entries yet — click + to add a week'}
                    </div>
                  )}
                  {/* Scroll anchor for the Add button */}
                  <div ref={gridBottomRef} />
                </div>
              </div>
              </div>{/* end zoom wrapper */}

            </div>
          </div>

        </main>
      </div>
    </>
  );
}
