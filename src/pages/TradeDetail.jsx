import { useRef, useState, useCallback, useEffect } from 'react';
import { useLenis } from '../hooks/useLenis.js';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { getTradeById } from '../data/trades.js';
import { resolveImg, resolveImgAsync, setStoredImg, fileToDataUrl, getNotes, setNotes, getTags, setTags, getTradeDate, setTradeDate } from '../data/storage.js';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';



/* ─── Image Resize Handler ─────────────────────────────────────────────────
   Attaches MS-Word–style resize handles to images inside the Quill editor.
   Click an image → 8 handles appear; drag to resize. No external deps.
─────────────────────────────────────────────────────────────────────────── */
function ImageResizeHandler({ quillRef }) {
  useEffect(() => {
    let cleanup = () => {};

    // Quill editor may not be mounted on first tick — retry a few times
    let attempts = 0;
    const tryAttach = () => {
      attempts++;
      const editorRoot = quillRef.current?.getEditor?.()?.root;
      if (!editorRoot) {
        if (attempts < 20) setTimeout(tryAttach, 100);
        return;
      }
    let overlay = null;
    let activeImg = null;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let currentHandle = null;

    const HANDLE_SIZE = 10;

    const removeOverlay = () => {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      activeImg = null;
    };

    const makeHandle = (cursor) => {
      const h = document.createElement('div');
      h.style.cssText = `
        position:absolute; width:${HANDLE_SIZE}px; height:${HANDLE_SIZE}px;
        background:#3b82f6; border:1.5px solid #fff; border-radius:2px;
        cursor:${cursor}; box-shadow:0 1px 3px rgba(0,0,0,.5);
        z-index:9999; transform:translate(-50%,-50%);
      `;
      return h;
    };

    const positionOverlay = (img) => {
      const rect = img.getBoundingClientRect();
      const editorRect = editorRoot.getBoundingClientRect();
      const scrollTop = editorRoot.scrollTop;
      const scrollLeft = editorRoot.scrollLeft;

      overlay.style.left   = `${rect.left - editorRect.left + scrollLeft}px`;
      overlay.style.top    = `${rect.top  - editorRect.top  + scrollTop}px`;
      overlay.style.width  = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    };

    const attachOverlay = (img) => {
      removeOverlay();
      activeImg = img;

      overlay = document.createElement('div');
      overlay.style.cssText = `
        position:absolute; box-sizing:border-box;
        border:2px solid #3b82f6; pointer-events:none;
        z-index:9998;
      `;

      // 8 handles: corners + edge midpoints
      const handles = [
        { cursor:'nw-resize',  tx:0,    ty:0    },
        { cursor:'n-resize',   tx:0.5,  ty:0    },
        { cursor:'ne-resize',  tx:1,    ty:0    },
        { cursor:'e-resize',   tx:1,    ty:0.5  },
        { cursor:'se-resize',  tx:1,    ty:1    },
        { cursor:'s-resize',   tx:0.5,  ty:1    },
        { cursor:'sw-resize',  tx:0,    ty:1    },
        { cursor:'w-resize',   tx:0,    ty:0.5  },
      ];

      handles.forEach(({ cursor, tx, ty }) => {
        const h = makeHandle(cursor);
        h.style.pointerEvents = 'all';
        h.style.left = `${tx * 100}%`;
        h.style.top  = `${ty * 100}%`;
        h.dataset.tx = tx;
        h.dataset.ty = ty;

        h.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          currentHandle = { tx: parseFloat(h.dataset.tx), ty: parseFloat(h.dataset.ty) };
          startX = e.clientX;
          startY = e.clientY;
          startW = activeImg.offsetWidth  || activeImg.naturalWidth  || 200;
          startH = activeImg.offsetHeight || activeImg.naturalHeight || 150;
        });

        overlay.appendChild(h);
      });

      // Size label
      const label = document.createElement('div');
      label.className = '_qir_label';
      label.style.cssText = `
        position:absolute; bottom:-22px; left:0; background:#3b82f6; color:#fff;
        font-size:10px; padding:1px 5px; border-radius:3px; white-space:nowrap;
        pointer-events:none; z-index:9999;
      `;
      overlay.appendChild(label);
      overlay._label = label;

      const editorRoot2 = editorRoot;
      editorRoot2.style.position = 'relative';
      editorRoot2.appendChild(overlay);

      positionOverlay(img);
      overlay._label.textContent = `${Math.round(img.offsetWidth)} × ${Math.round(img.offsetHeight)}`;
    };

    const onMouseMove = (e) => {
      if (!currentHandle || !activeImg) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newW = startW;
      let newH = startH;

      const { tx, ty } = currentHandle;

      if (tx === 1)   newW = Math.max(20, startW + dx);
      if (tx === 0)   newW = Math.max(20, startW - dx);
      if (ty === 1)   newH = Math.max(20, startH + dy);
      if (ty === 0)   newH = Math.max(20, startH - dy);
      // corners: both axes
      if (tx === 0.5) newW = startW;
      if (ty === 0.5) newH = startH;

      activeImg.style.width  = `${newW}px`;
      activeImg.style.height = `${newH}px`;

      positionOverlay(activeImg);
      if (overlay._label) {
        overlay._label.textContent = `${Math.round(newW)} × ${Math.round(newH)}`;
      }
    };

    const onMouseUp = () => {
      currentHandle = null;
    };

    const onImgClick = (e) => {
      const img = e.target;
      if (img.tagName !== 'IMG') return;
      e.stopPropagation();
      attachOverlay(img);
    };

    const onDocClick = (e) => {
      if (overlay && !overlay.contains(e.target) && e.target !== activeImg) {
        removeOverlay();
      }
    };

    editorRoot.addEventListener('click', onImgClick);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('click', onDocClick);

    cleanup = () => {
      editorRoot.removeEventListener('click', onImgClick);
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
export default function TradeDetail() {
  const navigate  = useNavigate();
  const { id }    = useParams();
  const { state } = useLocation();
  const search = state?.search || '';

  // Apply smooth scrolling to the window for this page
  useLenis();

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

              <img src={chartImg} alt={`${day.day} chart`} className="w-full h-full object-contain pointer-events-none" />
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
            placeholder="Type notes here… Use Ctrl+B for bold. Drag & drop or paste images anytime."
            className="flex-1 text-on-surface"
            modules={{ toolbar: false }}
          />
          <ImageResizeHandler quillRef={quillRef} />
        </section>
      </main>

    </div>
  );
}
