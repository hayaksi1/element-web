/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { mediaFromMxc } from "../customisations/Media";

/**
 * The bundled chat-background presets.
 *
 * `pattern` presets carry a raw, tileable inline SVG that is encoded into a `data:` URI at resolve
 * time. `gradient` presets carry a CSS gradient value used verbatim. Both are theme-neutral (mid-grey
 * / low-alpha) so they read acceptably over the light and dark canvas colours without bundling any
 * binary assets -- which keeps the feature working fully offline (no external CDN fetch).
 */
export type ChatBackgroundKind = "pattern" | "gradient";

export interface ChatBackgroundPreset {
    /** Stable id, stored verbatim in the `RoomView.backgroundImage` setting. */
    readonly id: string;
    readonly kind: ChatBackgroundKind;
    /** For `pattern`: a raw inline SVG. For `gradient`: a CSS gradient value. */
    readonly value: string;
    /** CSS `background-repeat` to use for this preset. */
    readonly repeat: string;
    /** CSS `background-size` to use for this preset. */
    readonly size: string;
}

/**
 * The resolved, ready-to-apply CSS values for a chat background. `image` is a valid CSS
 * `background-image` value (either a `url(...)` or a gradient function).
 */
export interface ResolvedChatBackground {
    readonly image: string;
    readonly repeat: string;
    readonly size: string;
}

const dotsSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>" +
    "<circle cx='16' cy='16' r='1.5' fill='rgba(128,128,128,0.16)'/></svg>";

const gridSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>" +
    "<path d='M0 0H32M0 0V32' stroke='rgba(128,128,128,0.12)' stroke-width='1' fill='none'/></svg>";

const diagonalSvg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
    "<path d='M-6 6 6 -6M0 24 24 0M18 30 30 18' stroke='rgba(128,128,128,0.14)' stroke-width='1.2'/></svg>";

/**
 * The bundled presets, in display order. The `RoomView.backgroundImage` setting stores either one of
 * these ids or an `mxc://` URI for a user-uploaded image.
 */
export const CHAT_BACKGROUND_PRESETS: readonly ChatBackgroundPreset[] = [
    { id: "dots", kind: "pattern", value: dotsSvg, repeat: "repeat", size: "auto" },
    { id: "grid", kind: "pattern", value: gridSvg, repeat: "repeat", size: "auto" },
    { id: "diagonal", kind: "pattern", value: diagonalSvg, repeat: "repeat", size: "auto" },
    {
        id: "soft",
        kind: "gradient",
        value: "linear-gradient(160deg, rgba(120,140,255,0.10), rgba(255,140,200,0.10))",
        repeat: "no-repeat",
        size: "cover",
    },
];

/**
 * Look up a bundled preset by id.
 * @param id The preset id.
 * @returns The preset, or `undefined` if no preset has that id.
 */
export function getChatBackgroundPreset(id: string): ChatBackgroundPreset | undefined {
    return CHAT_BACKGROUND_PRESETS.find((preset) => preset.id === id);
}

/**
 * Build the CSS `background-image` value for a preset.
 * @param preset The preset to resolve.
 * @returns The `background-image` value.
 */
function presetImage(preset: ChatBackgroundPreset): string {
    if (preset.kind === "gradient") return preset.value;
    return `url("data:image/svg+xml,${encodeURIComponent(preset.value)}")`;
}

/**
 * Resolve a stored `RoomView.backgroundImage` value into ready-to-apply CSS values.
 *
 * @param value The stored setting value: `null`/empty for none, an `mxc://` URI for an uploaded image,
 *     or a bundled preset id.
 * @param client Optional client, used to turn an `mxc://` URI into an HTTP URL.
 * @returns The resolved background, or `null` when nothing should be painted (no value, an unknown
 *     preset id, or an `mxc://` URI that could not be turned into an HTTP URL).
 */
export function resolveChatBackground(
    value: string | null | undefined,
    client?: MatrixClient,
): ResolvedChatBackground | null {
    if (!value) return null;

    if (value.startsWith("mxc://")) {
        const srcHttp = mediaFromMxc(value, client).srcHttp;
        if (!srcHttp) return null;
        return { image: `url("${srcHttp}")`, repeat: "no-repeat", size: "cover" };
    }

    const preset = getChatBackgroundPreset(value);
    if (!preset) return null;
    return { image: presetImage(preset), repeat: preset.repeat, size: preset.size };
}
