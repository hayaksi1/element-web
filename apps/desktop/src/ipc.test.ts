/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, vi } from "vitest";

interface CapturerSource {
    id: string;
    name: string;
    thumbnail: { toDataURL: () => string };
}

const { ipcHandlers, mockStore, send, randomArray, getSources, consumeDisplayMediaCallback } = vi.hoisted(() => ({
    ipcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
    mockStore: {
        isSecretUndecryptable: vi.fn<(key: string) => Promise<boolean>>(),
        setSecret: vi.fn<(key: string, secret: string) => Promise<void>>(),
        getSecret: vi.fn<(key: string) => Promise<string | undefined>>(),
        set: vi.fn<(key: string, value: unknown) => void>(),
        get: vi.fn<(key: string) => unknown>(),
    },
    send: vi.fn(),
    randomArray: vi.fn<(len: number) => Promise<string>>(),
    getSources: vi.fn<(opts: unknown) => Promise<CapturerSource[]>>(),
    consumeDisplayMediaCallback: vi.fn<() => ((streams: unknown) => void) | null>(),
}));

vi.mock("electron", () => ({
    app: { getVersion: vi.fn(() => "1.0.0") },
    autoUpdater: { getFeedURL: vi.fn() },
    desktopCapturer: { getSources },
    ipcMain: {
        on: vi.fn((channel: string, cb: (...a: unknown[]) => unknown) => {
            ipcHandlers[channel] = cb;
        }),
        once: vi.fn((channel: string, cb: (...a: unknown[]) => unknown) => {
            ipcHandlers[channel] = cb;
        }),
        handle: vi.fn((channel: string, cb: (...a: unknown[]) => unknown) => {
            ipcHandlers[channel] = cb;
        }),
    },
    powerSaveBlocker: { isStarted: vi.fn(), start: vi.fn(), stop: vi.fn() },
    TouchBar: class {},
    nativeImage: { createFromBuffer: vi.fn() },
}));

vi.mock("./store.js", () => ({
    default: { instance: mockStore },
    clearDataAndRelaunch: vi.fn(),
}));
vi.mock("./utils.js", () => ({ randomArray }));
vi.mock("./displayMediaCallback.js", () => ({ consumeDisplayMediaCallback }));

await import("./ipc.js");

const ARGS = ["@alice:example.org", "DEVICEID"];

async function callIpc(name: string, id = 1): Promise<void> {
    await ipcHandlers["ipcCall"]({}, { id, name, args: ARGS });
}

async function callIpcWithArgs(name: string, args: unknown[], id = 1): Promise<void> {
    await ipcHandlers["ipcCall"]({}, { id, name, args });
}

describe("ipc pickle key handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        randomArray.mockResolvedValue("GENERATEDKEY");
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send } };
    });

    describe("createPickleKey", () => {
        it("refuses to overwrite an existing but undecryptable pickle key", async () => {
            mockStore.isSecretUndecryptable.mockResolvedValue(true);

            await callIpc("createPickleKey", 7);

            expect(mockStore.setSecret).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith("ipcReply", { id: 7, reply: null });
        });

        it("creates and stores a new pickle key when none is present", async () => {
            mockStore.isSecretUndecryptable.mockResolvedValue(false);

            await callIpc("createPickleKey", 8);

            expect(mockStore.setSecret).toHaveBeenCalledWith("@alice:example.org|DEVICEID", "GENERATEDKEY");
            expect(send).toHaveBeenCalledWith("ipcReply", { id: 8, reply: "GENERATEDKEY" });
        });
    });

    describe("getPickleKey", () => {
        it("returns the stored pickle key", async () => {
            mockStore.getSecret.mockResolvedValue("STOREDKEY");

            await callIpc("getPickleKey", 9);

            expect(send).toHaveBeenCalledWith("ipcReply", { id: 9, reply: "STOREDKEY" });
        });

        it("returns null (without throwing) when the secret is present but cannot be decrypted", async () => {
            mockStore.getSecret.mockRejectedValue(new Error("Failed to decrypt safeStorage secret"));

            await callIpc("getPickleKey", 10);

            expect(send).toHaveBeenCalledWith("ipcReply", { id: 10, reply: null });
        });
    });
});

describe("setThemeColor", () => {
    let setBackgroundColor: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        setBackgroundColor = vi.fn();
        (global as unknown as { mainWindow: unknown }).mainWindow = { setBackgroundColor };
    });

    function reportColor(color: unknown): void {
        ipcHandlers["setThemeColor"]({}, color);
    }

    it("persists a valid colour and repaints the live window", () => {
        reportColor("rgb(16, 19, 23)");

        expect(mockStore.set).toHaveBeenCalledWith("backgroundColor", "rgb(16, 19, 23)");
        expect(setBackgroundColor).toHaveBeenCalledWith("rgb(16, 19, 23)");
    });

    it("ignores an invalid colour", () => {
        reportColor("javascript:alert(1)");

        expect(mockStore.set).not.toHaveBeenCalled();
        expect(setBackgroundColor).not.toHaveBeenCalled();
    });

    it("ignores a non-string payload", () => {
        reportColor({ malicious: true });

        expect(mockStore.set).not.toHaveBeenCalled();
        expect(setBackgroundColor).not.toHaveBeenCalled();
    });

    it("does not throw when there is no window", () => {
        (global as unknown as { mainWindow: unknown }).mainWindow = null;

        expect(() => reportColor("#101317")).not.toThrow();
        expect(mockStore.set).toHaveBeenCalledWith("backgroundColor", "#101317");
    });

    it("does not re-persist or repaint when the colour is unchanged", () => {
        mockStore.get.mockReturnValue("#101317");

        reportColor("#101317");

        expect(mockStore.set).not.toHaveBeenCalled();
        expect(setBackgroundColor).not.toHaveBeenCalled();
    });
});

describe("getDesktopCapturerSources", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send } };
    });

    it("maps sources to id/name/thumbnailURL on success", async () => {
        getSources.mockResolvedValue([
            { id: "s1", name: "Screen 1", thumbnail: { toDataURL: (): string => "data:image/png;base64,AAAA" } },
        ]);

        await callIpcWithArgs("getDesktopCapturerSources", [{ types: ["screen"] }], 20);

        expect(send).toHaveBeenCalledWith("ipcReply", {
            id: 20,
            reply: [{ id: "s1", name: "Screen 1", thumbnailURL: "data:image/png;base64,AAAA" }],
        });
    });

    it("replies with an empty list (so the renderer never dangles) when getSources rejects", async () => {
        getSources.mockRejectedValue(new Error("Failed to get sources"));

        await callIpcWithArgs("getDesktopCapturerSources", [{ types: ["screen"] }], 21);

        expect(send).toHaveBeenCalledWith("ipcReply", { id: 21, reply: [] });
    });

    it("replies with an empty list when there are no sources", async () => {
        getSources.mockResolvedValue([]);

        await callIpcWithArgs("getDesktopCapturerSources", [{ types: ["screen"] }], 22);

        expect(send).toHaveBeenCalledWith("ipcReply", { id: 22, reply: [] });
    });
});

describe("callDisplayMediaCallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send } };
    });

    it("invokes the consumed callback with the chosen source", async () => {
        const callback = vi.fn();
        consumeDisplayMediaCallback.mockReturnValue(callback);

        await callIpcWithArgs("callDisplayMediaCallback", [{ id: "s1", name: "Screen 1" }], 23);

        expect(callback).toHaveBeenCalledWith({ video: { id: "s1", name: "Screen 1" } });
        expect(send).toHaveBeenCalledWith("ipcReply", { id: 23, reply: null });
    });

    it("does not throw when the callback slot is empty (duplicate/stale IPC)", async () => {
        consumeDisplayMediaCallback.mockReturnValue(null);

        await expect(callIpcWithArgs("callDisplayMediaCallback", [{ id: "s1" }], 24)).resolves.toBeUndefined();
        expect(send).toHaveBeenCalledWith("ipcReply", { id: 24, reply: null });
    });
});
