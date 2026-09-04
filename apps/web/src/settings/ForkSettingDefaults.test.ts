/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { SETTINGS } from "./Settings.tsx";

describe("fork setting defaults", () => {
    it("opens threads full-size in the main split out of the box", () => {
        expect(SETTINGS["Threads.fullSizeView"].default).toBe(true);
    });
});
