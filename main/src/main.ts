"use strict";

import { app, systemPreferences } from "electron";
import { uIOhook } from "uiohook-napi";
import os from "node:os";
import { startServer, eventPipe, server } from "./server";
import { Logger } from "./RemoteLogger";
import { GameWindow } from "./windowing/GameWindow";
import { OverlayWindow } from "./windowing/OverlayWindow";
import { GameConfig } from "./host-files/GameConfig";
import { Shortcuts } from "./shortcuts/Shortcuts";
import { AppUpdater } from "./AppUpdater";
import { AppTray } from "./AppTray";
import { OverlayVisibility } from "./windowing/OverlayVisibility";
import { GameLogWatcher } from "./host-files/GameLogWatcher";
import { HttpProxy } from "./proxy";
import { installExtension, VUEJS_DEVTOOLS } from "electron-devtools-installer";

if (!app.requestSingleInstanceLock()) {
  app.exit();
}

if (process.platform !== "darwin") {
  app.disableHardwareAcceleration();
}
// Electron 39+ defaults to sandbox:true per-window.
// app.enableSandbox() is removed: it globally locks sandbox on with no
// per-window override, which breaks electron-devtools-installer (VUEJS_DEVTOOLS
// extension content-scripts), webviewTag preloads, and electron-overlay-window's
// internal calculateMacTitleBarHeight() BrowserWindow on macOS.
let tray: AppTray;

(async () => {
  if (process.platform === "darwin") {
    async function ensureAccessibilityPermission(): Promise<boolean> {
      if (systemPreferences.isTrustedAccessibilityClient(false)) return true;

      // Trigger the system prompt
      systemPreferences.isTrustedAccessibilityClient(true);

      const maxWaitTime = 15000; // 15 seconds
      const startTime = Date.now();

      return await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (systemPreferences.isTrustedAccessibilityClient(false)) {
            clearInterval(interval);
            resolve(true);
          }

          // Stop waiting if time runs out
          if (Date.now() - startTime > maxWaitTime) {
            clearInterval(interval);
            resolve(false);
          }
        }, 1000);
      });
    }
    const hasPermission = await ensureAccessibilityPermission();
    if (!hasPermission) {
      console.warn("Accessibility permission not granted, exiting");
      app.quit();
      return;
    }
    console.log("Accessibility permission granted, starting app");
  }

  app.on("ready", async () => {
    tray = new AppTray(eventPipe);
    const logger = new Logger(eventPipe);
    const gameLogWatcher = new GameLogWatcher(eventPipe, logger);
    const gameConfig = new GameConfig(eventPipe, logger);
    const poeWindow = new GameWindow();
    const appUpdater = new AppUpdater(eventPipe);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _httpProxy = new HttpProxy(server, logger);

    if (process.env.VITE_DEV_SERVER_URL) {
      try {
        await installExtension(VUEJS_DEVTOOLS);
        logger.write("info Vue Devtools installed");
      } catch (error) {
        logger.write(`error installing Vue Devtools: ${error}`);
        console.log(`error installing Vue Devtools: ${error}`);
      }
    }
    process.addListener("uncaughtException", (err) => {
      logger.write(`error [uncaughtException] ${err.message}, ${err.stack}`);
    });
    process.addListener("unhandledRejection", (reason) => {
      logger.write(`error [unhandledRejection] ${(reason as Error).stack}`);
    });

    setTimeout(
      async () => {
        const overlay = new OverlayWindow(eventPipe, logger, poeWindow);
        // eslint-disable-next-line no-new
        new OverlayVisibility(eventPipe, overlay, gameConfig);
        const shortcuts = await Shortcuts.create(
          logger,
          overlay,
          poeWindow,
          gameConfig,
          eventPipe,
        );
        eventPipe.onEventAnyClient(
          "CLIENT->MAIN::update-host-config",
          (cfg) => {
            // Don't overwrite GFN windowTitle with renderer's default "Path of Exile 2"
            if (!shortcuts.isGfnMode) {
              overlay.updateOpts(cfg.overlayKey, cfg.windowTitle);
              shortcuts.isGfnMode = /geforce|nvidia/i.test(cfg.windowTitle);
            }
            shortcuts.updateActions(
              cfg.shortcuts,
              cfg.stashScroll,
              cfg.logKeys,
              cfg.restoreClipboard,
              cfg.language,
            );
            gameLogWatcher.restart(cfg.clientLog ?? "", cfg.readClientLog);
            gameConfig.readConfig(cfg.gameConfig ?? "");
            appUpdater.checkAtStartup();
            tray.overlayKey = cfg.overlayKey;
          },
        );
        uIOhook.start();
        console.log("uIOhook started");

        // Early GFN detection from saved config or env
        {
          let gfnTitle: string | null = null;
          try {
            const fs = require("fs");
            const cfgPath = require("path").join(
              app.getPath("userData"), "apt-data", "config.json",
            );
            if (fs.existsSync(cfgPath)) {
              const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
              if (/geforce|nvidia/i.test(cfg.windowTitle ?? "")) {
                gfnTitle = cfg.windowTitle;
              }
            }
          } catch {}

          // TODO: remove dev hardcode — in production, saved config.json will have the title
          if (!gfnTitle && process.env.VITE_DEV_SERVER_URL) {
            gfnTitle = "NVIDIA GeForce NOW";
          }

          if (gfnTitle) {
            console.log(`[GFN] Detected GFN mode: "${gfnTitle}"`);
            shortcuts.isGfnMode = true;
            // This triggers attach() → startGfnPolling() → isActive management
            overlay.updateOpts("Shift + Space", gfnTitle);
            // Pre-load default shortcuts so they're ready when GFN focus is detected
            shortcuts.updateActions(
              [
                {
                  shortcut: "Alt + D",
                  action: { type: "copy-item", target: "price-check", focusOverlay: true },
                },
                {
                  shortcut: "Shift + Space",
                  action: { type: "toggle-overlay" },
                },
              ],
              false, true, false, "en",
            );
          }
        }

        const port = await startServer(appUpdater, logger);
        // TODO: move up (currently crashes)
        logger.write(`info ${os.type()} ${os.release} / v${app.getVersion()}`);
        overlay.loadAppPage(port);
        tray.serverPort = port;
      },
      // fixes(linux): window is black instead of transparent
      process.platform === "linux" ? 1000 : 0,
    );
  });
})();
