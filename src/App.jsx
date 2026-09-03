import { Routes, Route } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { initStorage } from './data/storage.js';
import WeeklyJournal from './pages/WeeklyJournal.jsx';
import TradeDetail   from './pages/TradeDetail.jsx';

export default function App() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initStorage().then(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-4 text-on-surface-variant">
          <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
          <span className="font-label-md">Loading journal...</span>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/"           element={<WeeklyJournal />} />
      <Route path="/trade/:id"  element={<TradeDetail />}   />
    </Routes>
  );
}
