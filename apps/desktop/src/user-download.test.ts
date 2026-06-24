/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { resolveUserDownloadAction } from "./user-download.js";

describe("resolveUserDownloadAction", () => {
    const map: ReadonlyMap<number, string> = new Map([[1, "/tmp/a.pdf"]]);

    it("returns the path to open for a known id when open=true", () => {
        expect(resolveUserDownloadAction({ id: 1, open: true }, map)).toBe("/tmp/a.pdf");
    });

    it("returns undefined for an unknown id even when open=true", () => {
        expect(resolveUserDownloadAction({ id: 999, open: true }, map)).toBeUndefined();
    });

    it("returns undefined on a plain dismiss (open=false)", () => {
        expect(resolveUserDownloadAction({ id: 1, open: false }, map)).toBeUndefined();
    });

    it("treats a missing open flag as a dismiss", () => {
        expect(resolveUserDownloadAction({ id: 1 }, map)).toBeUndefined();
    });

    it("does not mutate the map", () => {
        const m = new Map<number, string>([[1, "/tmp/a.pdf"]]);
        resolveUserDownloadAction({ id: 1, open: true }, m);
        expect(m.size).toBe(1);
        expect(m.get(1)).toBe("/tmp/a.pdf");
    });
});
