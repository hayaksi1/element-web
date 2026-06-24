/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { IPCManager } from "../../../../src/vector/platform/IPCManager";
import { SeshatIndexManager } from "../../../../src/vector/platform/SeshatIndexManager";

describe("SeshatIndexManager", () => {
    let callSpy: jest.SpyInstance;

    beforeEach(() => {
        // IPCManager's constructor requires window.electron to exist.
        window.electron = { on: jest.fn(), send: jest.fn() } as unknown as typeof window.electron;
        callSpy = jest.spyOn(IPCManager.prototype, "call").mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
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
