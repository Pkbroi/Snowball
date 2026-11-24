// Full-quality chart export: the stored original image plus the annotation
// marks, composited on a canvas at the image's NATIVE size and saved as a
// lossless PNG.
//
// This is deliberately NOT a screenshot of the lightbox: a screenshot only
// captures screen pixels (~1920x1080 at best) and would bake in the
// toolbar, crosshairs and zoom controls. Here the original is drawn
// 1:1 and every mark is re-drawn from its stored % position, so the
// download is pixel-identical to the original plus the marks, at full
// original resolution. PNG is lossless; JPG would re-compress the chart
// (smudged lines/text) and a PDF would only wrap the same raster.
//
// On-screen sizes are in overlay px (the overlay is sized to the
// displayed picture rect), so every size is multiplied by
// scale = naturalWidth / displayedWidth to reach native px. The export
// always draws the CLEAN marks: no selection highlight, no resize
// handles, no delete button, no crosshairs — and it ignores the current
// pan/zoom, since marks are stored as % of the picture.

const ARROW_STYLE = {
  'arrow-green-up': { color: '#22c55e', dir: 'up' },
  'arrow-green-down': { color: '#22c55e', dir: 'down' },
  'arrow-red-up': { color: '#ef4444', dir: 'up' },
  'arrow-red-down': { color: '#ef4444', dir: 'down' },
  'arrow-yellow': { color: '#eab308', dir: 'down' },
};

// Same arrow polygons as AnnArrow in TradeDetail.jsx (viewBox 0 0 24 32),
// as [x, y] points in viewBox units.
const ARROW_POINTS = {
  up: [[12, 1], [21, 13], [15.5, 13], [15.5, 31], [8.5, 31], [8.5, 13], [3, 13]],
  down: [[12, 31], [3, 19], [8.5, 19], [8.5, 1], [15.5, 1], [15.5, 19], [21, 19]],
};

function drawLine(ctx, ann, W, H, scale) {
  const y = (ann.y / 100) * H;
  const thickness = 2 * scale;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 4 * scale;
  ctx.shadowOffsetY = 1 * scale;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, y - thickness / 2, W, thickness);
  ctx.restore();
}

function drawArrow(ctx, ann, W, H, scale) {
  const style = ARROW_STYLE[ann.type];
  if (!style) return;
  const w = 26 * scale;
  const h = (26 * 32 / 24) * scale;
  const k = w / 24; // viewBox units -> native px
  const cx = (ann.x / 100) * W;
  const top = style.dir === 'up' ? (ann.y / 100) * H : (ann.y / 100) * H - h;
  const left = cx - w / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 3 * scale;
  ctx.shadowOffsetY = 1 * scale;
  ctx.beginPath();
  ARROW_POINTS[style.dir].forEach(([px, py], i) => {
    const x = left + px * k;
    const y = top + py * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = style.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = Math.max(1, k);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }
    let line = words[0];
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (ctx.measureText(next).width <= maxWidth) line = next;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

function drawComment(ctx, ann, W, H, scale) {
  const text = (ann.text ?? '').trim();
  // An empty comment carries no content — the box alone would be a black
  // rectangle with nothing in it, so it is left out of the export.
  if (!text) return;
  const x = (ann.x / 100) * W;
  const y = (ann.y / 100) * H;
  const fontSize = 13 * scale;
  const padding = 8 * scale;
  const radius = 4 * scale;
  const lineHeight = 13 * 1.5 * scale; // textarea inherits line-height 1.5
  const boxW = (ann.w ?? 180) * scale;
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, sans-serif`;
  const textWidth = boxW - padding * 2;
  const lines = wrapText(ctx, text, textWidth);
  const contentH = lines.length * lineHeight;
  // On screen the box auto-grows up to 200px, then scrolls; a resized
  // box keeps its stored height instead.
  const boxH = ann.h
    ? ann.h * scale
    : Math.min(Math.max(contentH + padding * 2, 48 * scale), 200 * scale);
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, radius);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = Math.max(1, scale);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  // Clip the text to the box so a fixed-height box never overflows it,
  // the way the textarea's overflow does on screen.
  ctx.beginPath();
  ctx.rect(x + padding, y + padding, textWidth, boxH - padding * 2);
  ctx.clip();
  lines.forEach((line, i) => {
    ctx.fillText(line, x + padding, y + padding + i * lineHeight);
  });
  ctx.restore();
}

function drawPencil(ctx, ann, W, H, scale) {
  const pts = (ann.points ?? []).map(([px, py]) => [(px / 100) * W, (py / 100) * H]);
  if (pts.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const trace = (width, color) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  if (pts.length === 1) {
    // A tap with no drag is a dot, not an empty stroke.
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], 4 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], 2.25 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.restore();
    return;
  }
  // Same as the on-screen stroke: a wider white edge under a bold black core.
  trace(8 * scale, '#ffffff');
  trace(4.5 * scale, '#000000');
  ctx.restore();
}

// Draws one stored mark onto ctx. W/H are the canvas (native) size.
export function drawAnnotation(ctx, ann, W, H, scale) {
  if (ann.type === 'line') drawLine(ctx, ann, W, H, scale);
  else if (ann.type === 'comment') drawComment(ctx, ann, W, H, scale);
  else if (ann.type === 'pencil') drawPencil(ctx, ann, W, H, scale);
  else drawArrow(ctx, ann, W, H, scale);
}

// Renders img (an <img> showing the ORIGINAL chart) plus annotations to a
// canvas at the image's native size and returns a lossless PNG Blob.
// displayedWidth is the on-screen picture width in px (picRect.width) —
// the scale that maps overlay px to native px.
export function exportChartPng(img, annotations, displayedWidth) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const scale = img.naturalWidth / displayedWidth;
  for (const ann of annotations ?? []) drawAnnotation(ctx, ann, canvas.width, canvas.height, scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
      'image/png',
    );
  });
}
