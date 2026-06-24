/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { initEventIndex, type SeshatIndexDeps } from "./seshat-index.js";
import { type TokenizerMode } from "./seshat-config.js";

const STORE_PATH = "/data/EventStore";
const PASSPHRASE = "s3cret";

class FakeReindexError extends Error {
    public constructor() {
        super("The Seshat database needs to be reindexed.");
        this.name = "ReindexError";
    }
}

interface Harness {
    deps: SeshatIndexDeps;
    Seshat: Mock;
    SeshatRecovery: Mock;
    recovery: { getUserVersion: Mock; shutdown: Mock; reindex: Mock };
    calls: string[];
    stored: { mode: TokenizerMode | undefined };
}

function makeHarness(storedMode?: TokenizerMode): Harness {
    const calls: string[] = [];
    const stored = { mode: storedMode };

    // A constructor mock: `new Seshat(path, config)` builds a sentinel instance. A regular
    // `function` (not an arrow) is required so it can be invoked with `new`.
    const Seshat = vi.fn(function (this: Record<string, unknown>, path: string, config: unknown) {
        calls.push("construct");
        this.__seshat = true;
        this.path = path;
        this.config = config;
    }) as unknown as Mock;

    const recovery = {
        getUserVersion: vi.fn(async () => 1),
        shutdown: vi.fn(async () => {}),
        reindex: vi.fn(async () => {}),
    };
    const SeshatRecovery = vi.fn(function (this: Record<string, unknown>) {
        Object.assign(this, recovery);
    }) as unknown as Mock;

    const deps: SeshatIndexDeps = {
        Seshat: Seshat as never,
        SeshatRecovery: SeshatRecovery as never,
        ReindexError: FakeReindexError as never,
        ensureDir: vi.fn(async () => {
            calls.push("ensureDir");
        }),
        deleteContents: vi.fn(async () => {
            calls.push("deleteContents");
        }),
        getStoredTokenizerMode: vi.fn(() => stored.mode),
        setStoredTokenizerMode: vi.fn((mode: TokenizerMode) => {
            calls.push("store");
            stored.mode = mode;
        }),
        log: vi.fn(),
    };

    return { deps, Seshat, SeshatRecovery, recovery, calls, stored };
}

describe("initEventIndex", () => {
    beforeEach(() => vi.clearAllMocks());

    it("creates the store dir and opens a language index for a fresh install without deleting anything", async () => {
        const h = makeHarness(undefined);

        const index = await initEventIndex(STORE_PATH, PASSPHRASE, "language", h.deps);

        expect(h.deps.ensureDir).toHaveBeenCalledWith(STORE_PATH);
        expect(h.deps.deleteContents).not.toHaveBeenCalled();
        expect(h.Seshat).toHaveBeenCalledWith(STORE_PATH, { passphrase: PASSPHRASE, tokenizerMode: "language" });
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledWith("language");
        expect(index).toMatchObject({ __seshat: true });
    });

    it("opens an n-gram index with the n-gram sizes", async () => {
        const h = makeHarness("ngram");

        await initEventIndex(STORE_PATH, PASSPHRASE, "ngram", h.deps);

        expect(h.deps.deleteContents).not.toHaveBeenCalled();
        expect(h.Seshat).toHaveBeenCalledWith(STORE_PATH, {
            passphrase: PASSPHRASE,
            tokenizerMode: "ngram",
            ngramMinSize: 2,
            ngramMaxSize: 4,
        });
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledWith("ngram");
    });

    it("rebuilds the index when the tokenizer mode changes, deleting BEFORE constructing", async () => {
        const h = makeHarness("language");

        await initEventIndex(STORE_PATH, PASSPHRASE, "ngram", h.deps);

        expect(h.deps.deleteContents).toHaveBeenCalledWith(STORE_PATH);
        // The delete must happen before the (incompatible) index is opened.
        expect(h.calls).toEqual(["ensureDir", "deleteContents", "construct", "store"]);
        expect(h.Seshat).toHaveBeenCalledTimes(1);
        expect(h.Seshat).toHaveBeenCalledWith(STORE_PATH, expect.objectContaining({ tokenizerMode: "ngram" }));
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledWith("ngram");
    });

    it("treats an unknown stored mode as language and does NOT rebuild a language index", async () => {
        const h = makeHarness(undefined);

        await initEventIndex(STORE_PATH, PASSPHRASE, "language", h.deps);

        expect(h.deps.deleteContents).not.toHaveBeenCalled();
    });

    it("recovers via reindex on a ReindexError when the user version is non-zero", async () => {
        const h = makeHarness("ngram");
        h.recovery.getUserVersion.mockResolvedValue(7);
        (h.Seshat as Mock).mockImplementationOnce(function () {
            throw new FakeReindexError();
        });

        const index = await initEventIndex(STORE_PATH, PASSPHRASE, "ngram", h.deps);

        expect(h.SeshatRecovery).toHaveBeenCalledWith(STORE_PATH, expect.objectContaining({ tokenizerMode: "ngram" }));
        expect(h.recovery.reindex).toHaveBeenCalledTimes(1);
        expect(h.recovery.shutdown).not.toHaveBeenCalled();
        expect(h.Seshat).toHaveBeenCalledTimes(2);
        expect(index).toMatchObject({ __seshat: true });
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledWith("ngram");
    });

    it("discards a never-versioned index on a ReindexError (user version 0)", async () => {
        const h = makeHarness("language");
        h.recovery.getUserVersion.mockResolvedValue(0);
        (h.Seshat as Mock).mockImplementationOnce(function () {
            throw new FakeReindexError();
        });

        await initEventIndex(STORE_PATH, PASSPHRASE, "language", h.deps);

        expect(h.recovery.shutdown).toHaveBeenCalledTimes(1);
        expect(h.recovery.reindex).not.toHaveBeenCalled();
        expect(h.deps.deleteContents).toHaveBeenCalledWith(STORE_PATH);
        expect(h.Seshat).toHaveBeenCalledTimes(2);
    });

    it("propagates a non-ReindexError and does not persist the mode", async () => {
        const h = makeHarness("language");
        (h.Seshat as Mock).mockImplementationOnce(function () {
            throw new Error("disk on fire");
        });

        await expect(initEventIndex(STORE_PATH, PASSPHRASE, "language", h.deps)).rejects.toThrow("disk on fire");

        expect(h.SeshatRecovery).not.toHaveBeenCalled();
        expect(h.deps.setStoredTokenizerMode).not.toHaveBeenCalled();
    });

    it("handles a mode change whose fresh open still throws ReindexError (combined path)", async () => {
        const h = makeHarness("language");
        h.recovery.getUserVersion.mockResolvedValue(0);
        (h.Seshat as Mock).mockImplementationOnce(function () {
            throw new FakeReindexError();
        });

        await initEventIndex(STORE_PATH, PASSPHRASE, "ngram", h.deps);

        // The up-front rebuild delete (mode change) AND the userVersion-0 recovery delete both fire,
        // and the mode is persisted exactly once after the successful reopen.
        expect(h.deps.deleteContents).toHaveBeenCalledTimes(2);
        expect(h.recovery.shutdown).toHaveBeenCalledTimes(1);
        expect(h.recovery.reindex).not.toHaveBeenCalled();
        expect(h.Seshat).toHaveBeenCalledTimes(2);
        expect(h.Seshat).toHaveBeenNthCalledWith(2, STORE_PATH, expect.objectContaining({ tokenizerMode: "ngram" }));
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledTimes(1);
        expect(h.deps.setStoredTokenizerMode).toHaveBeenCalledWith("ngram");
    });
});
