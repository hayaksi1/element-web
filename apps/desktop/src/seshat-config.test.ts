/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    createSeshatConfig,
    DEFAULT_TOKENIZER_MODE,
    NGRAM_MAX_SIZE,
    NGRAM_MIN_SIZE,
    normalizeTokenizerMode,
} from "./seshat-config.js";

describe("normalizeTokenizerMode", () => {
    it('returns "ngram" only for the exact "ngram" string', () => {
        expect(normalizeTokenizerMode("ngram")).toBe("ngram");
    });

    it('returns the language default for "language"', () => {
        expect(normalizeTokenizerMode("language")).toBe("language");
        expect(DEFAULT_TOKENIZER_MODE).toBe("language");
    });

    it.each([undefined, null, "", "NGRAM", "ngrams", "lang", 2, {}, []])(
        "falls back to the language default for unexpected value %o",
        (value) => {
            expect(normalizeTokenizerMode(value)).toBe("language");
        },
    );
});

describe("createSeshatConfig", () => {
    it("builds a language config without n-gram sizes", () => {
        expect(createSeshatConfig("hunter2", "language")).toEqual({
            passphrase: "hunter2",
            tokenizerMode: "language",
        });
    });

    it("builds an n-gram config with the default n-gram sizes", () => {
        expect(createSeshatConfig("hunter2", "ngram")).toEqual({
            passphrase: "hunter2",
            tokenizerMode: "ngram",
            ngramMinSize: NGRAM_MIN_SIZE,
            ngramMaxSize: NGRAM_MAX_SIZE,
        });
        expect(NGRAM_MIN_SIZE).toBe(2);
        expect(NGRAM_MAX_SIZE).toBe(4);
    });

    it("threads the given passphrase through unchanged", () => {
        expect(createSeshatConfig("a-different-passphrase", "ngram").passphrase).toBe("a-different-passphrase");
    });
});
