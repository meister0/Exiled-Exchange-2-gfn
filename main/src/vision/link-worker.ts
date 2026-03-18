import { parentPort } from "worker_threads";
import * as Comlink from "comlink";
import nodeEndpoint from "comlink/dist/umd/node-adapter";
import * as Bindings from "./wasm-bindings";
import { HeistGemFinder } from "./HeistGemFinder";
import { ocrItemTooltip } from "./ItemTooltipOcr";
import { ImageData } from "./utils";

let _heistGems: HeistGemFinder;
let _changeLangPromise = Promise.resolve();

const WorkerBody = {
  async init(binDir: string) {
    await Bindings.init(binDir);
    if (process.platform === "win32") {
      _heistGems = await HeistGemFinder.create(binDir);
    }
  },
  async changeLanguage(lang: string, binDir: string) {
    await _changeLangPromise;
    _changeLangPromise = Bindings.changeLanguage(lang, binDir);
    await _changeLangPromise;
  },
  async findHeistGems(screenshot: ImageData) {
    await _changeLangPromise;
    return _heistGems.ocrScreenshot(screenshot);
  },
  async ocrGfnItem(
    screenshot: ImageData,
    cursorInCrop: { x: number; y: number },
  ) {
    await _changeLangPromise;
    return ocrItemTooltip(screenshot, cursorInCrop);
  },
};
Comlink.expose(WorkerBody, nodeEndpoint(parentPort!));

export type WorkerAPI = Comlink.Remote<typeof WorkerBody>;
