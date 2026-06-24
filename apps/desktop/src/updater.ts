/*
Copyright 2016-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, autoUpdater, ipcMain } from "electron";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSquirrelExecutable } from "./squirrelhooks.js";
import { _t } from "./language-helper.js";
import { initialisePromise } from "./ipc.js";
import { getBrand } from "./config.js";

const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_UPDATE_DELAY_MS = 30 * 1000;

function installUpdate(): void {
    // for some reason, quitAndInstall does not fire the
    // before-quit event, so we need to set the flag here.
    global.appQuitting = true;
    autoUpdater.quitAndInstall();
}

// Workaround for Squirrel.Mac wedging auto-restart if latest check for update failed
// From https://github.com/vector-im/element-web/issues/12433#issuecomment-1508995119
async function safeCheckForUpdate(): Promise<void> {
    if (process.platform === "darwin") {
        const feedUrl = autoUpdater.getFeedURL();
        // On Mac if the user has already downloaded an update but not installed it and
        // we check again and no additional new update is available the app ends up in a
        // bad state and doesn't restart after installing any updates that are downloaded.
        // To avoid this we check manually whether an update is available and call the
        // autoUpdater.checkForUpdates() when something new is there.
        try {
            const res = await fetch(feedUrl);
            const { currentRelease } = (await res.json()) as { currentRelease: string };
            const latestVersionDownloaded = latestUpdateDownloaded?.releaseName;
            console.info(
                `Latest version from release download: ${currentRelease} (current: ${app.getVersion()}, most recent downloaded ${latestVersionDownloaded}})`,
            );
            if (currentRelease === app.getVersion() || currentRelease === latestVersionDownloaded) {
                ipcChannelSendUpdateStatus(false);
                return;
            }
        } catch (err) {
            console.error(`Error checking for updates ${feedUrl}`, err);
            ipcChannelSendUpdateStatus(false);
            return;
        }
    }
    autoUpdater.checkForUpdates();
}

async function pollForUpdates(): Promise<void> {
    try {
        // If we've already got a new update downloaded, then stop trying to check for new ones, as according to the doc
        // at https://github.com/electron/electron/blob/main/docs/api/auto-updater.md#autoupdatercheckforupdates
        // we'll just keep re-downloading the same update.
        // As a hunch, this might also be causing https://github.com/vector-im/element-web/issues/12433
        // due to the update checks colliding with the pending install somehow
        if (!latestUpdateDownloaded) {
            await safeCheckForUpdate();
        } else {
            console.log("Skipping update check as download already present");
            global.mainWindow?.webContents.send("update-downloaded", latestUpdateDownloaded);
        }
    } catch (e) {
        console.log("Couldn't check for update", e);
    }
}

export async function start(updateBaseUrl: string): Promise<void> {
    if (!(await available())) return;
    console.log(`Starting auto update with base URL: ${updateBaseUrl}`);
    if (!updateBaseUrl.endsWith("/")) {
        updateBaseUrl = updateBaseUrl + "/";
    }

    try {
        let url: string;
        let serverType: "json" | undefined;

        if (process.platform === "darwin") {
            // On macOS it takes a JSON file with a map between versions and their URLs
            url = `${updateBaseUrl}macos/releases.json`;
            serverType = "json";
        } else if (process.platform === "win32") {
            // On windows it takes a base path and looks for files under that path.
            url = `${updateBaseUrl}win32/${process.arch}/`;
        } else {
            // Squirrel / electron only supports auto-update on these two platforms.
            // I'm not even going to try to guess which feed style they'd use if they
            // implemented it on Linux, or if it would be different again.
            return;
        }

        if (url) {
            console.log(`Update URL: ${url}`);
            autoUpdater.setFeedURL({ url, serverType });
            // We check for updates ourselves rather than using 'updater' because we need to
            // do it in the main process (and we don't really need to check every 10 minutes:
            // every hour should be just fine for a desktop app)
            // However, we still let the main window listen for the update events.
            // We also wait a short time before checking for updates the first time because
            // of squirrel on windows and it taking a small amount of time to release a
            // lock file.
            setTimeout(pollForUpdates, INITIAL_UPDATE_DELAY_MS);
            setInterval(pollForUpdates, UPDATE_POLL_INTERVAL_MS);
        }
    } catch (err) {
        // will fail if running in debug mode
        console.log("Couldn't enable update checking", err);
    }
}

/**
 * On macOS Squirrel.Mac installs an update by atomically renaming a freshly-staged `.app` bundle over
 * the existing one. That swap needs write access to the directory that *contains* the bundle (it is a
 * rename within that directory), not to the old bundle's own inode. If an administrator installed the
 * app into `/Applications` but it is then run by an unprivileged user, that containing directory is not
 * writable and auto-update silently fails (#32404). Detect that case so the caller can warn the user
 * instead of repeatedly downloading updates that can never be installed.
 * @returns True if the install location appears writable (or the check is not applicable).
 */
export async function isUpdateableLocation(): Promise<boolean> {
    // Only macOS suffers the read-only-/Applications problem; Windows Squirrel installs per-user and
    // Linux has no auto-update, so don't second-guess those.
    if (process.platform !== "darwin") return true;

    // app.getPath("exe") => /Applications/Element.app/Contents/MacOS/Element
    // The bundle is three levels up; Squirrel renames the new bundle over it, so the directory that
    // contains the bundle is the load-bearing thing that must be writable.
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    const bundleParent = path.dirname(bundlePath);

    try {
        await fs.access(bundleParent, fsConstants.W_OK);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // A permission / read-only-filesystem error means Squirrel can't replace the bundle.
        if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
            return false;
        }
        // Anything else (e.g. ENOENT when running unpackaged in development) isn't a permission
        // problem, so fail open rather than disabling updates on a detection glitch.
        return true;
    }
}

/**
 * Check if auto update is available on this platform.
 * Has a side effect of firing showToast on EOL platforms and non-writable installs so must only be
 * called once!
 * @returns True if auto update is available
 */
export async function available(): Promise<boolean> {
    if (process.platform === "linux") {
        // Auto update is not supported on Linux
        console.warn("Auto update not supported on this platform");
        return false;
    }

    if (process.platform === "win32") {
        try {
            await fs.access(getSquirrelExecutable());
        } catch {
            console.warn("Squirrel not found, auto update not supported");
            return false;
        }
    }

    // Otherwise we're either on macOS or Windows with Squirrel
    if (process.platform === "darwin") {
        // OS release returns the Darwin kernel version, not the macOS version, see
        // https://en.wikipedia.org/wiki/Darwin_(operating_system)#Release_history to interpret it
        const release = os.release();
        const major = parseInt(release.split(".")[0], 10);

        if (major < 21) {
            // If the macOS version is too old for modern Electron support then disable auto update to prevent the app updating and bricking itself.
            // The oldest macOS version supported by Chromium/Electron 38 is Monterey (12.x) which started with Darwin 21.0
            initialisePromise.then(() => {
                ipcMain.emit("showToast", {
                    title: _t("eol|title"),
                    description: _t("eol|no_more_updates", { brand: getBrand() }),
                });
            });
            console.warn("Auto update not supported, macOS version too old");
            return false;
        } else if (major < 22) {
            // If the macOS version is EOL then show a warning message.
            // The oldest macOS version still supported by Apple is Ventura (13.x) which started with Darwin 22.0
            initialisePromise.then(() => {
                ipcMain.emit("showToast", {
                    title: _t("eol|title"),
                    description: _t("eol|warning", { brand: getBrand() }),
                });
            });
        }

        // If the app lives in a location the current user can't write to (e.g. installed into
        // /Applications by an admin, then run unprivileged), Squirrel.Mac can never install an update.
        // Warn the user with actionable guidance and disable auto-update rather than silently failing
        // and re-downloading the same update forever. (#32404)
        if (!(await isUpdateableLocation())) {
            initialisePromise.then(() => {
                ipcMain.emit("showToast", {
                    title: _t("updater|not_writable_title"),
                    description: _t("updater|not_writable_description", { brand: getBrand() }),
                });
            });
            console.warn("Auto update not supported, app is installed in a non-writable location");
            return false;
        }
    }

    return true;
}

ipcMain.on("install_update", installUpdate);
ipcMain.on("check_updates", pollForUpdates);

function ipcChannelSendUpdateStatus(status: boolean | string): void {
    global.mainWindow?.webContents.send("check_updates", status);
}

interface ICachedUpdate {
    releaseNotes: string;
    releaseName: string;
    releaseDate: Date;
    updateURL: string;
}

// cache the latest update which has been downloaded as electron offers no api to read it
let latestUpdateDownloaded: ICachedUpdate | undefined;
autoUpdater
    .on("update-available", function () {
        ipcChannelSendUpdateStatus(true);
    })
    .on("update-not-available", function () {
        if (latestUpdateDownloaded) {
            // the only time we will get `update-not-available` if `latestUpdateDownloaded` is already set
            // is if the user used the Manual Update check and there is no update newer than the one we
            // have downloaded, so show it to them as the latest again.
            global.mainWindow?.webContents.send("update-downloaded", latestUpdateDownloaded);
        } else {
            ipcChannelSendUpdateStatus(false);
        }
    })
    .on("error", function (error) {
        ipcChannelSendUpdateStatus(error.message);
    });

autoUpdater.on("update-downloaded", (ev, releaseNotes, releaseName, releaseDate, updateURL) => {
    // forward to renderer
    latestUpdateDownloaded = { releaseNotes, releaseName, releaseDate, updateURL };
    global.mainWindow?.webContents.send("update-downloaded", latestUpdateDownloaded);
});
