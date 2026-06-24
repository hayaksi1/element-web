/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

interface ConfirmQuitOptions {
    /** Whether the user has opted into a confirmation before quitting (`Store.shouldWarnBeforeExit()`). */
    warnBeforeExit: boolean;
    /** Shows the confirmation and returns true if the user chose to proceed with the quit. */
    confirm: () => boolean;
}

/**
 * Pure decision shared by every "user asked to quit" entry point — the ⌘Q / Ctrl+Q / Alt+F4 keyboard
 * shortcuts, the app/File-menu Quit item, and the tray Quit item: should the app actually quit?
 *
 * - No warning configured → quit immediately (the `confirm` callback is NOT invoked).
 * - Warning configured → quit only if the user confirms.
 *
 * Keeping the branching here — free of Electron/dialog/app access — means the menu, tray and keyboard
 * paths all honour the same warn-before-exit setting (previously only the keyboard path did, so
 * File→Quit and tray Quit silently bypassed the confirmation on Windows/Linux, where it is the
 * default; see element-web#32287) and it is unit-testable in isolation.
 */
export function shouldQuitAfterConfirm(options: ConfirmQuitOptions): boolean {
    if (!options.warnBeforeExit) return true;
    return options.confirm();
}
