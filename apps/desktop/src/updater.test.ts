/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import { app, ipcMain } from "electron";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";

import { isUpdateableLocation, available } from "./updater.js";
import { _t } from "./language-helper.js";

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

const getPath = vi.mocked(app.getPath);
const access = vi.mocked(fs.access);
const release = vi.mocked(os.release);
const emit = vi.mocked(ipcMain.emit);
const translate = vi.mocked(_t);

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function errnoError(code: string): NodeJS.ErrnoException {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

beforeEach(() => {
    vi.clearAllMocks();
    getPath.mockReturnValue("/Applications/Element.app/Contents/MacOS/Element");
    access.mockResolvedValue(undefined);
    release.mockReturnValue("23.0.0");
    setPlatform("darwin");
});

afterEach(() => {
    setPlatform(originalPlatform);
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
