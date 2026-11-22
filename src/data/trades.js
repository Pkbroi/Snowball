/**
 * Dummy trade data.
 * Each week has 5 day cells (Mon–Fri).
 * outcome: 'W' = win | 'L' = loss | null = no trade
 */

import {
  getExtraWeeks, getWeekLabel, getRemarks,
  getNotes, getTags, getTradeDate, getImageMeta,
} from './storage.js';

export const trades = [];

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Rebuild a week from storage (bug 5). The detail page used to depend
 * entirely on router location.state, so a reload or deep link to a
 * trade showed "Trade not found" — this was a stub returning null.
 * Now it rebuilds the week from the stored data: the extra-weeks list
 * (existence + dates), the week-label override, remarks, and each
 * day's notes / tags / date / image meta. All reads are synchronous
 * memCache reads — initStorage has already resolved by the time the
 * detail page renders (App waits for it). Returns null when the week
 * does not exist, so a bogus deep link still shows "Trade not found".
 * The day's image is left null: the detail page loads the full image
 * from storage on mount, the same as when navigation hands it no
 * preloaded image.
 */
export function getTradeById(id) {
  if (!id) return null;
  const extra = getExtraWeeks().find((w) => w.id === id);
  const label = getWeekLabel(id);
  const remarks = getRemarks(id);
  const days = DAYS.map((day) => {
    const notes = getNotes(id, day);
    const tags = getTags(id, day);
    const date = getTradeDate(id, day);
    const meta = getImageMeta(id, day);
    // Content = anything the user put on this day: a chart (meta),
    // notes, tags, or a trade date.
    const hasContent = Boolean(meta)
      || Boolean(notes && notes.replace(/<[^>]+>/g, '').trim())
      || tags.length > 0
      || Boolean(date);
    return { day, img: null, outcome: null, notes: notes ?? '', tags, date, hasContent };
  });
  // The week exists if it is a known extra week, or if anything at all
  // is stored for it (label, remarks, or a day with content) — a week
  // left over without its extra-weeks entry still opens.
  const exists = Boolean(extra) || Boolean(label) || Boolean(remarks)
    || days.some((d) => d.hasContent);
  if (!exists) return null;
  return {
    id,
    weekStart: label?.weekStart ?? extra?.weekStart ?? '',
    weekEnd: label?.weekEnd ?? extra?.weekEnd ?? '',
    remarks: remarks ?? '',
    days,
  };
}
