import { desktopCapturer, screen } from "electron";
import type { ImageData } from "./utils";

// Large crop centered on cursor. Full screen picks up game UI (health bars etc.)
// which confuses class detection ("Shield" label). Keep crop but large enough.
const CROP_WIDTH = 1200;
const CROP_HEIGHT = 1200;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureScreenAroundCursor(): Promise<{
  image: ImageData;
  cursorInCrop: { x: number; y: number };
}> {
  const cursorPoint = screen.getCursorScreenPoint();
  const primaryDisplay = screen.getPrimaryDisplay();
  const scaleFactor = primaryDisplay.scaleFactor;
  const { width: dispW, height: dispH } = primaryDisplay.size;

  // Retry loop — macOS desktopCapturer returns empty thumbnail on first call
  let bitmap: Buffer = Buffer.alloc(0);
  let fullW = 0;
  let fullH = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: dispW * scaleFactor,
        height: dispH * scaleFactor,
      },
    });

    if (!sources.length) {
      throw new Error("No screen source available for capture");
    }

    const thumbnail = sources[0].thumbnail;
    fullW = thumbnail.getSize().width;
    fullH = thumbnail.getSize().height;

    if (fullW > 0 && fullH > 0) {
      bitmap = thumbnail.toBitmap();
      break;
    }

    console.log(`[GFN] Screenshot attempt ${attempt + 1} returned ${fullW}x${fullH}, retrying...`);
    await sleep(RETRY_DELAY_MS);
  }

  if (fullW === 0 || fullH === 0) {
    throw new Error("Failed to capture screen after retries — check Screen Recording permission");
  }

  const cx = Math.round(cursorPoint.x * scaleFactor);
  const cy = Math.round(cursorPoint.y * scaleFactor);
  const cropW = Math.round(CROP_WIDTH * scaleFactor);
  const cropH = Math.round(CROP_HEIGHT * scaleFactor);

  // Offset crop upward — tooltip is usually above cursor
  let x0 = cx - Math.round(cropW / 2);
  let y0 = cy - Math.round(cropH * 0.7);
  const effectiveCropW = Math.min(cropW, fullW);
  const effectiveCropH = Math.min(cropH, fullH);
  x0 = Math.max(0, Math.min(x0, fullW - effectiveCropW));
  y0 = Math.max(0, Math.min(y0, fullH - effectiveCropH));
  const actualW = Math.min(effectiveCropW, fullW - x0);
  const actualH = Math.min(effectiveCropH, fullH - y0);

  const cropped = new Uint8Array(actualW * actualH * 4);
  for (let row = 0; row < actualH; row++) {
    const srcOffset = ((y0 + row) * fullW + x0) * 4;
    const dstOffset = row * actualW * 4;
    cropped.set(bitmap.subarray(srcOffset, srcOffset + actualW * 4), dstOffset);
  }

  return {
    image: {
      width: actualW,
      height: actualH,
      data: cropped,
    },
    cursorInCrop: {
      x: cx - x0,
      y: cy - y0,
    },
  };
}
