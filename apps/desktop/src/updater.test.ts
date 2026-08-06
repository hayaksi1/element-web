/*
Copyright 2026 New Vector Ltd.
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import { app, autoUpdater, ipcMain } from "electron";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";

import { isUpdateableLocation, available, start } from "./updater.js";
import { _t } from "./language-helper.js";
import Store from "./store.js";

vi.mock("electron", () => ({
    app: {
        getPath: vi.fn(() => "/Applications/Element.app/Contents/MacOS/Element"),
        getVersion: vi.fn(() => "1.0.0"),
    },
    // autoUpdater registers listeners at import time; the chained `.on()` calls must return `this`.
    autoUpdater: {
        on: vi.fn().mockReturnThis(),
        setFeedURL: vi.fn(),
        getFeedURL: vi.fn(() => "https://feed.example/macos/releases.json"),
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
    },
    ipcMain: {
        on: vi.fn(),
        emit: vi.fn(),
    },
}));

vi.mock("node:fs/promises", () => {
    const access = vi.fn(() => Promise.resolve());
    return { default: { access }, access };
});

vi.mock("node:os", () => {
    const release = vi.fn(() => "23.0.0"); // Darwin 23 = macOS Sonoma (modern, auto-update supported)
    return { default: { release }, release };
});

vi.mock("./squirrelhooks.js", () => ({
    getSquirrelExecutable: vi.fn(() => "/path/to/Update.exe"),
}));

vi.mock("./language-helper.js", () => ({
    _t: vi.fn((key: string) => key),
}));

vi.mock("./ipc.js", () => ({
    initialisePromise: Promise.resolve(),
}));

vi.mock("./config.js", () => ({
    getConfig: vi.fn(() => ({ brand: "Element" })),
}));

vi.mock("./store.js", () => {
    const instance = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    return { default: { instance } };
});

const getPath = vi.mocked(app.getPath);
const getVersion = vi.mocked(app.getVersion);
const access = vi.mocked(fs.access);
const release = vi.mocked(os.release);
const emit = vi.mocked(ipcMain.emit);
const translate = vi.mocked(_t);
const setFeedURL = vi.mocked(autoUpdater.setFeedURL);
const storeGet = vi.mocked(Store.instance!.get);
const storeSet = vi.mocked(Store.instance!.set);
const storeDelete = vi.mocked(Store.instance!.delete);

type Listener = (...args: unknown[]) => void;

// The module registers its IPC and autoUpdater listeners once, at import time. Snapshot them here,
// while the recorded calls still exist — `clearAllMocks` in `beforeEach` would otherwise discard them.
const ipcListeners = new Map(vi.mocked(ipcMain.on).mock.calls as unknown as [string, Listener][]);
const updaterListeners = new Map(vi.mocked(autoUpdater.on).mock.calls as unknown as [string, Listener][]);

function ipcHandler(channel: string): Listener {
    const handler = ipcListeners.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler;
}

/** Stub the store as if `pendingUpdateVersion`/`failedUpdateInstalls` held these values. */
function givenStore(values: { pendingUpdateVersion?: string; failedUpdateInstalls?: number }): void {
    storeGet.mockImplementation((key: string) => values[key as keyof typeof values]);
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function errnoError(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

let setIntervalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    getPath.mockReturnValue("/Applications/Element.app/Contents/MacOS/Element");
    getVersion.mockReturnValue("1.0.0");
    access.mockResolvedValue(undefined);
    release.mockReturnValue("23.0.0");
    givenStore({});
    setPlatform("darwin");
    // Asserting on the interval registration keeps these tests off the network: the poll itself
    // fetches the release feed, which is not what is under test here.
    setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(0 as unknown as NodeJS.Timeout);
    vi.spyOn(global, "setTimeout").mockReturnValue(0 as unknown as NodeJS.Timeout);
});

afterEach(() => {
    setPlatform(originalPlatform);
    // Only the `setInterval`/`setTimeout` spies need undoing; the module mocks above are re-stubbed by
    // `beforeEach`, so restoring them here is harmless.
    vi.restoreAllMocks();
});

describe("isUpdateableLocation", () => {
    it("returns true off macOS without touching the filesystem", async () => {
        setPlatform("win32");

        await expect(isUpdateableLocation()).resolves.toBe(true);
        expect(access).not.toHaveBeenCalled();
    });

    it("checks the directory containing the .app bundle for WRITE access on macOS", async () => {
        await expect(isUpdateableLocation()).resolves.toBe(true);

        // /Applications/Element.app/Contents/MacOS/Element -> containing dir /Applications.
        // The mode must be W_OK specifically — F_OK (existence) would re-break #32404.
        expect(access).toHaveBeenCalledWith("/Applications", fsConstants.W_OK);
    });

    it("does not gate on the bundle's own writability, only its containing directory", async () => {
        // Squirrel.Mac renames a new bundle over the old one, which needs write on the parent dir,
        // not on the (possibly admin-owned, read-only) bundle inode. Gating on the bundle would
        // wrongly disable updates for an admin-owned bundle in a user-writable folder.
        await expect(isUpdateableLocation()).resolves.toBe(true);

        expect(access).toHaveBeenCalledTimes(1);
        expect(access).not.toHaveBeenCalledWith("/Applications/Element.app", expect.anything());
    });

    it("returns false when the install location is not writable (EACCES)", async () => {
        access.mockRejectedValue(errnoError("EACCES"));

        await expect(isUpdateableLocation()).resolves.toBe(false);
    });

    it("returns false on a read-only filesystem (EROFS) or insufficient privilege (EPERM)", async () => {
        access.mockRejectedValueOnce(errnoError("EROFS"));
        await expect(isUpdateableLocation()).resolves.toBe(false);

        access.mockRejectedValueOnce(errnoError("EPERM"));
        await expect(isUpdateableLocation()).resolves.toBe(false);
    });

    it("fails open (returns true) when the path cannot be resolved (ENOENT, e.g. unpackaged dev run)", async () => {
        access.mockRejectedValue(errnoError("ENOENT"));

        await expect(isUpdateableLocation()).resolves.toBe(true);
    });
});

describe("available", () => {
    it("disables auto-update and shows guidance when installed in a non-writable location", async () => {
        access.mockRejectedValue(errnoError("EACCES"));

        await expect(available()).resolves.toBe(false);

        await Promise.resolve(); // let the initialisePromise.then microtask run
        expect(emit).toHaveBeenCalledWith(
            "showToast",
            expect.objectContaining({
                title: "updater|not_writable_title",
                description: "updater|not_writable_description",
            }),
        );
        // The description interpolates the brand, so the substitution arg must reach _t.
        expect(translate).toHaveBeenCalledWith("updater|not_writable_description", { brand: "Element" });
    });

    it("stays available and shows no guidance toast when the location is writable", async () => {
        await expect(available()).resolves.toBe(true);

        await Promise.resolve();
        expect(emit).not.toHaveBeenCalledWith("showToast", expect.anything());
    });
});

describe("start", () => {
    it("schedules automatic update checks when no install has failed", async () => {
        await start("https://feed.example/");

        expect(setFeedURL).toHaveBeenCalled();
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("stops checking automatically once installs have repeatedly failed", async () => {
        givenStore({ failedUpdateInstalls: 2 });

        await start("https://feed.example/");

        // The whole point of #32404: don't re-download the same update on every launch forever.
        expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("still sets the feed URL when paused, so a manual check can recover", async () => {
        givenStore({ failedUpdateInstalls: 2 });

        await start("https://feed.example/");

        // Without a feed URL the user would be permanently stuck with no way to retry.
        expect(setFeedURL).toHaveBeenCalled();
    });

    it("keeps checking after a single failure", async () => {
        givenStore({ failedUpdateInstalls: 1 });

        await start("https://feed.example/");

        // One failure is not proof of an unfixable install: the user may simply have dismissed the
        // macOS authorization prompt that Squirrel.Mac shows for a privileged install.
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("counts an update that did not take effect as a failed install", async () => {
        givenStore({ pendingUpdateVersion: "1.1.0", failedUpdateInstalls: 0 });
        getVersion.mockReturnValue("1.0.0"); // we asked for 1.1.0 but came back as 1.0.0

        await start("https://feed.example/");

        expect(storeSet).toHaveBeenCalledWith("failedUpdateInstalls", 1);
        expect(storeDelete).toHaveBeenCalledWith("pendingUpdateVersion");
    });

    it("clears the failure count when the update did take effect", async () => {
        givenStore({ pendingUpdateVersion: "1.0.0", failedUpdateInstalls: 1 });
        getVersion.mockReturnValue("1.0.0"); // we came back as the version we asked for

        await start("https://feed.example/");

        expect(storeSet).toHaveBeenCalledWith("failedUpdateInstalls", 0);
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("does not count a downloaded-but-never-installed update as a failure", async () => {
        // No pendingUpdateVersion means the user never triggered an install, so there is nothing to
        // reconcile — recording it at download time instead would misread this as a failure.
        givenStore({ failedUpdateInstalls: 0 });

        await start("https://feed.example/");

        expect(storeSet).not.toHaveBeenCalled();
        expect(setIntervalSpy).toHaveBeenCalled();
    });

    it("pauses on the second consecutive failure", async () => {
        givenStore({ pendingUpdateVersion: "1.1.0", failedUpdateInstalls: 1 });
        getVersion.mockReturnValue("1.0.0");

        await start("https://feed.example/");

        expect(storeSet).toHaveBeenCalledWith("failedUpdateInstalls", 2);
        expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it("uses the plain Squirrel feed on Windows", async () => {
        setPlatform("win32");

        await start("https://feed.example/");

        // Windows has no `serverType`, and the install-location probe is macOS-only.
        expect(setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ serverType: undefined }));
    });
});

describe("install_update", () => {
    it("records the version handed to the updater so the next launch can verify it", () => {
        // Simulate an update having been downloaded, then the user choosing to install it.
        updaterListeners.get("update-downloaded")?.({}, "release notes", "1.1.0", new Date(), "https://example/update");

        ipcHandler("install_update")();

        expect(storeSet).toHaveBeenCalledWith("pendingUpdateVersion", "1.1.0");
        expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
    });
});

describe("check_updates", () => {
    it("clears the failure count so an explicit request always retries", () => {
        givenStore({ failedUpdateInstalls: 2 });

        ipcHandler("check_updates")();

        expect(storeSet).toHaveBeenCalledWith("failedUpdateInstalls", 0);
    });
});
