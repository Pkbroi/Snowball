import { useEffect } from 'react';
import ReactQuill, { Quill } from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

/* ─── Notes editor (lazy) ────────────────────────────────────────────────
   The Quill bundle (~200KB) is loaded only when the notes section is
   needed (perf step 8): TradeDetail lazy-imports this file when the
   section scrolls into view or the user clicks the placeholder. The
   editor below is the same ReactQuill instance as before — same value,
   same onChange, same toolbar-less config — plus the image resize
   handler, which needs Quill and therefore lives here too. ─────────── */

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
/* The notes editor itself. `quillRef` is owned by TradeDetail (its drop
   handler and the section's paste fallback read it); `autoFocus` focuses
   the editor on mount when the user clicked the placeholder to open it,
   so the click that mounts the editor also puts the cursor inside. */
export default function NotesEditor({ quillRef, value, onChange, autoFocus }) {
  useEffect(() => {
    const attach = () => {
      const quill = quillRef.current?.getEditor?.();
      const root = quill?.root;
      if (root) root.setAttribute('data-testid', 'notes-editor');
      if (autoFocus && quill) {
        quill.focus();
        quill.setSelection(quill.getLength(), 0);
      }
    };
    attach();
    const timer = setTimeout(attach, 100);
    return () => clearTimeout(timer);
    // Mount-only: the editor instance is created once, on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <ReactQuill
        ref={quillRef}
        theme="snow"
        value={value}
        onChange={onChange}
        placeholder="Type notes here… Drag & drop or paste images anytime."
        className="flex-1 text-on-surface"
        modules={{ toolbar: false }}
      />
      <ImageResizeHandler quillRef={quillRef} />
    </>
  );
}
