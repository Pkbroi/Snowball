import { useRef, useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { getTradeById } from '../data/trades.js';
import { resolveImg, resolveImgAsync, setStoredImg, fileToDataUrl, getNotes, setNotes, getTags, setTags, getTradeDate, setTradeDate } from '../data/storage.js';

/* ─────────────────────────────────────────────
   Attach resize handles to a wrapper element.
───────────────────────────────────────────── */
function attachResizeHandles(wrapper, img) {
  const handles = [
    { dir: 'n', css: 'top:-5px;left:50%;transform:translateX(-50%);width:44px;height:10px;cursor:n-resize;' },
    { dir: 'e', css: 'top:50%;right:-5px;transform:translateY(-50%);width:10px;height:44px;cursor:e-resize;' },
    { dir: 's', css: 'bottom:-5px;left:50%;transform:translateX(-50%);width:44px;height:10px;cursor:s-resize;' },
    { dir: 'w', css: 'top:50%;left:-5px;transform:translateY(-50%);width:10px;height:44px;cursor:w-resize;' },
  ];
  handles.forEach(({ dir, css }) => {
    const handle = document.createElement('span');
    handle.dataset.resizeDir = dir;
    handle.style.cssText =
      `position:absolute;${css}background:#6b7280;border-radius:6px;` +
      `opacity:0;transition:opacity 0.15s;z-index:20;`;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const startW = img.offsetWidth, startH = img.offsetHeight;
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (dir === 'e') img.style.width  = `${Math.max(60, startW + dx)}px`;
        if (dir === 'w') img.style.width  = `${Math.max(60, startW - dx)}px`;
        if (dir === 's') img.style.height = `${Math.max(40, startH + dy)}px`;
        if (dir === 'n') img.style.height = `${Math.max(40, startH - dy)}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    wrapper.appendChild(handle);
  });
  const show = () => wrapper.querySelectorAll('[data-resize-dir]').forEach((h) => (h.style.opacity = '1'));
  const hide = () => wrapper.querySelectorAll('[data-resize-dir]').forEach((h) => (h.style.opacity = '0'));
  wrapper.addEventListener('mouseenter', show);
  wrapper.addEventListener('mouseleave', hide);
}

/* ─────────────────────────────────────────────
   Insert resizable image at caret in notes.
───────────────────────────────────────────── */
function insertResizableImage(src, editor) {
  editor.focus();
  const wrapper = document.createElement('span');
  wrapper.contentEditable = 'false';
  wrapper.style.cssText =
    'display:inline-block;position:relative;line-height:0;margin:6px 2px;vertical-align:middle;user-select:none;';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'display:block;width:320px;height:auto;border-radius:4px;';
  img.draggable = false;
  wrapper.appendChild(img);
  attachResizeHandles(wrapper, img);
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(wrapper);
    const after = document.createRange();
    after.setStartAfter(wrapper);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  } else {
    editor.appendChild(wrapper);
  }
}

/* ─── Page ─── */
export default function TradeDetail() {
  const navigate  = useNavigate();
  const { id }    = useParams();
  const { state } = useLocation();
  const search = state?.search || '';

  // Resolve trade data — prefer router state, fall back to lookup
  const trade = state ?? (() => {
    const t = getTradeById(id);
    if (!t) return null;
    const day = t.days.find((d) => d.outcome) ?? t.days[0];
    return { weekId: t.id, weekStart: t.weekStart, weekEnd: t.weekEnd, remarks: t.remarks, day };
  })();

  const handleBack = () => {
    navigate(search ? `/?q=${encodeURIComponent(search)}` : '/');
  };

  const fileInputRef = useRef(null);
  const editorRef    = useRef(null);
  const savedRange   = useRef(null);
  const hLineRef     = useRef(null);
  const vLineRef     = useRef(null);
  const hLineInlineRef = useRef(null);
  const vLineInlineRef = useRef(null);

  const [expanded, setExpanded] = useState(false);
  const [ctxMenu,  setCtxMenu]  = useState(null);
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

  const [chartImg, setChartImg] = useState(() => resolveImg(weekId, dayName, trade?.day?.img));
  const [tags, setTagsState] = useState(() => getTags(weekId, dayName));
  const [tagInput, setTagInput] = useState('');
  const [tradeDate, setTradeDateState] = useState(() => getTradeDate(weekId, dayName));
  const [pickerValue, setPickerValue] = useState(() => getTradeDate(weekId, dayName));
  const dateInputRef = useRef(null);

  useEffect(() => {
    if (trade) {
      setChartImg(resolveImg(weekId, dayName, trade.day?.img));
      setTagsState(getTags(weekId, dayName));
      
      const savedTradeDate = getTradeDate(weekId, dayName);
      setTradeDateState(savedTradeDate);
      setPickerValue(savedTradeDate);
    }
  }, [trade, weekId, dayName]);

  /* ── Save chart image to localStorage + state ── */
  const persistChart = useCallback(async (fileOrDataUrl) => {
    let dataUrl = fileOrDataUrl;
    if (fileOrDataUrl instanceof File || fileOrDataUrl instanceof Blob) {
      dataUrl = await fileToDataUrl(fileOrDataUrl);
    }
    setStoredImg(weekId, dayName, dataUrl);
    setChartImg(dataUrl);
    triggerSaveIndicator();
  }, [weekId, dayName, triggerSaveIndicator]);

  /* ── Delete main chart ── */
  const deleteChart = useCallback(() => {
    setStoredImg(weekId, dayName, 'DELETED');
    setChartImg(null);
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
  useEffect(() => {
    const el = editorRef.current;
    if (el && trade) {
      el.innerHTML = getNotes(weekId, dayName) ?? trade.day?.notes ?? '';
    }
  }, [weekId, dayName, trade]);

  const persistNotes = useCallback(() => {
    const el = editorRef.current;
    if (el) {
      setNotes(weekId, dayName, el.innerHTML);
      triggerSaveIndicator();
    }
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

  /* ── Font size context menu ── */
  const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28];
  const handleNotesContextMenu = useCallback((e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) savedRange.current = sel.getRangeAt(0).cloneRange();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);
  const dismissCtxMenu = useCallback(() => setCtxMenu(null), []);
  const applyFontSize = useCallback((size) => {
    setCtxMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    if (savedRange.current) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    const span = document.createElement('span');
    span.style.fontSize   = `${size}px`;
    span.style.lineHeight = '1.7';
    span.appendChild(document.createTextNode('\u200B'));
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.collapse(true);
      range.insertNode(span);
      const newRange = document.createRange();
      newRange.setStart(span.firstChild, 1);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }, []);

  /* ── Notes paste (images) ── */
  const handleNotesPaste = useCallback((e) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find((i) => i.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const blob = imgItem.getAsFile();
    if (blob) {
      fileToDataUrl(blob).then(dataUrl => {
        insertResizableImage(dataUrl, editorRef.current);
        persistNotes();
      });
    }
  }, [persistNotes]);

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
      onClick={dismissCtxMenu}
    >
      {/* Hidden file input for chart upload */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />

      {/* ── Fullscreen lightbox ── */}
      {expanded && (
        <div 
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center animate-expand cursor-crosshair"
          onMouseMove={(e) => {
            if (hLineRef.current && vLineRef.current) {
              hLineRef.current.style.top = `${e.clientY}px`;
              vLineRef.current.style.left = `${e.clientX}px`;
            }
          }}
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
          <img src={chartImg} alt="Chart fullscreen" className="object-contain rounded-lg relative z-30 pointer-events-none" style={{ maxHeight: '95vh', maxWidth: '95vw' }} />
        </div>
      )}

      {/* ── Back button (Floating) ── */}
      <button 
        onClick={handleBack} 
        data-testid="back-button" 
        aria-label="Back to Journal" 
        className="fixed top-4 left-4 md:top-6 md:left-6 z-40 flex items-center gap-1.5 text-on-surface-variant/80 hover:text-primary transition-all bg-[#111111]/50 backdrop-blur-md border border-[#222222]/50 px-3 py-1.5 rounded-full shadow-sm hover:bg-[#111111]/80 hover:shadow-md duration-200"
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
              className="w-full rounded-lg overflow-hidden border border-outline-variant aspect-video bg-surface-container-lowest relative cursor-crosshair group"
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

              <img src={chartImg} alt={`${day.day} chart`} className="w-full h-full object-cover pointer-events-none" />
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
              className={`w-full rounded-lg border-2 aspect-video transition-colors flex flex-col items-center justify-center cursor-pointer group focus:outline-none focus:border-primary/50 focus:bg-surface-container-high ${
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

        {/* ── Notes / freewrite area ── */}
        <section className="w-full flex-1 flex flex-col">
          {/* Formatting Toolbar */}
          <div className="flex gap-2 mb-2 p-2 bg-surface-container-low border border-outline-variant rounded-md">
            <button onClick={() => document.execCommand('bold', false, null)} className="p-1 rounded hover:bg-surface-variant text-on-surface" title="Bold"><span className="material-symbols-outlined text-[20px]">format_bold</span></button>
            <button onClick={() => document.execCommand('italic', false, null)} className="p-1 rounded hover:bg-surface-variant text-on-surface" title="Italic"><span className="material-symbols-outlined text-[20px]">format_italic</span></button>
            <button onClick={() => document.execCommand('underline', false, null)} className="p-1 rounded hover:bg-surface-variant text-on-surface" title="Underline"><span className="material-symbols-outlined text-[20px]">format_underlined</span></button>

          </div>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            data-testid="notes-editor"
            onContextMenu={handleNotesContextMenu}
            onPaste={handleNotesPaste}
            onInput={persistNotes}
            placeholder="Start writing… paste text or images here"
            spellCheck={false}
            className="flex-1 min-h-[220px] w-full bg-transparent text-on-surface focus:outline-none cursor-text p-2"
            style={{ fontSize: '16px', lineHeight: 1.7, wordBreak: 'break-word' }}
          />
        </section>
      </main>

      {/* ── Font-size context menu ── */}
      {ctxMenu && (
        <div
          className="fixed z-50 layer-overlay rounded-lg py-1 shadow-xl min-w-[160px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="px-3 py-1 text-[10px] uppercase tracking-widest text-on-surface-variant font-label-sm border-b border-outline-variant mb-1">
            Font size
          </p>
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              onClick={() => applyFontSize(size)}
              className="w-full text-left px-4 py-1.5 text-[13px] font-label-md hover:bg-surface-bright transition-colors text-on-surface"
            >
              {size}px
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
