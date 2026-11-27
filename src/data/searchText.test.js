import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNotesText, getRemarksText, setNotes, setRemarks,
  normalizeRichTextHtml, initStorage,
} from './storage';
import { clear } from 'idb-keyval';

// Search text must survive Quill's mount re-serialisation (2026-11-27):
// opening the detail page rewrote stored notes HTML with plain spaces as
// &nbsp;, and a multi-word notes term ("loss here") stopped matching the
// visited day because getNotesText never decoded entities. The search
// index reads through these getters, so decoding here repairs phrase
// search for notes already mangled in the wild as well as new ones.
describe('Search text — HTML entity decoding', () => {
  beforeEach(async () => {
    await clear();
    await initStorage();
  });

  it('getNotesText decodes &nbsp; back to plain spaces', () => {
    setNotes('week-1', 'Monday', '<p>took&nbsp;a&nbsp;loss&nbsp;here</p>');
    expect(getNotesText('week-1', 'Monday')).toBe('took a loss here');
  });

  it('getNotesText decodes &amp; &lt; &gt; without eating literal angle brackets', () => {
    setNotes('week-1', 'Monday', '<p>stop &amp; loss &lt;target&gt;</p>');
    expect(getNotesText('week-1', 'Monday')).toBe('stop & loss <target>');
  });

  it('getNotesText decodes a literal "&nbsp;" typed by the user exactly once', () => {
    // Stored as &amp;nbsp; — decoding &amp; last keeps it literal.
    setNotes('week-1', 'Monday', '<p>typed &amp;nbsp; here</p>');
    expect(getNotesText('week-1', 'Monday')).toBe('typed &nbsp; here');
  });

  it('getRemarksText decodes &nbsp; the same way', () => {
    setRemarks('week-1', '<p>expiry&nbsp;week</p>');
    expect(getRemarksText('week-1')).toBe('expiry week');
  });

  it('normalizeRichTextHtml treats the mount echo as identical to the stored HTML', () => {
    expect(normalizeRichTextHtml('<p>took a loss here</p>'))
      .toBe(normalizeRichTextHtml('<p>took&nbsp;a&nbsp;loss&nbsp;here</p>'));
  });

  it('normalizeRichTextHtml treats Quill\'s empty document as empty', () => {
    expect(normalizeRichTextHtml('<p><br></p>')).toBe('');
    expect(normalizeRichTextHtml('')).toBe('');
  });

  it('normalizeRichTextHtml still tells a real edit apart, including format-only', () => {
    expect(normalizeRichTextHtml('<p>loss</p>'))
      .not.toBe(normalizeRichTextHtml('<p><strong>loss</strong></p>'));
    expect(normalizeRichTextHtml('<p>loss</p>'))
      .not.toBe(normalizeRichTextHtml('<p>loss today</p>'));
  });

  it('normalizeRichTextHtml does NOT collapse image-only content to empty', () => {
    // Pasting a picture into empty notes is a real edit and must save —
    // the helper must not treat "no text" as "no content" when media
    // is present.
    expect(normalizeRichTextHtml('<p><img src="blob:x"></p>')).not.toBe('');
    expect(normalizeRichTextHtml('<p><img src="blob:x"></p>'))
      .not.toBe(normalizeRichTextHtml(''));
  });
});
