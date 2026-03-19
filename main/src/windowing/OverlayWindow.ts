import path from "path";
import { BrowserWindow, dialog, shell, Menu } from "electron";
import { execFile } from "child_process";
import {
  OverlayController,
  OVERLAY_WINDOW_OPTS,
} from "electron-overlay-window";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";

export class OverlayWindow {
  public isInteractable = false;
  public wasUsedRecently = true;
  private window?: BrowserWindow;
  private overlayKey: string = "Shift + Space";
  private isOverlayKeyUsed = false;
  private appUrl = "";
  private _windowTitle = "";
  private _gfnOverlayShownAt = 0;

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient(
      "OVERLAY->MAIN::focus-game",
      () => {
        // GFN: overlay is only closed via keyboard (Escape/toggle), not renderer events
        if (!this.isGfnMode) this.assertGameActive();
      },
    );
    this.poeWindow.on("active-change", this.handlePoeWindowActiveChange);
    this.poeWindow.onAttach(this.handleOverlayAttached);

    this.server.onEventAnyClient("CLIENT->MAIN::used-recently", (e) => {
      this.wasUsedRecently = e.isOverlay;
    });

    if (process.argv.includes("--no-overlay")) return;

    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      ...OVERLAY_WINDOW_OPTS,
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    // Forward renderer console to main process stdout for debugging
    this.window.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2 || /parse|error|item/i.test(message)) {
        console.log(`[RENDERER] ${message}`);
      }
    });

    this.window.webContents.on("before-input-event", this.handleExtraCommands);
    this.window.webContents.on(
      "did-attach-webview",
      (_, webviewWebContents) => {
        webviewWebContents.on("before-input-event", this.handleExtraCommands);
      },
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });
  }

  loadAppPage(port: number) {
    this.appUrl =
      process.env.VITE_DEV_SERVER_URL || `http://localhost:${port}/index.html`;

    if (!this.window) {
      shell.openExternal(this.appUrl);
      return;
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(this.appUrl);
      this.window.webContents.openDevTools({ mode: "detach", activate: false });
    } else {
      this.window.loadURL(this.appUrl);
    }
  }

  /**
   * Pre-create the GFN overlay window (hidden).
   * Must be called early so the window is already on all workspaces
   * when we need to show it — avoids macOS Space-switch.
   */
  /**
   * Show GFN overlay — reuse the existing overlay window but force-show it
   * as always-on-top on the current Space (works with fullscreen GFN).
   */
  /**
   * Show overlay for GFN price check — just use normal assertOverlayActive.
   */
  showGfnOverlay(_position: { x: number; y: number }) {
    this.assertOverlayActive();
  }

  assertOverlayActive = () => {
    console.log(`[GFN] assertOverlayActive: interactable=${this.isInteractable}, gfn=${this.isGfnMode}, hasWindow=${!!this.window}`);
    if (!this.isInteractable) {
      this.isInteractable = true;
      if (this.isGfnMode && this.window) {
        // GFN: show window directly (OverlayController not attached)
        // First tell renderer overlay is ready (enables widgets)
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::overlay-attached",
          payload: undefined,
        });
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::focus-change",
          payload: { game: false, overlay: true, usingHotkey: true },
        });
        this.window.showInactive();
        this.window.moveTop();
        this.window.setAlwaysOnTop(true, "screen-saver");
        this.window.focus();
        this._gfnOverlayShownAt = Date.now();
        console.log("[GFN] Overlay shown: visible=" + this.window.isVisible() + " bounds=" + JSON.stringify(this.window.getBounds()));
      } else {
        OverlayController.activateOverlay();
      }
      this.poeWindow.isActive = false;
    }
  };

  assertGameActive = () => {
    console.log(`[GFN] assertGameActive: interactable=${this.isInteractable}, gfn=${this.isGfnMode}`);
    if (this.isInteractable) {
      this.isInteractable = false;
      if (this.isGfnMode && this.window) {
        // GFN: hide window directly
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::focus-change",
          payload: { game: true, overlay: false, usingHotkey: true },
        });
        this.window.hide();
        // Return focus to GFN app
        execFile("osascript", [
          "-e",
          'tell application "System Events" to set frontmost of first process whose name contains "GeForce" to true',
        ]);
      } else {
        OverlayController.focusTarget();
      }
      this.poeWindow.isActive = true;
    }
  };

  private get isGfnMode() {
    return /geforce|nvidia/i.test(this._windowTitle);
  }

  toggleActiveState = () => {
    console.log(`[GFN] toggleActiveState: interactable=${this.isInteractable}`);
    this.isOverlayKeyUsed = true;
    if (this.isInteractable) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  updateOpts(overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey;
    this._windowTitle = windowTitle;
    this.poeWindow.attach(this.window, windowTitle);
  }

  private handleExtraCommands = (
    event: Electron.Event,
    input: Electron.Input,
  ) => {
    if (input.type !== "keyDown") return;

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input;

    if (code.startsWith("Key")) {
      code = code.slice("Key".length);
    } else if (code.startsWith("Digit")) {
      code = code.slice("Digit".length);
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
    else if (altKey) code = `Alt + ${code}`;
    else if (ctrlKey) code = `Ctrl + ${code}`;
    else if (shiftKey) code = `Shift + ${code}`;

    switch (code) {
      case "Escape":
      case "Ctrl + W": {
        event.preventDefault();
        process.nextTick(this.assertGameActive);
        break;
      }
      case this.overlayKey: {
        event.preventDefault();
        process.nextTick(this.toggleActiveState);
        break;
      }
    }
  };

  private handleOverlayAttached = (hasAccess?: boolean) => {
    // When attached to GFN window, enable always-on-top for fullscreen Spaces
    if (this.window) {
      this.window.setAlwaysOnTop(true, "screen-saver");
      this.window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    }

    if (hasAccess === false) {
      this.logger.write(
        "error [Overlay] PoE2 is running with administrator rights",
      );

      dialog.showErrorBox(
        "PoE2 window - No access",
        // ----------------------
        "Path of Exile 2 is running with administrator rights.\n" +
          "\n" +
          "You need to restart Exiled Exchange 2 with administrator rights.",
      );
    } else {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
    }
  };

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      if (this.isGfnMode) {
        // GFN: don't auto-hide overlay when GFN regains frontmost status.
        // The overlay is always-on-top and only hidden via toggle/assertGameActive.
        return;
      }
      this.isInteractable = false;
    }
    if (!this.isGfnMode) {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::focus-change",
        payload: {
          game: isActive,
          overlay: this.isInteractable,
          usingHotkey: this.isOverlayKeyUsed,
        },
      });
      this.isOverlayKeyUsed = false;
    }
  };
}
