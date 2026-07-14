/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach, type MockInstance } from "vitest";

import { IPCManager } from "./IPCManager";
import { SeshatIndexManager } from "./SeshatIndexManager";

describe("SeshatIndexManager", () => {
    let callSpy: MockInstance;

    beforeEach(() => {
        // IPCManager's constructor requires window.electron to exist.
        window.electron = { on: vi.fn(), send: vi.fn() } as unknown as typeof window.electron;
        callSpy = vi.spyOn(IPCManager.prototype, "call").mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (window as { electron?: unknown }).electron;
    });

    it("forwards the tokenizer mode to the initEventIndex IPC call (#32038)", async () => {
        const manager = new SeshatIndexManager();

        await manager.initEventIndex("@alice:example.org", "DEVICE1", "ngram");

        expect(callSpy).toHaveBeenCalledWith("initEventIndex", "@alice:example.org", "DEVICE1", "ngram");
    });

    it("passes undefined when no tokenizer mode is given (binding defaults to language)", async () => {
        const manager = new SeshatIndexManager();

        await manager.initEventIndex("@alice:example.org", "DEVICE1");

        expect(callSpy).toHaveBeenCalledWith("initEventIndex", "@alice:example.org", "DEVICE1", undefined);
    });
});
