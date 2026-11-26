// Tag search language (2026-11-27) — the search bar understands a small
// boolean language over day cells. Everything is case-insensitive; spaces
// around '+', ',', '=', '(' and ')' are ignored.
//
//   query     := orGroup (',' orGroup)*
//   orGroup   := term ('+' term)*
//   term      := tagTerm | remTerm | notesTerm
//   tagTerm   := 'tag=' tag | 'tag=' '(' tagExpr ')'
//   tagExpr   := tagOrGroup (',' tagOrGroup)*
//   tagOrGroup:= tag ('+' tag)*
//   remTerm   := 'rem=' word
//   notesTerm := word            (text up to the next top-level operator)
//
// '+' binds tighter than ',', so 'a + b , c' reads '(a AND b) OR c'.
// A tag matches exactly ('tag=gap' does NOT match 'gapup'); a notes/rem
// word matches as a substring ('loss' matches 'losses', 'stop-loss').
// A term with no content is ignored; a query with no terms matches
// everything (parseSearchQuery returns null).
//
// Examples:
//   tag=gapup                  days carrying the gapup tag
//   tag=(gapup+loss)           days carrying BOTH tags
//   tag=(gapup,breakout)       days carrying gapup OR breakout
//   tag=(gapup+loss) + loss    days with both tags AND 'loss' in notes
//   tag=(gapup) , tag=(breakout)  days with either tag
//
// Matching is per day: a week is shown when any of its days matches the
// whole query. A 'rem=' term is week-level (the week's remarks), so it is
// true for every day of a matching week; the day outline (see
// dayOutlineMatchesQuery) drops rem terms, so a rem-only query outlines
// the remarks cell and no day cells.

/**
 * Parse a raw query string. Returns null when there is nothing to filter
 * on (empty query, or only empty/ignored terms), else
 * { orGroups: Array<Array<Term>> } — OR of AND-groups. A term is
 * { type: 'tags', orGroups: string[][] } (OR of AND-groups of exact tag
 * names), { type: 'notes', value } or { type: 'remarks', value }.
 */
export const parseSearchQuery = (query) => {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return null;
  const { terms, ops } = splitTopLevel(q);
  // Keep the parsed terms in order, remembering the separator before each
  // one: the separator between two kept terms is ',' if any operator
  // between them in the raw query was ',', else '+'. (Empty terms dropped
  // here can't change the meaning: 'a + + b' is still AND, 'a + , b' is OR.)
  const keptTerms = [];
  const keptSeps = [];
  let pendingSep = null;
  for (let i = 0; i < terms.length; i++) {
    const t = parseTerm(terms[i]);
    if (t) {
      keptTerms.push(t);
      keptSeps.push(pendingSep);
      pendingSep = null;
    }
    if (i < ops.length) {
      const op = ops[i];
      if (pendingSep === null) pendingSep = op;
      else if (op === ',') pendingSep = ',';
    }
  }
  if (keptTerms.length === 0) return null;
  const orGroups = [[]];
  for (let i = 0; i < keptTerms.length; i++) {
    if (i > 0 && keptSeps[i] === ',') orGroups.push([]);
    orGroups[orGroups.length - 1].push(keptTerms[i]);
  }
  return { orGroups };
};

/** Split on top-level '+' / ',' — operators inside tag=(...) parens do not split. */
const splitTopLevel = (s) => {
  const terms = [];
  const ops = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '+' || ch === ',')) {
      terms.push(cur);
      ops.push(ch);
      cur = '';
    } else {
      cur += ch;
    }
  }
  terms.push(cur);
  return { terms, ops };
};

/** Parse one top-level term (already trimmed by the caller via .trim()). */
const parseTerm = (text) => {
  const t = text.trim();
  if (!t) return null;
  const tagMatch = /^tag\s*=\s*(.*)$/.exec(t);
  if (tagMatch) {
    const rest = tagMatch[1].trim();
    if (!rest) return null;
    if (rest.startsWith('(')) {
      // No nesting: the first ')' closes the list; a missing ')' just
      // takes the rest of the query. Trailing junk after ')' is ignored.
      const close = rest.indexOf(')');
      const inner = close === -1 ? rest.slice(1) : rest.slice(1, close);
      const orGroups = inner
        .split(',')
        .map((g) => g.split('+').map((x) => x.trim()).filter(Boolean))
        .filter((g) => g.length > 0);
      if (orGroups.length === 0) return null;
      return { type: 'tags', orGroups };
    }
    return { type: 'tags', orGroups: [[rest]] };
  }
  const remMatch = /^rem\s*=\s*(.*)$/.exec(t);
  if (remMatch) {
    const word = remMatch[1].trim();
    return word ? { type: 'remarks', value: word } : null;
  }
  return { type: 'notes', value: t };
};

const termMatchesDay = (term, day) => {
  if (term.type === 'tags') {
    return term.orGroups.some((group) => group.every((tag) => day.tags.includes(tag)));
  }
  if (term.type === 'notes') return day.notes.includes(term.value);
  return day.remarks.includes(term.value);
};

/**
 * Does this day match the whole query? `day` is a search-index day entry:
 * { tags: string[] (lowercased), notes: string (lowercased),
 *   remarks: string (lowercased, the week's remarks) }.
 */
export const dayMatchesQuery = (parsed, day) => {
  if (!parsed) return true;
  return parsed.orGroups.some((group) => group.every((term) => termMatchesDay(term, day)));
};

/**
 * Does this day earn the amber outline? Same as dayMatchesQuery, but rem
 * terms are dropped first — a rem term is week-level, so without this a
 * rem-only query would outline every day cell of a matching week instead
 * of just the remarks cell. False when the query has no day-level terms.
 */
export const dayOutlineMatchesQuery = (parsed, day) => {
  if (!parsed) return false;
  const stripped = {
    orGroups: parsed.orGroups
      .map((group) => group.filter((term) => term.type !== 'remarks'))
      .filter((group) => group.length > 0),
  };
  if (stripped.orGroups.length === 0) return false;
  return dayMatchesQuery(stripped, day);
};

/** Does any rem= term in the query match this week's (lowercased) remarks? */
export const remarksMatchQuery = (parsed, remarksLower) => {
  if (!parsed) return false;
  return parsed.orGroups.some((group) =>
    group.some((term) => term.type === 'remarks' && remarksLower.includes(term.value)),
  );
};
