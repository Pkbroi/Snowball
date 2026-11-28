/* ─── Rule-adherence point system ───
   The parameter set is the user's own list: each parameter has a name
   and a points weight he assigns. A day's scores are { [paramId]: 1|-1 }
   — followed earns +points, broke loses −points, absent is N/A. The day
   total is the sum; above zero is a green day, below zero a red day,
   zero / unscored is neutral. The six below are the starting set — the
   user edits them as he goes (add / delete / re-weight on the notes page). */

export const DEFAULT_PARAMS = [
  { id: 'setup',    short: 'Setup',     label: 'Traded only my setup — no impulse entries', points: 1 },
  { id: 'risk',     short: 'Risk',      label: 'Risk per trade within my limit', points: 1 },
  { id: 'stoploss', short: 'Stop loss', label: 'Stop loss respected — never moved it away', points: 1 },
  { id: 'revenge',  short: 'Revenge',   label: 'No revenge trade after a loss', points: 1 },
  { id: 'exit',     short: 'Exit',      label: 'Exited as planned — no early exit, no holding losers', points: 1 },
  { id: 'journal',  short: 'Journal',   label: 'Journaled the trade the same day', points: 1 },
];

/** Total + counts for one day, given the parameter list and its scores. */
export const scoreParamMap = (params, scores = {}) => {
  let total = 0;
  let followed = 0;
  let broke = 0;
  let answered = 0;
  for (const p of params) {
    const v = scores[p.id] ?? 0;
    if (v === 1) { followed++; answered++; total += p.points; }
    else if (v === -1) { broke++; answered++; total -= p.points; }
  }
  return { total, followed, broke, answered, na: params.length - answered };
};

/** 'positive' | 'negative' | 'neutral' — drives the green / red / grey. */
export const scoreVerdict = (params, scores = {}) => {
  const { total, answered } = scoreParamMap(params, scores);
  if (answered === 0) return 'neutral';
  if (total > 0) return 'positive';
  if (total < 0) return 'negative';
  return 'neutral';
};
