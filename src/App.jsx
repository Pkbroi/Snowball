import { Routes, Route } from 'react-router-dom';
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { initStorage } from './data/storage.js';

const WeeklyJournal = lazy(() => import('./pages/WeeklyJournal.jsx'));
const TradeDetail   = lazy(() => import('./pages/TradeDetail.jsx'));

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Bug 4: initStorage used to have no .catch, so an IndexedDB failure
  // (unavailable, blocked, corrupt) left the app on "Loading journal…"
  // forever with no way forward. A failure now shows an error screen
  // with a Retry button; retrying re-runs initStorage from scratch.
  // (No icon here on purpose: the subset font only carries the icons
  // the app already uses, and an unknown ligature would render as text.)
  // The settlement lives in its own callback so the effect below can
  // call it without setting state synchronously (the linter flags
  // that); the Retry button resets the state first, then settles.
  const settleLoad = useCallback((promise) => {
    promise
      .then(() => setLoading(false))
      .catch((err) => {
        setLoadError(err);
        setLoading(false);
      });
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    settleLoad(initStorage());
  }, [settleLoad]);

  useEffect(() => {
    // Metadata only: initStorage resolves once the registry, week
    // documents and notes are in memory. Thumbnails stream in
    // afterwards in the background (perf step 6) — the journal paints
    // immediately and cells fill in as their thumbnails arrive, instead
    // of the old "Preparing images…" screen blocking on every thumb.
    settleLoad(initStorage());
  }, [settleLoad]);

  useEffect(() => {
    // Bug 3 safety net: a file dropped anywhere no cell or dropzone
    // handles (header, remarks column, gaps between elements) used to
    // navigate the whole app away to the raw image, leaving it unusable
    // until restart. Preventing the default on dragover + drop at window
    // level stops that navigation. It does not stopPropagation, so cells
    // and dropzones with their own handlers still receive the drop
    // first (their React handlers run before this window listener in
    // the bubble phase) and handle it themselves.
    const prevent = (e) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  if (loadError) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-4 text-center px-6" style={{ width: 340 }} data-testid="startup-error">
          <span className="flex items-center justify-center w-12 h-12 rounded-full bg-[#dc2626] text-white text-[24px] font-bold">!</span>
          <span className="text-[16px] font-bold text-on-surface">Couldn't open the journal</span>
          <span className="font-body-md text-on-surface-variant">
            The browser's storage failed to open, so your journal couldn't load. Your data is still stored in the browser — this is a loading problem, not a data problem.
          </span>
          <span className="font-label-sm text-on-surface-variant/70 break-all">
            {loadError?.message || String(loadError)}
          </span>
          <button
            type="button"
            onClick={load}
            data-testid="startup-retry-btn"
            className="mt-1 rounded-full bg-white px-5 py-2 font-label-md font-bold text-black hover:bg-white/90"
          >
            Retry
          </button>
          <span className="font-label-sm text-on-surface-variant/70">
            If it keeps failing, restart the app or check the browser's storage settings.
          </span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-5 text-on-surface-variant" style={{ width: 260 }}>
          <span className="material-symbols-outlined text-[36px] animate-spin text-primary">progress_activity</span>
          <span className="font-label-md text-on-surface">Loading journal…</span>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={
      <div className="flex h-screen w-full items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-4 text-on-surface-variant">
          <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
          <span className="font-label-md">Loading...</span>
        </div>
      </div>
    }>
      <Routes>
        <Route path="/"           element={<WeeklyJournal />} />
        <Route path="/trade/:id"  element={<TradeDetail />}   />
      </Routes>
    </Suspense>
  );
}
