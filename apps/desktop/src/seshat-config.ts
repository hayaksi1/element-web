/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Tokenizer mode for the Seshat (encrypted message) search index.
 *
 * - `language` (default): language-specific stemming via a simple word-boundary tokenizer. Only
 *   useful for languages that have word boundaries (English, German, …).
 * - `ngram`: splits text into character n-grams, so local search works for languages without word
 *   boundaries (Japanese, Chinese, …) and mixed-language text. See
 *   https://github.com/element-hq/element-web/issues/32038.
 */
export type TokenizerMode = "language" | "ngram";

/** The tokenizer mode used when the user has not opted into anything else. */
export const DEFAULT_TOKENIZER_MODE: TokenizerMode = "language";

/** N-gram sizes used for the "ngram" tokenizer; mirrors the seshat binding defaults. */
export const NGRAM_MIN_SIZE = 2;
export const NGRAM_MAX_SIZE = 4;

/** The config object passed to the `Seshat`/`SeshatRecovery` constructors. */
export interface SeshatConfig {
    passphrase: string;
    tokenizerMode: TokenizerMode;
    ngramMinSize?: number;
    ngramMaxSize?: number;
}

/**
 * Coerce an untrusted value (e.g. one arriving over IPC from the renderer) into a known
 * {@link TokenizerMode}, falling back to the safe language-based default for anything unexpected.
 */
export function normalizeTokenizerMode(mode: unknown): TokenizerMode {
    return mode === "ngram" ? "ngram" : DEFAULT_TOKENIZER_MODE;
}

/**
 * Build the seshat constructor config for the given passphrase and tokenizer mode. The n-gram sizes
 * are only included for the n-gram mode so the language path keeps the binding's own defaults.
 */
export function createSeshatConfig(passphrase: string, mode: TokenizerMode): SeshatConfig {
    if (mode === "ngram") {
        return {
            passphrase,
            tokenizerMode: "ngram",
            ngramMinSize: NGRAM_MIN_SIZE,
            ngramMaxSize: NGRAM_MAX_SIZE,
        };
    }
    return { passphrase, tokenizerMode: "language" };
}
