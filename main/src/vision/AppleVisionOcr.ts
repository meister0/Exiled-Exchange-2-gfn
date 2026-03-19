import { spawn } from "child_process";
import path from "path";
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

  // 1. Send raw BGRA directly to Swift helper — no PNG encode/decode overhead.
  // This avoids blocking the main thread with nativeImage.toPNG().
  const avfBinary = path.join(__dirname, "avf-ocr");
  const observations = await spawnAvfOcr(
    avfBinary,
    Buffer.from(screenshot.data),
    ["--bgra", String(screenshot.width), String(screenshot.height)],
  );

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
    // Fallback: use CLASS name as anchor for simple format (no Alt held)
    const CLASS_NAMES_RE = /^(AMULET|RING|BELT|QUIVER|GLOVES|HELMET|BOOTS|BODY ARMOUR|SHIELD|FOCUS|BOW|CROSSBOW|WAND|SCEPTRE|STAFF|TWO HAND (?:MACE|SWORD)|ONE HAND (?:MACE|SWORD)|FLAIL|SPEAR|QUARTERSTAFF|DAGGER|CLAW|TRAP|FLASK|JEWEL|CHARM)S?$/i;
    const classAnchor = observations.find((o) => CLASS_NAMES_RE.test(o.text.trim()));
    if (classAnchor) {
      console.log(
        `[GFN-AVF] No ITEM LEVEL, using class anchor: "${classAnchor.text}" at (${classAnchor.bbox.x},${classAnchor.bbox.y})`,
      );
      return clusterByXColumn(observations, classAnchor);
    }
    console.log("[GFN-AVF] No anchor found, falling back to proximity clustering");
    return proximityFallback(observations, cursor, imgWidth, imgHeight);
  }

  console.log(
    `[GFN-AVF] Anchor: "${anchor.text}" at (${anchor.bbox.x},${anchor.bbox.y}) ${anchor.bbox.w}x${anchor.bbox.h}`,
  );

  return clusterByXColumn(observations, anchor);
}

/**
 * Cluster observations by X-column alignment relative to an anchor.
 * Works for both ITEM LEVEL and CLASS NAME anchors.
 */
// Quick noise check for observations that should never be in tooltip
const OBS_NOISE_RE = /^(N?VENTORY|COSMETICS?|INSPECT|ALT|ANGE|FREE\s+(FOR|TOR)\s+ALL|JAPAN|EXILED EXCHANGE|IS READY|RUNNING IN)\b/i;

function clusterByXColumn(
  observations: AvfTextObservation[],
  anchor: AvfTextObservation,
): AvfTextObservation[] {
  const anchorCenterX = anchor.bbox.x + anchor.bbox.w / 2;
  const xRadius = anchor.bbox.w * 2;

  // Tighter X radius for lines above anchor (name/base type are centered)
  // Wider for lines below (PREFIX/SUFFIX labels are offset left)
  const xRadiusAbove = anchor.bbox.w * 1.2;

  const candidates = observations.filter((obs) => {
    if (OBS_NOISE_RE.test(obs.text.trim())) return false;
    const obsCenterX = obs.bbox.x + obs.bbox.w / 2;
    const aboveAnchor = obs.bbox.y < anchor.bbox.y;
    const limit = aboveAnchor ? xRadiusAbove : xRadius;
    return Math.abs(obsCenterX - anchorCenterX) < limit;
  });

  if (candidates.length < 3) return [anchor];

  candidates.sort((a, b) => a.bbox.y - b.bbox.y);
  const anchorIdx = candidates.indexOf(anchor);
  const lineHeight = anchor.bbox.h * 1.8;

  const result: AvfTextObservation[] = [anchor];
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const gap = result[0].bbox.y - (candidates[i].bbox.y + candidates[i].bbox.h);
    if (gap > lineHeight * 2) break;
    result.unshift(candidates[i]);
  }
  for (let i = anchorIdx + 1; i < candidates.length; i++) {
    const last = result[result.length - 1];
    const gap = candidates[i].bbox.y - (last.bbox.y + last.bbox.h);
    if (gap > lineHeight * 2) break;
    result.push(candidates[i]);
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

function spawnAvfOcr(
  binary: string,
  data: Buffer,
  args: string[] = [],
): Promise<AvfTextObservation[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`avf-ocr exited ${code}: ${stderr}`));
        return;
      }
      try {
        const json = Buffer.concat(chunks).toString();
        resolve(JSON.parse(json) as AvfTextObservation[]);
      } catch (e) {
        reject(new Error(`avf-ocr JSON parse error: ${e}`));
      }
    });

    proc.on("error", (err) => reject(err));

    // Pipe data and close stdin
    proc.stdin.write(data);
    proc.stdin.end();
  });
}
