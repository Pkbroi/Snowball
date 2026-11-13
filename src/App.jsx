import { Routes, Route } from 'react-router-dom';
import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { initStorage } from './data/storage.js';

const WeeklyJournal = lazy(() => import('./pages/WeeklyJournal.jsx'));
const TradeDetail   = lazy(() => import('./pages/TradeDetail.jsx'));

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 0 });

  const onProgress = useCallback((loaded, total) => {
    setLoadProgress({ loaded, total });
  }, []);

  useEffect(() => {
    initStorage(onProgress).then(() => setLoading(false));
  }, [onProgress]);

  if (loading) {
    const { loaded, total } = loadProgress;
    const hasImages = total > 0;
    const pct = hasImages ? Math.round((loaded / total) * 100) : null;

    return (
      <div className="flex h-screen w-full items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-5 text-on-surface-variant" style={{ width: 260 }}>
          <span className="material-symbols-outlined text-[36px] animate-spin text-primary">progress_activity</span>
          <span className="font-label-md text-on-surface">Loading journal…</span>

          {hasImages && (
            <>
              {/* Progress bar */}
              <div className="w-full bg-surface-container rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${pct}%`,
                    background: 'linear-gradient(90deg, #1a437e, #4a8fff)',
                  }}
                />
              </div>
              <span className="font-label-md text-[12px] text-on-surface-variant">
                Preparing images… {loaded}/{total} ({pct}%)
              </span>
            </>
          )}
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
