/**
 * backupParse — pure backup parsing/validation, shared by the main thread
 * and the image worker.
 *
 * importDatabase used to do all of this on the main thread: a synchronous
 * JSON.parse of the whole backup (100 MB of base64 freezes for seconds),
 * then the validation, normalisation and base64→Blob decode. That work
 * now runs in the image worker (see imageWorker.js `parseBackup` branch),
 * so importing a large backup no longer freezes the UI. The main thread
 * falls back to calling parseBackup directly when there is no worker
 * (jsdom, old browsers) or the worker call fails — one function, one
 * source of truth for the validation, so the bug-1 guarantees hold on
 * both paths: a corrupt backup throws BEFORE anything is wiped, with the
 * same error messages, and the caller never wipes on a failed import.
 *
 * Pure by design: no IndexedDB, no DOM, no module state. The caller
 * passes the current dataset, the registry and the default dataset id,
 * because the normalisation needs them and the worker cannot read the
 * main thread's module state.
 */

/** Convert a data-URL string directly to a Blob using atob + Uint8Array. */
export function dataURLtoBlob(dataURL) {
  const comma = dataURL.indexOf(',');
  const mime = dataURL.slice(5, dataURL.indexOf(';'));
  const b64 = dataURL.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const dsPrefixFor = (id) => `sb_ds_${id}__`;

/**
 * Parse a backup JSON string and validate + normalise it, decoding every
 * image to a Blob. Throws the same errors importDatabase used to throw,
 * before any wipe has happened. Returns the pieces the caller needs to
 * perform the import:
 *   otherEntries   — non-image [key, value] pairs, already normalised
 *   imageBlobs     — Map<key, Blob> for the image entries (thumbs excluded;
 *                    initStorage regenerates them from the full images)
 *   importTargetId — the dataset the backup targets (single-dataset /
 *                    legacy only; null for a whole-database backup)
 *   wipeAll        — true for a whole-database backup (wipe everything)
 *   wipePrefix     — the dataset prefix to wipe for a single-dataset /
 *                    legacy backup (null for a whole-database backup)
 */
export const parseBackup = async (
  jsonString,
  { currentDataset, datasets, defaultDatasetId },
) => {
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid backup: could not parse JSON. File may be corrupted.');
  }
  if (!Array.isArray(data)) throw new Error('Invalid backup: expected a JSON array');

  // Validate pair shape before touching anything: a non-iterable element
  // (e.g. a bare number or null) would otherwise throw a raw TypeError
  // out of the filter/find/destructure calls below.
  for (const entry of data) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error('Invalid backup: expected a JSON array of [key, value] pairs.');
    }
  }

  // Validate before clearing — protect against importing a wrong/empty file
  const sbKeys = data.filter(([k]) => typeof k === 'string' && String(k).startsWith('sb_'));
  if (sbKeys.length === 0 && data.length > 0) {
    throw new Error('Invalid backup: file contains no Snowball data (sb_ keys).');
  }

  // Three backup shapes, all restored losslessly (images are stored as
  // data-URLs and converted back to Blobs byte-for-byte — never re-encoded):
  //  1. Whole-database backup (current format): carries sb_datasets +
  //     sb_current_dataset plus every dataset's keys. Restores everything.
  //  2. Single-dataset backup (v4 marker ['sb_dataset', {id,index,year}]):
  //     restores into that dataset only, other datasets are untouched.
  //  3. Legacy flat backup (pre-datasets): keys without a dataset prefix
  //     are migrated into Nifty 50 / 2026, replacing the whole database
  //     exactly as the old whole-database backups did.
  const marker = data.find(([k]) => k === 'sb_dataset');
  const hasRegistry = data.some(([k]) => k === 'sb_datasets');

  let normalised = [];
  let wipeAll = false;
  let wipePrefix = null;
  // The target dataset of a single-dataset / legacy backup: only becomes
  // current once the backup has validated (see below) — a failed import
  // must not leave the module pointing at another dataset.
  let importTargetId = null;

  if (hasRegistry) {
    wipeAll = true;
    for (const [k, v] of data) {
      if (k === 'sb_dataset' || typeof k !== 'string' || !k.startsWith('sb_')) continue;
      if (k === 'sb_datasets' || k === 'sb_current_dataset' || k.startsWith('sb_ds_')) {
        normalised.push([k, v]);
      } else {
        normalised.push([`${dsPrefixFor(defaultDatasetId)}${k.slice(3)}`, v]);
      }
    }
  } else {
    const target = marker?.[1]?.id
      ? { id: marker[1].id, index: marker[1].index, year: marker[1].year }
      : currentDataset;
    const targetPrefix = dsPrefixFor(target.id);
    wipePrefix = targetPrefix;
    for (const [k, v] of data) {
      if (k === 'sb_dataset' || typeof k !== 'string' || !k.startsWith('sb_')) continue;
      if (k.startsWith('sb_ds_')) {
        const entryDs = k.slice(6).split('__')[0];
        if (entryDs !== target.id) {
          throw new Error('Invalid backup: it mixes data from multiple index/year datasets.');
        }
        normalised.push([k, v]);
      } else {
        normalised.push([`${targetPrefix}${k.slice(3)}`, v]); // legacy flat key
      }
    }
    // Register the target dataset if it is new, and select it — after import
    // the app reloads into the restored dataset.
    if (!datasets.some((d) => d.id === target.id)) {
      normalised.push(['sb_datasets', [...datasets, target]]);
    }
    normalised.push(['sb_current_dataset', target.id]);
    importTargetId = target.id;
  }

  // Split the backup into image entries (data-URL strings) and everything
  // else, BEFORE wiping — the split is needed for the validation below.
  // Thumbnails are skipped: initStorage regenerates them from the full
  // images after import.
  const imageEntries = normalised.filter(([k, v]) =>
    typeof v === 'string' && v.startsWith('data:image') && !String(k).includes('__thumb_')
  );
  const otherEntries = normalised.filter(([, v]) =>
    !(typeof v === 'string' && v.startsWith('data:image'))
  );

  // Decode every image BEFORE wiping: a corrupt/truncated base64 image
  // (atob throws InvalidCharacterError) must fail here, while the old
  // database is still intact — never after the wipe, which used to leave
  // a half-restored database. The Blobs are held in memory and written
  // after the wipe, so each image is decoded exactly once.
  const imageBlobs = new Map();
  for (let i = 0; i < imageEntries.length; i++) {
    const [k, v] = imageEntries[i];
    let blob;
    try {
      blob = dataURLtoBlob(v);
    } catch {
      throw new Error(`Invalid backup: the image stored under "${k}" is corrupted (bad base64 data). Nothing was changed.`);
    }
    if (blob.size === 0) {
      throw new Error(`Invalid backup: the image stored under "${k}" is empty. Nothing was changed.`);
    }
    imageBlobs.set(k, blob);
    // Yield periodically so a huge backup doesn't freeze the UI while
    // decoding on the main-thread fallback path (in the worker this is
    // harmless — the decode is already off-thread).
    if ((i + 1) % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  return { otherEntries, imageBlobs, importTargetId, wipeAll, wipePrefix };
};
