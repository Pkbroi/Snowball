import { Routes, Route } from 'react-router-dom';
import { useState, useEffect, lazy, Suspense } from 'react';
import { initStorage } from './data/storage.js';

const WeeklyJournal = lazy(() => import('./pages/WeeklyJournal.jsx'));
const TradeDetail   = lazy(() => import('./pages/TradeDetail.jsx'));

export default function App() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Metadata only: initStorage resolves once the registry, week
    // documents and notes are in memory. Thumbnails stream in
    // afterwards in the background (perf step 6) — the journal paints
    // immediately and cells fill in as their thumbnails arrive, instead
    // of the old "Preparing images…" screen blocking on every thumb.
    initStorage().then(() => setLoading(false));
  }, []);

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
