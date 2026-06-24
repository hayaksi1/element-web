/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type {
    Seshat as SeshatType,
    SeshatRecovery as SeshatRecoveryType,
    ReindexError as ReindexErrorType,
} from "matrix-seshat"; // Hak dependency type
import { createSeshatConfig, DEFAULT_TOKENIZER_MODE, type TokenizerMode } from "./seshat-config.js";

/**
 * Collaborators for {@link initEventIndex}, injected so the open/rebuild logic can be unit-tested
 * without the native `matrix-seshat` module or the filesystem.
 */
export interface SeshatIndexDeps {
    Seshat: typeof SeshatType;
    SeshatRecovery: typeof SeshatRecoveryType;
    ReindexError: typeof ReindexErrorType;
    /** Create the event-store directory (recursively); a no-op if it already exists. */
    ensureDir: (path: string) => Promise<void>;
    /** Delete the contents of the event-store directory (used to rebuild the index). */
    deleteContents: (path: string) => Promise<void>;
    /** The tokenizer mode the on-disk index was last built with, or `undefined` if unknown. */
    getStoredTokenizerMode: () => TokenizerMode | undefined;
    /** Persist the tokenizer mode the index has now been built with. */
    setStoredTokenizerMode: (mode: TokenizerMode) => void;
    /** Optional logging seam. */
    log?: (message: string) => void;
}

/**
 * Open (or create) the Seshat event index for the given tokenizer mode.
 *
 * The tokenizer is baked into the on-disk index schema, so changing it requires the index to be
 * rebuilt — seshat itself errors on a schema mismatch ("Delete the database and recreate it to use
 * a different tokenizer mode"). When the requested mode differs from the mode the index was last
 * built with we therefore delete the existing index up-front (it is a rebuildable local cache —
 * no message history is lost; the crawler re-populates it) so seshat recreates it cleanly with the
 * new tokenizer instead of failing to open. See https://github.com/element-hq/element-web/issues/32038.
 *
 * The `ReindexError` recovery path is unchanged from the historic behaviour and still handles a
 * seshat schema-version bump for an index whose tokenizer mode has not changed.
 */
export async function initEventIndex(
    eventStorePath: string,
    passphrase: string,
    mode: TokenizerMode,
    deps: SeshatIndexDeps,
): Promise<SeshatType> {
    await deps.ensureDir(eventStorePath);

    const storedMode = deps.getStoredTokenizerMode() ?? DEFAULT_TOKENIZER_MODE;
    if (storedMode !== mode) {
        deps.log?.(`Seshat tokenizer mode changed from "${storedMode}" to "${mode}", rebuilding the search index`);
        await deps.deleteContents(eventStorePath);
    }

    const config = createSeshatConfig(passphrase, mode);

    let index: SeshatType;
    try {
        index = new deps.Seshat(eventStorePath, config);
    } catch (e) {
        if (e instanceof deps.ReindexError) {
            // The index schema changed (e.g. a seshat version bump). Open the database in recovery
            // mode, reindex it, and finally open it again. A never-versioned index (userVersion 0)
            // is discarded rather than wastefully reindexed.
            const recoveryIndex = new deps.SeshatRecovery(eventStorePath, config);
            const userVersion = await recoveryIndex.getUserVersion();
            if (userVersion === 0) {
                await recoveryIndex.shutdown();
                await deps.deleteContents(eventStorePath);
            } else {
                await recoveryIndex.reindex();
            }
            index = new deps.Seshat(eventStorePath, config);
        } else {
            throw e;
        }
    }

    deps.setStoredTokenizerMode(mode);
    return index;
}
