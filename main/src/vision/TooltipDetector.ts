import { cv } from "./wasm-bindings";
import { timeIt, type ImageData } from "./utils";

export interface TooltipRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionResult {
  elapsed: number;
  tooltip: TooltipRegion | null;
  tooltipImage: ImageData | null;
}

interface DarkBand {
  yTop: number;
  yBottom: number;
}

/**
 * Finds all consecutive runs of rows where darkness >= threshold.
 * Returns runs sorted by length (longest first).
 */
function findDarkBands(
  rowDark: Float32Array,
  threshold: number,
  minHeight: number,
): DarkBand[] {
  const bands: DarkBand[] = [];
  let curStart = -1;

  for (let i = 0; i < rowDark.length; i++) {
    if (rowDark[i] >= threshold) {
      if (curStart === -1) curStart = i;
    } else {
      if (curStart !== -1) {
        const height = i - curStart;
        if (height >= minHeight) {
          bands.push({ yTop: curStart, yBottom: i - 1 });
        }
        curStart = -1;
      }
    }
  }
  if (curStart !== -1) {
    const height = rowDark.length - curStart;
    if (height >= minHeight) {
      bands.push({ yTop: curStart, yBottom: rowDark.length - 1 });
    }
  }

  return bands.sort((a, b) => (b.yBottom - b.yTop) - (a.yBottom - a.yTop));
}

/**
 * Within a vertical band, find the widest consecutive span of dark columns.
 */
function findColumnSpan(
  data: Uint8Array,
  w: number,
  yTop: number,
  yBottom: number,
  threshold: number,
): [number, number] | null {
  const spanHeight = yBottom - yTop + 1;
  const colDark = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = yTop; y <= yBottom; y++) {
      if (data[y * w + x] === 255) count++;
    }
    colDark[x] = count / spanHeight;
  }

  // Find widest consecutive run
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < w; i++) {
    if (colDark[i] >= threshold) {
      if (curStart === -1) curStart = i;
      curLen++;
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  if (curLen > bestLen) {
    bestLen = curLen;
    bestStart = curStart;
  }

  if (bestStart === -1 || bestLen < 80) return null;
  return [bestStart, bestStart + bestLen - 1];
}

/**
 * Detects PoE2 tooltip by finding dark rectangles and picking the one
 * closest to the cursor.
 *
 * Handles multiple dark regions (e.g., tooltip + map mods panel)
 * by scoring candidates on proximity to cursor.
 */
export function detectTooltip(
  screenshot: ImageData,
  cursorInCrop: { x: number; y: number },
): DetectionResult {
  let elapsed = 0;

  const colorMat = new cv.Mat(screenshot.height, screenshot.width, cv.CV_8UC4);
  colorMat.data.set(screenshot.data);

  const grayMat = new cv.Mat();
  const darkMask = new cv.Mat();

  elapsed += timeIt(() => {
    cv.cvtColor(colorMat, grayMat, cv.COLOR_BGRA2GRAY);
    // PoE2 tooltip bg is very dark (~10-20 grayscale), game world avg ~35-40
    // With smaller crop focused on tooltip area, threshold 30 works better
    cv.threshold(grayMat, darkMask, 30, 255, cv.THRESH_BINARY_INV);
  });

  const w = darkMask.cols;
  const h = darkMask.rows;
  const data = darkMask.data;

  // Debug: compute avg brightness of whole image
  const grayData = grayMat.data;
  let totalBrightness = 0;
  for (let i = 0; i < grayData.length; i++) totalBrightness += grayData[i];
  const avgBrightness = totalBrightness / grayData.length;
  console.log(`[GFN] Avg brightness: ${avgBrightness.toFixed(1)}, threshold=40, image ${w}x${h}`);

  // Row darkness profile
  const rowDark = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x] === 255) count++;
    }
    rowDark[y] = count / w;
  }

  // Debug: log row darkness histogram (sample every 100 rows)
  const sampleRows = [];
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 15))) {
    sampleRows.push(`y${y}=${(rowDark[y] * 100).toFixed(0)}%`);
  }
  console.log(`[GFN] Row darkness: ${sampleRows.join(", ")}`);

  // Find all dark bands (min 50px tall)
  const bands = findDarkBands(rowDark, 0.15, 50);

  // For each band, find column span and create candidate rectangle
  type Candidate = TooltipRegion & { dist: number };
  const candidates: Candidate[] = [];

  for (const band of bands) {
    const colSpan = findColumnSpan(data, w, band.yTop, band.yBottom, 0.2);
    if (!colSpan) continue;

    const [xLeft, xRight] = colSpan;
    const rect: TooltipRegion = {
      x: xLeft,
      y: band.yTop,
      width: xRight - xLeft + 1,
      height: band.yBottom - band.yTop + 1,
    };

    // Distance from cursor to rectangle center
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const dist = Math.hypot(cx - cursorInCrop.x, cy - cursorInCrop.y);

    candidates.push({ ...rect, dist });
  }

  if (candidates.length === 0) {
    colorMat.delete();
    grayMat.delete();
    darkMask.delete();
    return { elapsed, tooltip: null, tooltipImage: null };
  }

  // Filter out unreasonably large candidates (> 60% of crop = probably not just a tooltip)
  const maxW = w * 0.6;
  const maxH = h * 0.7;
  const reasonable = candidates.filter(
    (c) => c.width < maxW || c.height < maxH,
  );

  // Score: prefer close to cursor, penalize very large regions
  const scored = (reasonable.length > 0 ? reasonable : candidates).map(
    (c) => {
      const area = c.width * c.height;
      const cropArea = w * h;
      const areaRatio = area / cropArea; // 0..1, lower = more likely tooltip
      // Tooltip is typically 10-30% of crop area
      const areaPenalty = areaRatio > 0.4 ? areaRatio * 500 : 0;
      return { ...c, score: c.dist + areaPenalty };
    },
  );
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  const tooltip: TooltipRegion = {
    x: best.x,
    y: best.y,
    width: best.width,
    height: best.height,
  };

  console.log(
    `[GFN] Tooltip candidates: ${candidates.length}, picked ${tooltip.width}x${tooltip.height} at (${tooltip.x},${tooltip.y}), dist=${Math.round(best.dist)}px`,
  );

  const roi = colorMat.roi(
    new cv.Rect(tooltip.x, tooltip.y, tooltip.width, tooltip.height),
  );
  const roiData = new Uint8Array(roi.data.length);
  roiData.set(roi.data);
  const tooltipImage: ImageData = {
    width: tooltip.width,
    height: tooltip.height,
    data: roiData,
  };
  roi.delete();

  colorMat.delete();
  grayMat.delete();
  darkMask.delete();

  return { elapsed, tooltip, tooltipImage };
}
