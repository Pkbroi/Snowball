import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

/* ─── Remarks editor (lazy) ──────────────────────────────────────────────
   The journal's remarks modal uses a full toolbar Quill. It is the same
   editor as before — same value, same onChange, same toolbar — but it
   lives in its own lazy chunk (perf step 8): WeeklyJournal never imports
   react-quill-new, so the ~200KB Quill bundle is not in the journal's
   initial load. It loads only when the user actually opens a remarks
   modal. ─────────────────────────────────────────────────────────────── */

export default function RemarksEditor({ value, onChange }) {
  return (
    <ReactQuill
      theme="snow"
      value={value}
      onChange={onChange}
      placeholder="Start writing… (formatting toolbar available)"
      className="h-full min-h-[350px] text-on-surface"
      modules={{
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image'],
          ['clean'],
        ],
      }}
    />
  );
}
