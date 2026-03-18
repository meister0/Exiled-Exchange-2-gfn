import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import { app, nativeImage } from "electron";
import { reconstructClipboard } from "./ClipboardReconstructor";

export interface AvfTextObservation {
  text: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface AvfOcrResult {
  elapsed: number;
  /** All recognized text observations with bounding boxes */
  observations: AvfTextObservation[];
  /** Text from tooltip cluster only (filtered by proximity to cursor) */
  tooltipText: string;
  /** Full OCR text (all observations) */
  fullText: string;
  /** Reconstructed clipboard format */
  clipboard: string | null;
  /** Average confidence of tooltip observations */
  confidence: number;
}

/**
 * Run Apple Vision Framework OCR on a BGRA screenshot crop.
 *
 * Pipeline:
 * 1. Write crop as PNG to temp file
 * 2. Call avf-ocr Swift helper → JSON with text + bounding boxes
 * 3. Cluster observations near cursor → tooltip text
 * 4. Reconstruct clipboard format
 */
export async function ocrWithAppleVision(
  screenshot: { width: number; height: number; data: Uint8Array },
  cursorInCrop: { x: number; y: number },
): Promise<AvfOcrResult> {
  const startTime = performance.now();

  // 1. Convert BGRA buffer to PNG via NativeImage
  const img = nativeImage.createFromBitmap(
    Buffer.from(screenshot.data),
    { width: screenshot.width, height: screenshot.height },
  );
  const pngBuffer = img.toPNG();

  // Write to temp file
  const tmpPath = path.join(app.getPath("temp"), `avf-ocr-${Date.now()}.png`);
  await writeFile(tmpPath, pngBuffer);

  // 2. Call Swift helper
  const avfBinary = path.join(__dirname, "avf-ocr");
  let observations: AvfTextObservation[];
  try {
    const stdout = await execFileAsync(avfBinary, [tmpPath]);
    observations = JSON.parse(stdout) as AvfTextObservation[];
  } finally {
    unlink(tmpPath).catch(() => {});
  }

  // 3. Cluster: find observations belonging to tooltip (near cursor)
  const tooltipObs = clusterTooltipObservations(
    observations,
    cursorInCrop,
    screenshot.width,
    screenshot.height,
  );

  // Sort tooltip observations top-to-bottom, left-to-right
  tooltipObs.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);

  const tooltipText = tooltipObs.map((o) => o.text).join("\n");
  const fullText = observations
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
    .map((o) => o.text)
    .join("\n");

  const avgConf =
    tooltipObs.length > 0
      ? tooltipObs.reduce((s, o) => s + o.confidence, 0) / tooltipObs.length
      : 0;

  const elapsed = performance.now() - startTime;

  console.log(
    `[GFN-AVF] OCR done in ${Math.round(elapsed)}ms, ${observations.length} observations, ${tooltipObs.length} in tooltip cluster`,
  );
  // Debug: log all observations with bbox
  for (const o of observations) {
    const inCluster = tooltipObs.includes(o) ? "✓" : "✗";
    console.log(
      `[GFN-AVF] ${inCluster} (${o.bbox.x},${o.bbox.y} ${o.bbox.w}x${o.bbox.h}) "${o.text}"`,
    );
  }
  console.log(`[GFN-AVF] Tooltip text:\n${tooltipText}`);

  // 4. Reconstruct clipboard from tooltip text
  const clipboard = reconstructClipboard(tooltipText);

  return {
    elapsed,
    observations,
    tooltipText,
    fullText,
    clipboard,
    confidence: Math.round(avgConf * 100),
  };
}

/**
 * Cluster text observations that belong to the item tooltip.
 *
 * Anchor-based strategy:
 * 1. Find the "ITEM LEVEL" anchor observation (unique to item tooltips)
 * 2. Use anchor's X range as the tooltip column reference
 * 3. Collect all observations that share similar X range (left-aligned tooltip text)
 * 4. Filter by vertical contiguity (no large gaps)
 */
function clusterTooltipObservations(
  observations: AvfTextObservation[],
  cursor: { x: number; y: number },
  imgWidth: number,
  imgHeight: number,
): AvfTextObservation[] {
  if (observations.length === 0) return [];

  // Step 1: Find "ITEM LEVEL" anchor
  const anchor = observations.find((o) =>
    /ITEM LEVEL\s*\d+/i.test(o.text),
  );

  if (!anchor) {
    console.log("[GFN-AVF] No ITEM LEVEL anchor found, falling back to proximity clustering");
    return proximityFallback(observations, cursor, imgWidth, imgHeight);
  }

  console.log(
    `[GFN-AVF] Anchor: "${anchor.text}" at (${anchor.bbox.x},${anchor.bbox.y}) ${anchor.bbox.w}x${anchor.bbox.h}`,
  );

  // Step 2: Use anchor's center X to define the tooltip column.
  // PoE2 tooltip is wider than the anchor line: mod lines with PREFIX/SUFFIX markers
  // start ~300px left of the anchor, tier markers (T4) appear ~500px right.
  // Map mods are on the opposite side of the screen (X near 0).
  const anchorCenterX = anchor.bbox.x + anchor.bbox.w / 2;
  const xRadius = anchor.bbox.w * 2; // generous: ~530px each side

  // Step 3: Filter observations whose horizontal center falls within tooltip column.
  const candidates = observations.filter((obs) => {
    const obsCenterX = obs.bbox.x + obs.bbox.w / 2;
    return Math.abs(obsCenterX - anchorCenterX) < xRadius;
  });

  if (candidates.length < 3) {
    // Too few matches — widen the search
    return proximityFallback(observations, cursor, imgWidth, imgHeight);
  }

  // Step 4: Sort by Y and filter for vertical contiguity.
  // Remove observations that have a large gap from the main cluster.
  candidates.sort((a, b) => a.bbox.y - b.bbox.y);

  // Find anchor index in sorted candidates
  const anchorIdx = candidates.indexOf(anchor);

  // Typical line height from anchor
  const lineHeight = anchor.bbox.h * 1.8;

  // Expand upward from anchor
  const result: AvfTextObservation[] = [anchor];
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const curr = candidates[i];
    const gap = (result[0].bbox.y) - (curr.bbox.y + curr.bbox.h);
    if (gap > lineHeight * 2) break; // too large a gap — stop
    result.unshift(curr);
  }

  // Expand downward from anchor
  for (let i = anchorIdx + 1; i < candidates.length; i++) {
    const lastIncluded = result[result.length - 1];
    const curr = candidates[i];
    const gap = curr.bbox.y - (lastIncluded.bbox.y + lastIncluded.bbox.h);
    if (gap > lineHeight * 2) break; // too large a gap — stop
    result.push(curr);
  }

  return result;
}

/**
 * Fallback: pick observations closest to cursor.
 */
function proximityFallback(
  observations: AvfTextObservation[],
  cursor: { x: number; y: number },
  imgWidth: number,
  imgHeight: number,
): AvfTextObservation[] {
  const maxDist = Math.max(imgWidth, imgHeight) * 0.45;
  const scored = observations
    .map((obs) => ({
      obs,
      dist: Math.hypot(
        obs.bbox.x + obs.bbox.w / 2 - cursor.x,
        obs.bbox.y + obs.bbox.h / 2 - cursor.y,
      ),
    }))
    .filter((s) => s.dist < maxDist)
    .sort((a, b) => a.dist - b.dist);

  return scored.slice(0, 20).map((s) => s.obs);
}

function execFileAsync(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`avf-ocr failed: ${stderr || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
