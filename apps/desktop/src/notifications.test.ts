/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, vi, beforeEach, afterEach } from "vitest";
import { ipcMain, nativeImage, Notification } from "electron";

import { access, copyFile } from "node:fs/promises";
import path from "node:path";

import { closeNotification, showNotification, type ShowNotificationRequest } from "./notifications.js";
import type * as Notifications from "./notifications.js";

const listeners = new Map<string, (...args: any[]) => void>();
const showMock = vi.fn();
const closeMock = vi.fn();

vi.mock("electron", () => ({
    ipcMain: { on: vi.fn() },
    nativeImage: { createFromBuffer: vi.fn() },
    Notification: Object.assign(
        vi.fn(function (this: any, options: any) {
            this.options = options;
            this.on = (event: string, cb: (...args: any[]) => void): void => {
                listeners.set(event, cb);
            };
            this.show = showMock;
            this.close = closeMock;
        }),
        { isSupported: vi.fn(() => true) },
    ),
}));

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), copyFile: vi.fn(), access: vi.fn() }));

// electron sets this at runtime; path.join() would throw on undefined before reaching copyFile.
Object.defineProperty(process, "resourcesPath", { value: "/Applications/Element.app/Contents/Resources" });

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Re-imports the module so its once-per-run sound install runs again against the current mocks. */
const freshModule = async (): Promise<typeof Notifications> => {
    vi.resetModules();
    return import("./notifications.js");
};

const send = vi.fn();
const fetchMock = vi.fn();

const commandHandler = vi.mocked(ipcMain.on).mock.calls.find(([channel]) => channel === "notification")?.[1];

const makeRequest = (overrides: Partial<ShowNotificationRequest> = {}): ShowNotificationRequest => ({
    id: 1,
    title: "title",
    body: "body",
    avatarUrl: null,
    audible: true,
    ...overrides,
});

const constructedOptions = (): any => vi.mocked(Notification).mock.calls.at(-1)?.[0];

const sentEvents = (): any[] => send.mock.calls.filter(([channel]) => channel === "notificationEvent").map((c) => c[1]);

describe("notifications", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listeners.clear();
        vi.mocked(Notification.isSupported).mockReturnValue(true);
        global.mainWindow = {
            webContents: { send, session: { fetch: fetchMock } },
        } as unknown as Electron.BrowserWindow;
    });

    afterEach(() => {
        global.mainWindow = null;
        setPlatform(originalPlatform);
    });

    it("registers a handler on the notification channel", () => {
        expect(commandHandler).toBeDefined();
    });

    it("installs the sound in ~/Library/Sounds and names it on an audible notification", async () => {
        setPlatform("darwin");
        vi.mocked(access).mockRejectedValueOnce(new Error("not installed"));
        const { showNotification: freshShow } = await freshModule();

        await freshShow(makeRequest({ audible: true }));

        expect(copyFile).toHaveBeenCalledWith(
            expect.stringContaining("Element.aiff"),
            expect.stringContaining(path.join("Library", "Sounds", "Element.aiff")),
        );
        expect(constructedOptions()).toEqual(
            expect.objectContaining({ title: "title", body: "body", silent: false, sound: "Element" }),
        );
        expect(showMock).toHaveBeenCalled();
    });

    it("leaves the sound to the OS when it cannot be installed", async () => {
        setPlatform("darwin");
        vi.mocked(access).mockRejectedValueOnce(new Error("not installed"));
        vi.mocked(copyFile).mockRejectedValueOnce(new Error("read-only"));
        const { showNotification: freshShow } = await freshModule();

        await freshShow(makeRequest({ audible: true }));

        expect(constructedOptions()).toEqual(expect.objectContaining({ silent: false }));
        expect(constructedOptions().sound).toBeUndefined();
    });

    it("names no sound away from macOS, where ~/Library/Sounds means nothing", async () => {
        setPlatform("linux");
        vi.mocked(access).mockRejectedValueOnce(new Error("not installed"));
        const { showNotification: freshShow } = await freshModule();

        await freshShow(makeRequest({ audible: true }));

        expect(copyFile).not.toHaveBeenCalled();
        expect(constructedOptions()).toEqual(expect.objectContaining({ silent: false }));
        expect(constructedOptions().sound).toBeUndefined();
    });

    it("keeps the notification silent when the renderer sounds it", async () => {
        await showNotification(makeRequest({ audible: false }));

        expect(constructedOptions()).toEqual(expect.objectContaining({ silent: true }));
        expect(constructedOptions().sound).toBeUndefined();
    });

    it("does nothing when the OS does not support notifications", async () => {
        vi.mocked(Notification.isSupported).mockReturnValue(false);

        await showNotification(makeRequest());

        expect(Notification).not.toHaveBeenCalled();
        expect(showMock).not.toHaveBeenCalled();
    });

    it("reports a click to the renderer", async () => {
        await showNotification(makeRequest({ id: 7 }));

        listeners.get("click")!();

        expect(sentEvents()).toContainEqual({ id: 7, action: "click" });
    });

    it("keeps the notification after a click so it can still be closed", async () => {
        await showNotification(makeRequest({ id: 7 }));
        listeners.get("click")!();

        closeNotification(7);

        expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it("reports a close to the renderer exactly once", async () => {
        await showNotification(makeRequest({ id: 7 }));

        listeners.get("close")!();
        listeners.get("close")!();

        expect(sentEvents().filter((e) => e.action === "close")).toEqual([{ id: 7, action: "close" }]);
    });

    it("does not echo a close the renderer asked for", async () => {
        await showNotification(makeRequest({ id: 7 }));

        closeNotification(7);
        listeners.get("close")!();

        expect(sentEvents().filter((e) => e.action === "close")).toEqual([]);
    });

    it("closes a notification only once", async () => {
        await showNotification(makeRequest({ id: 7 }));

        closeNotification(7);
        closeNotification(7);

        expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it("reports a synthetic close to the renderer when the OS refuses the notification", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await showNotification(makeRequest({ id: 7 }));

        listeners.get("failed")!(new Event("failed"), "UNErrorDomain Code=1");

        expect(sentEvents()).toContainEqual({ id: 7, action: "close" });
        expect(error).toHaveBeenCalledWith(expect.stringContaining("UNErrorDomain Code=1"));
        error.mockRestore();
    });

    it("attaches the avatar fetched through the window session", async () => {
        const icon = { isEmpty: () => false };
        fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
        vi.mocked(nativeImage.createFromBuffer).mockReturnValue(icon as any);

        await showNotification(makeRequest({ avatarUrl: "https://server/avatar.png" }));

        expect(fetchMock).toHaveBeenCalledWith("https://server/avatar.png");
        expect(constructedOptions().icon).toBe(icon);
    });

    it("still shows the notification when the avatar cannot be fetched", async () => {
        fetchMock.mockRejectedValue(new Error("nope"));
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        await showNotification(makeRequest({ avatarUrl: "https://server/avatar.png" }));

        expect(constructedOptions().icon).toBeUndefined();
        expect(showMock).toHaveBeenCalled();
        error.mockRestore();
    });

    it("abandons a notification closed while its avatar was still loading", async () => {
        let release: (value: unknown) => void = () => {};
        fetchMock.mockReturnValue(new Promise((resolve) => (release = resolve)));

        const pending = showNotification(makeRequest({ id: 7, avatarUrl: "https://server/avatar.png" }));
        closeNotification(7);
        release({ ok: false });
        await pending;

        expect(Notification).not.toHaveBeenCalled();
        expect(showMock).not.toHaveBeenCalled();
    });

    it("does not throw when there is no window to report to", async () => {
        await showNotification(makeRequest({ id: 7 }));
        global.mainWindow = null;

        expect(() => listeners.get("click")!()).not.toThrow();
    });

    it("evicts the oldest notification once the registry is full", async () => {
        for (let id = 1; id <= 65; id++) {
            await showNotification(makeRequest({ id }));
        }

        expect(sentEvents()).toContainEqual({ id: 1, action: "close" });
    });

    it("shows and closes in response to renderer commands", async () => {
        const handler = commandHandler!;

        handler({} as any, { action: "show", request: makeRequest({ id: 9 }) });
        await vi.waitFor(() => expect(showMock).toHaveBeenCalled());

        handler({} as any, { action: "close", id: 9 });
        expect(closeMock).toHaveBeenCalled();
    });
});
