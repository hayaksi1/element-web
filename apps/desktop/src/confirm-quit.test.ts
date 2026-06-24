/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { shouldQuitAfterConfirm } from "./confirm-quit.js";

describe("shouldQuitAfterConfirm", () => {
    it("quits immediately without prompting when no warning is configured (macOS default / warn-off)", () => {
        const confirm = vi.fn(() => true);

        expect(shouldQuitAfterConfirm({ warnBeforeExit: false, confirm })).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });

    it("quits when a warning is configured and the user confirms", () => {
        const confirm = vi.fn(() => true);

        expect(shouldQuitAfterConfirm({ warnBeforeExit: true, confirm })).toBe(true);
        expect(confirm).toHaveBeenCalledOnce();
    });

    it("does not quit when a warning is configured and the user cancels", () => {
        const confirm = vi.fn(() => false);

        expect(shouldQuitAfterConfirm({ warnBeforeExit: true, confirm })).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
    });

    it("never prompts when no warning is configured, even if confirm would throw", () => {
        const confirm = vi.fn((): boolean => {
            throw new Error("confirm must not be called when warnBeforeExit is false");
        });

        expect(shouldQuitAfterConfirm({ warnBeforeExit: false, confirm })).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
    });
});
