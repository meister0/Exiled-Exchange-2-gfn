import { screen, globalShortcut } from "electron";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import { captureScreenAroundCursor } from "../vision/ScreenCapture";
import { ocrWithAppleVision } from "../vision/AppleVisionOcr";
import { loadStatMatchers } from "../vision/StatMatcher";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private stashScroll = false;
  private logKeys = false;
  private _isGfnMode = false;

  /** True when windowTitle indicates GeForce NOW (OCR instead of clipboard) */
  get isGfnMode() { return this._isGfnMode; }
  set isGfnMode(v: boolean) {
    if (v !== this._isGfnMode) {
      this._isGfnMode = v;
      console.log(`[GFN] Mode: ${v ? "GFN (OCR)" : "Local (clipboard)"}`);
    }
  }
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();

    // Load stat matchers for OCR mod normalization (GFN feature)
    try {
      const isDev = process.env.VITE_DEV_SERVER_URL != null;
      const dataDir = isDev
        ? require("path").join(__dirname, "../../renderer/public/data/en")
        : require("path").join(__dirname, "../renderer/data/en");
      loadStatMatchers(dataDir);
    } catch (e) {
      console.log("[GFN] Failed to load stat matchers:", e);
    }

    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            if (!this._isGfnMode) {
              // Normal mode: register via globalShortcut
              this.register();
            }
          } else {
            if (!this._isGfnMode) {
              this.unregister();
            }
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      }
    });

    // GFN mode: use uIOhook for hotkey detection instead of globalShortcut.
    // uIOhook works in fullscreen Spaces, poeWindow.isActive gates it to GFN only.
    uIOhook.on("keydown", (e) => {
      if (this.logKeys) {
        const pressed = eventToString(e);
        this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
      }

      if (!this._isGfnMode || !this.poeWindow.isActive) return;

      const pressed = eventToString(e);
      for (const entry of this.actions) {
        if (entry.shortcut === pressed) {
          console.log(`[GFN] uIOhook matched: "${pressed}" → ${entry.action.type}`);

          // Release keys
          if (entry.keepModKeys) {
            const nonModKey = entry.shortcut
              .split(" + ")
              .filter((key) => !isModKey(key))[0];
            uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
          } else {
            entry.shortcut
              .split(" + ")
              .reverse()
              .forEach((key) => {
                uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
              });
          }

          // Must use nextTick — uIOhook callback runs on native thread,
          // OverlayController calls must happen on main JS thread
          process.nextTick(() => this.handleGfnAction(entry));
          break;
        }
      }
    });
    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          uIOhook.keyTap(UiohookKey.ArrowRight);
        } else if (e.rotation < 0) {
          uIOhook.keyTap(UiohookKey.ArrowLeft);
        }
      }
    });
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    const validActions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );

    if (!this._isGfnMode) {
      this.unregister();
    }
    this.actions = validActions;

    if (!this._isGfnMode && this.poeWindow.isActive) {
      this.register();
    }

    if (this._isGfnMode) {
      console.log(`[GFN] ${validActions.length} actions loaded (uIOhook mode)`);
    }
  }


  private handleGfnAction(entry: ShortcutAction) {
    console.log(`[GFN] handleGfnAction: type=${entry.action.type}`);
    if (entry.action.type === "toggle-overlay") {
      console.log("[GFN] calling toggleActiveState");
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;
      const pressPosition = screen.getCursorScreenPoint();
      console.log("[GFN] copy-item → OCR pipeline");
      captureScreenAroundCursor()
        .then((capture) => {
          if (capture.image.width === 0 || capture.image.height === 0) {
            throw new Error("Empty screenshot (0x0)");
          }
          return ocrWithAppleVision(capture.image, capture.cursorInCrop);
        })
        .then((result) => {
          console.log(`[GFN] OCR done in ${Math.round(result.elapsed)}ms`);
          if (result.clipboard) {
            this.areaTracker.removeListeners();
            this.server.sendEventTo("last-active", {
              name: "MAIN->CLIENT::item-text",
              payload: {
                target: action.target,
                clipboard: result.clipboard,
                position: pressPosition,
                focusOverlay: Boolean(action.focusOverlay),
              },
            });
            if (action.focusOverlay && this.overlay.wasUsedRecently) {
              this.overlay.assertOverlayActive();
            }
          } else {
            console.log("[GFN] Could not reconstruct clipboard from OCR");
          }
        })
        .catch((err) => {
          console.error("[GFN] OCR failed:", err instanceof Error ? err.message : err);
        });
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    }
  }

  private register() {
    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => {
          if (this.logKeys) {
            this.logger.write(
              `debug [Shortcuts] Action type: ${entry.action.type}`,
            );
          }

          if (entry.keepModKeys) {
            const nonModKey = entry.shortcut
              .split(" + ")
              .filter((key) => !isModKey(key))[0];
            uIOhook.keyToggle(UiohookKey[nonModKey as UiohookKeyT], "up");
          } else {
            entry.shortcut
              .split(" + ")
              .reverse()
              .forEach((key) => {
                uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
              });
          }

          if (entry.action.type === "toggle-overlay") {
            this.areaTracker.removeListeners();
            this.overlay.toggleActiveState();
          } else if (entry.action.type === "paste-in-chat") {
            typeInChat(entry.action.text, entry.action.send, this.clipboard);
          } else if (entry.action.type === "trigger-event") {
            this.server.sendEventTo("broadcast", {
              name: "MAIN->CLIENT::widget-action",
              payload: { target: entry.action.target },
            });
          } else if (entry.action.type === "stash-search") {
            stashSearch(entry.action.text, this.clipboard, this.overlay);
          } else if (entry.action.type === "copy-item") {
            const { action } = entry;
            const pressPosition = screen.getCursorScreenPoint();

            if (this._isGfnMode && process.platform === "darwin") {
              // GFN mode: OCR screenshot instead of clipboard
              console.log("[GFN] copy-item in GFN mode → OCR pipeline");
              captureScreenAroundCursor()
                .then((capture) => {
                  // Release keys AFTER screenshot (Alt held for advanced mods)
                  entry.shortcut.split(" + ").reverse().forEach((key) => {
                    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
                  });
                  if (capture.image.width === 0 || capture.image.height === 0) {
                    throw new Error("Empty screenshot (0x0)");
                  }
                  return ocrWithAppleVision(capture.image, capture.cursorInCrop);
                })
                .then((result) => {
                  console.log(`[GFN] OCR done in ${Math.round(result.elapsed)}ms, confidence=${result.confidence}`);
                  const clipboardText = result.clipboard;
                  if (clipboardText) {
                    this.areaTracker.removeListeners();
                    this.server.sendEventTo("last-active", {
                      name: "MAIN->CLIENT::item-text",
                      payload: {
                        target: action.target,
                        clipboard: clipboardText,
                        position: pressPosition,
                        focusOverlay: Boolean(action.focusOverlay),
                      },
                    });
                    if (action.focusOverlay && this.overlay.wasUsedRecently) {
                      this.overlay.assertOverlayActive();
                    }
                  } else {
                    console.log("[GFN] Could not reconstruct clipboard from OCR");
                  }
                })
                .catch((err) => {
                  console.error("[GFN] OCR failed:", err instanceof Error ? err.message : err);
                });
            } else {
              // Normal mode: read clipboard
              this.clipboard
                .readItemText()
                .then((clipboard) => {
                  this.areaTracker.removeListeners();
                  this.server.sendEventTo("last-active", {
                    name: "MAIN->CLIENT::item-text",
                    payload: {
                      target: action.target,
                      clipboard,
                      position: pressPosition,
                      focusOverlay: Boolean(action.focusOverlay),
                    },
                  });
                  if (action.focusOverlay && this.overlay.wasUsedRecently) {
                    this.overlay.assertOverlayActive();
                  }
                })
                .catch(() => {});

              pressKeysToCopyItemText(
                entry.keepModKeys
                  ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
                  : undefined,
                this.gameConfig.showModsKey,
              );
            }
          } else if (
            entry.action.type === "ocr-text" &&
            entry.action.target === "heist-gems"
          ) {
            if (process.platform !== "win32") return;

            const { action } = entry;
            const pressTime = Date.now();
            const imageData = this.poeWindow.screenshot();
            this.ocrWorker
              .findHeistGems({
                width: this.poeWindow.bounds.width,
                height: this.poeWindow.bounds.height,
                data: imageData,
              })
              .then((result) => {
                this.server.sendEventTo("last-active", {
                  name: "MAIN->CLIENT::ocr-text",
                  payload: {
                    target: action.target,
                    pressTime,
                    ocrTime: result.elapsed,
                    paragraphs: result.recognized.map((p) => p.text),
                  },
                });
              })
              .catch(() => {});
          }
        },
      );

      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    for (const entry of this.actions) {
      globalShortcut.unregister(shortcutToElectron(entry.shortcut));
    }
  }
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "down");
  }

  // finally press `C` to copy text
  uIOhook.keyTap(UiohookKey.C);

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      uIOhook.keyToggle(UiohookKey[key as UiohookKeyT], "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}
