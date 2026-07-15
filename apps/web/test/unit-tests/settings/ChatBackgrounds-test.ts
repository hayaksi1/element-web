/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    CHAT_BACKGROUND_PRESETS,
    getChatBackgroundPreset,
    resolveChatBackground,
} from "../../../src/settings/ChatBackgrounds";

describe("ChatBackgrounds", () => {
    const clientWith = (httpUrl: string | null): MatrixClient =>
        ({ mxcUrlToHttp: jest.fn().mockReturnValue(httpUrl) }) as unknown as MatrixClient;

    describe("CHAT_BACKGROUND_PRESETS", () => {
        it("exposes the bundled presets", () => {
            expect(CHAT_BACKGROUND_PRESETS.map((p) => p.id)).toEqual(["dots", "grid", "diagonal", "soft"]);
        });
    });

    describe("getChatBackgroundPreset", () => {
        it("returns a preset by id", () => {
            expect(getChatBackgroundPreset("grid")?.id).toBe("grid");
        });

        it("returns undefined for an unknown id", () => {
            expect(getChatBackgroundPreset("nope")).toBeUndefined();
        });
    });

    describe("resolveChatBackground", () => {
        it.each([null, undefined, ""])("returns null for the empty value %p", (value) => {
            expect(resolveChatBackground(value)).toBeNull();
        });

        it("returns null for an unknown preset id", () => {
            expect(resolveChatBackground("mystery")).toBeNull();
        });

        it("resolves a pattern preset to a tiled SVG data URI", () => {
            const resolved = resolveChatBackground("dots");
            expect(resolved).toEqual({
                image: expect.stringContaining('url("data:image/svg+xml,'),
                repeat: "repeat",
                size: "auto",
            });
            // The SVG payload is URL-encoded.
            expect(resolved!.image).toContain("%3Csvg");
        });

        it("resolves a gradient preset to a CSS gradient", () => {
            const resolved = resolveChatBackground("soft");
            expect(resolved).toEqual({
                image: expect.stringContaining("linear-gradient("),
                repeat: "no-repeat",
                size: "cover",
            });
        });

        it("resolves an mxc URI to an http url via the client", () => {
            const client = clientWith("https://cdn.example/wall.png");
            expect(resolveChatBackground("mxc://example.org/abc", client)).toEqual({
                image: 'url("https://cdn.example/wall.png")',
                repeat: "no-repeat",
                size: "cover",
            });
            expect(client.mxcUrlToHttp).toHaveBeenCalled();
        });

        it("returns null when the mxc URI cannot be resolved to http", () => {
            expect(resolveChatBackground("mxc://example.org/abc", clientWith(null))).toBeNull();
        });
    });
});
