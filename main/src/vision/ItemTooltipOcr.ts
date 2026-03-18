import * as Bindings from "./wasm-bindings";
import { cv, tessApi } from "./wasm-bindings";
import { timeIt, type ImageData } from "./utils";
import { detectTooltip } from "./TooltipDetector";
import { reconstructClipboard } from "./ClipboardReconstructor";

export interface ItemOcrResult {
  elapsed: number;
  text: string;
  clipboard: string | null;
  confidence: number;
  tooltipDetected: boolean;
  tooltipRect: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Full GFN OCR pipeline:
 * 1. Detect tooltip region (dark rectangle near cursor)
 * 2. Crop to tooltip only
 * 3. Preprocess (grayscale, upscale, threshold)
 * 4. Tesseract OCR
 */
export function ocrItemTooltip(
  screenshot: ImageData,
  cursorInCrop: { x: number; y: number },
): ItemOcrResult {
  let elapsed = 0;

  // Phase 2: detect tooltip
  const detection = detectTooltip(screenshot, cursorInCrop);
  elapsed += detection.elapsed;

  // Tooltip must be: reasonable size + close to cursor
  const maxDist = Math.max(screenshot.width, screenshot.height) * 0.5;
  let tooltipDist = Infinity;
  if (detection.tooltip) {
    tooltipDist = Math.hypot(
      detection.tooltip.x + detection.tooltip.width / 2 - cursorInCrop.x,
      detection.tooltip.y + detection.tooltip.height / 2 - cursorInCrop.y,
    );
  }
  const tooltipDetected =
    detection.tooltipImage !== null &&
    detection.tooltip!.width > 200 &&
    detection.tooltip!.height > 150 &&
    detection.tooltip!.width < screenshot.width * 0.55 &&
    detection.tooltip!.height < screenshot.height * 0.7 &&
    tooltipDist < maxDist;
  const ocrTarget = tooltipDetected ? detection.tooltipImage! : screenshot;

  console.log(
    `[GFN] Tooltip ${tooltipDetected ? `detected: ${detection.tooltip!.width}x${detection.tooltip!.height} at (${detection.tooltip!.x},${detection.tooltip!.y})` : "NOT detected, using full crop"}`,
  );

  // Create OpenCV mat from target image
  const colorMat = new cv.Mat(
    ocrTarget.height,
    ocrTarget.width,
    cv.CV_8UC4,
  );
  colorMat.data.set(ocrTarget.data);

  const grayMat = new cv.Mat();
  elapsed += timeIt(() => {
    cv.cvtColor(colorMat, grayMat, cv.COLOR_BGRA2GRAY);

    // Upscale 2x for better OCR on small text
    cv.resize(
      grayMat,
      grayMat,
      new cv.Size(grayMat.cols * 2, grayMat.rows * 2),
      0,
      0,
      cv.INTER_CUBIC,
    );
  });

  const threshMat = new cv.Mat();
  elapsed += timeIt(() => {
    // THRESH_BINARY: bright text pixels (> 100) → white, dark bg → black
    cv.threshold(grayMat, threshMat, 100, 255, cv.THRESH_BINARY);
  });

  // Tesseract PSM 6 = "Assume a single uniform block of text"
  Bindings.ocrSetImage(
    threshMat.data,
    threshMat.cols,
    threshMat.rows,
    threshMat.channels(),
  );
  tessApi.SetVariable("tessedit_pageseg_mode", "6");

  elapsed += timeIt(() => {
    tessApi.Recognize();
  });

  const text = tessApi.GetUTF8Text().trim();
  const confidence = tessApi.MeanTextConf();

  colorMat.delete();
  grayMat.delete();
  threshMat.delete();

  // Phase 3: reconstruct clipboard format from OCR text
  const clipboard = reconstructClipboard(text);

  return {
    elapsed,
    text,
    clipboard,
    confidence,
    tooltipDetected,
    tooltipRect: detection.tooltip,
  };
}
