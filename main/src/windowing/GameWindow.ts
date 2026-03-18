import type { BrowserWindow } from "electron";
import { app, screen } from "electron";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import { OverlayController, AttachEvent } from "electron-overlay-window";

export interface GameWindow {
  on: (event: "active-change", listener: (isActive: boolean) => void) => this;
}
export class GameWindow extends EventEmitter {
  private _isActive = false;
  private _isTracking = false;
  private _gfnPollTimer?: ReturnType<typeof setInterval>;
  private _windowTitle = "";

  get bounds() {
    // In GFN mode, OverlayController may not have real bounds
    if (this._gfnPollTimer) {
      const display = screen.getPrimaryDisplay();
      return {
        x: 0, y: 0,
        width: display.size.width,
        height: display.size.height,
      };
    }
    return OverlayController.targetBounds;
  }

  get isActive() {
    return this._isActive;
  }

  set isActive(active: boolean) {
    if (this.isActive !== active) {
      this._isActive = active;
      this.emit("active-change", this._isActive);
    }
  }

  get uiSidebarWidth() {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600;
    return Math.round(this.bounds.height * ratio);
  }

  attach(window: BrowserWindow | undefined, title: string) {
    this._windowTitle = title;

    // GFN mode on macOS: poll frontmost app instead of electron-overlay-window
    // (which can't detect fullscreen apps in other Spaces)
    if (process.platform === "darwin" && /geforce|nvidia/i.test(title)) {
      this.startGfnPolling(window);
      return;
    }

    if (!this._isTracking) {
      OverlayController.events.on("focus", () => {
        this.isActive = true;
      });
      OverlayController.events.on("blur", () => {
        this.isActive = false;
      });
      OverlayController.attachByTitle(window, title, {
        hasTitleBarOnMac: true,
      });
      this._isTracking = true;
    }
  }

  onAttach(cb: (hasAccess: boolean | undefined) => void) {
    OverlayController.events.on("attach", (e: AttachEvent) => {
      cb(e.hasAccess);
    });

    // In GFN mode, fire attach immediately
    if (this._gfnPollTimer) {
      cb(undefined);
    }
  }

  screenshot() {
    return OverlayController.screenshot();
  }

  /**
   * Poll macOS frontmost app to detect GFN window focus.
   * Works across Spaces including fullscreen apps.
   */
  private startGfnPolling(window: BrowserWindow | undefined) {
    if (this._gfnPollTimer) return;

    console.log(`[GFN] Starting frontmost app polling for "${this._windowTitle}"`);

    // REQUIRED since macOS 10.14: hide dock icon for overlay to show
    // over fullscreen apps. Without this, visibleOnFullScreen is ignored.
    app.dock.hide();

    // Setup overlay window for fullscreen Spaces
    if (window) {
      window.setAlwaysOnTop(true, "screen-saver");
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // we already hid the dock
      });
      const display = screen.getPrimaryDisplay();
      window.setBounds({
        x: 0, y: 0,
        width: display.size.width,
        height: display.size.height,
      });
    }

    // Fire initial attach
    setTimeout(() => this.emit("attach", { hasAccess: undefined }), 500);

    let lastFrontApp = "";
    this._gfnPollTimer = setInterval(() => {
      execFile("osascript", [
        "-e",
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ], { timeout: 2000 }, (err, stdout) => {
        if (err) {
          console.log("[GFN] osascript error:", err.message);
          return;
        }
        const frontApp = (stdout ?? "").trim();
        if (frontApp !== lastFrontApp) {
          lastFrontApp = frontApp;
          console.log(`[GFN] Frontmost app: "${frontApp}"`);
        }
        const isGfn = /geforce/i.test(frontApp);
        this.isActive = isGfn;
      });
    }, 1500);

    this._isTracking = true;
  }
}
