/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

export interface UserDownloadAction {
    id: number;
    open?: boolean;
}

/**
 * Pure decision for a `userDownloadAction` IPC message.
 *
 * Returns the absolute path that should be opened — when the user clicked "Open" on the
 * download-complete toast and the id is still known — or `undefined` when nothing should open
 * (a plain dismiss, or an unknown/expired id). There is no Electron/shell access here, so the
 * branching is unit-testable in isolation; the caller opens the path and removes the map entry.
 */
export function resolveUserDownloadAction(
    action: UserDownloadAction,
    map: ReadonlyMap<number, string>,
): string | undefined {
    const { id, open = false } = action;
    return open ? map.get(id) : undefined;
}
