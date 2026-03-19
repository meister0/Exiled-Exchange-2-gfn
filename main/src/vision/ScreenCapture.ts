import { desktopCapturer, screen } from "electron";
import type { ImageData } from "./utils";

// Send full screen to OCR — anchor-based clustering handles noise filtering.
// Cropping loses tooltip content when cursor is near screen edges.
const CROP_WIDTH = 0;  // 0 = full screen
const CROP_HEIGHT = 0;
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

  // Full screen — no crop. Anchor-based clustering handles noise.
  return {
    image: {
      width: fullW,
      height: fullH,
      data: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength),
    },
    cursorInCrop: { x: cx, y: cy },
  };
}
