/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useCallback, useEffect, useRef, useState } from "react";
import classNames from "classnames";
import { IconButton } from "@vector-im/compound-web";
import CheckIcon from "@vector-im/compound-design-tokens/assets/web/icons/check";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import PlusIcon from "@vector-im/compound-design-tokens/assets/web/icons/plus";
import { logger } from "matrix-js-sdk/src/logger";

import { SettingsSubsection, SettingsSubsectionText } from "./shared/SettingsSubsection";
import { _t } from "../../../languageHandler";
import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { useSettingValue } from "../../../hooks/useSettings";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import {
    CHAT_BACKGROUND_PRESETS,
    resolveChatBackground,
    type ResolvedChatBackground,
} from "../../../settings/ChatBackgrounds";

const NONE = "none";
const CUSTOM = "custom";

/**
 * How many times the preview paints the same background layer. See {@link previewStyle}.
 */
const PREVIEW_LAYERS = 5;

/**
 * The translated label for a bundled preset. Uses literal keys so the i18n tooling can find them.
 * @param id The preset id.
 * @returns The translated label.
 */
function presetLabel(id: string): string {
    switch (id) {
        case "dots":
            return _t("settings|appearance|chat_background_dots");
        case "grid":
            return _t("settings|appearance|chat_background_grid");
        case "diagonal":
            return _t("settings|appearance|chat_background_diagonal");
        case "soft":
            return _t("settings|appearance|chat_background_soft");
        default:
            return id;
    }
}

/**
 * Build the CSS for a tile's preview.
 *
 * The bundled presets are deliberately faint (10-16% alpha) so they sit quietly behind a full timeline, which
 * leaves them all but invisible in a tile-sized box. Painting the *same* layer several times fixes that without
 * touching the preset: every layer shares the tile and origin, so the ink lands pixel-exact on itself and the
 * alpha composites to `1 - (1 - a) ^ PREVIEW_LAYERS` (0.16 -> 0.58 for dots), while the gaps stay transparent in
 * every layer and keep the canvas colour showing through. Note this is a preview-only treatment: the wallpaper
 * actually applied to the timeline is unchanged.
 *
 * A single `background-repeat`/`background-size` is enough for all the layers -- CSS repeats a short list until it
 * matches the number of images.
 *
 * @param background The resolved background, or `null` for the "none" tile.
 * @param opaque Whether the image is already opaque, in which case one layer is all that can be seen anyway.
 * @returns The style to apply, or `undefined` when there is nothing to paint.
 */
function previewStyle(background: ResolvedChatBackground | null, opaque = false): React.CSSProperties | undefined {
    if (!background) return undefined;
    const layers = opaque ? 1 : PREVIEW_LAYERS;
    return {
        backgroundImage: Array.from({ length: layers }, () => background.image).join(", "),
        backgroundRepeat: background.repeat,
        backgroundSize: background.size,
    };
}

interface TileProps {
    /** The value written to the setting when this tile is chosen. */
    value: string;
    /** The accessible label, and the caption shown under the preview. */
    label: string;
    /** Whether this tile is currently selected. */
    selected: boolean;
    /** The resolved background to preview, or `null` for the "none" tile. */
    background: ResolvedChatBackground | null;
    /** Whether the previewed image is opaque. */
    opaque?: boolean;
    /** Called with {@link value} when the user picks this tile. */
    onSelect: (value: string) => void;
}

/**
 * A single selectable background tile. The whole tile is the control: the radio itself is visually hidden and
 * selection is shown by the ring and the check badge, so the state never rides on colour alone.
 */
function ChatBackgroundTile({ value, label, selected, background, opaque, onSelect }: TileProps): JSX.Element {
    return (
        <label className="mx_ChatBackgroundPanel_tile">
            <input
                type="radio"
                name="chatBackground"
                value={value}
                checked={selected}
                onChange={() => onSelect(value)}
                className="mx_ChatBackgroundPanel_tile_input"
            />
            <span
                className={classNames("mx_ChatBackgroundPanel_tile_preview", {
                    // Nothing to paint, so mark the empty swatch as deliberately empty.
                    mx_ChatBackgroundPanel_tile_preview_none: !background,
                })}
                style={previewStyle(background, opaque)}
                aria-hidden
            >
                <span className="mx_ChatBackgroundPanel_tile_check">
                    <CheckIcon width="12px" height="12px" />
                </span>
            </span>
            <span className="mx_ChatBackgroundPanel_tile_caption">{label}</span>
        </label>
    );
}

/**
 * A section of the Appearance settings that lets the user choose a wallpaper shown behind the message timeline:
 * one of the bundled presets, a custom uploaded image, or none. The choice is an account-level setting so it
 * follows the user across their devices.
 */
export function ChatBackgroundPanel(): JSX.Element {
    const client = useMatrixClientContext();
    const value = useSettingValue("RoomView.backgroundImage");
    const opacity = useSettingValue("RoomView.backgroundOpacity");
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const isCustomValue = typeof value === "string" && value.startsWith("mxc://");

    // Remember the uploaded image so its tile stays in the rail after picking a preset. Without this the only way
    // back to a custom wallpaper is to upload it again.
    const [customMxc, setCustomMxc] = useState<string | null>(isCustomValue ? value : null);
    useEffect(() => {
        if (isCustomValue) setCustomMxc(value);
    }, [value, isCustomValue]);

    // `RoomView.backgroundImage` lives in account data, and `useSettingValue` only updates once the homeserver
    // echoes the write back. Painting straight from it would make a click sit on the old tile until the round
    // trip lands -- and never move at all when offline -- so the click is shown immediately and released when
    // the echo arrives.
    const [pending, setPending] = useState<string | null>(null);
    const selected = pending ?? (!value ? NONE : isCustomValue ? CUSTOM : value);
    useEffect(() => setPending(null), [value]);

    const setBackground = useCallback(async (next: string | null): Promise<void> => {
        await SettingsStore.setValue("RoomView.backgroundImage", null, SettingLevel.ACCOUNT, next);
    }, []);

    const onSelect = useCallback(
        async (next: string): Promise<void> => {
            setError(null);
            setPending(next);
            try {
                if (next === NONE) await setBackground(null);
                else if (next === CUSTOM) await setBackground(customMxc);
                else await setBackground(next);
            } catch (e) {
                logger.error("Failed to set chat background", e);
                setPending(null);
            }
        },
        [customMxc, setBackground],
    );

    const onOpacityChange = useCallback(async (evt: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
        await SettingsStore.setValue(
            "RoomView.backgroundOpacity",
            null,
            SettingLevel.ACCOUNT,
            parseFloat(evt.target.value),
        );
    }, []);

    const onFileChange = useCallback(
        async (evt: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
            const file = evt.target.files?.[0];
            // Reset so selecting the same file again still fires a change event.
            evt.target.value = "";
            if (!file) return;
            setError(null);
            try {
                const { content_uri: mxc } = await client.uploadContent(file);
                setCustomMxc(mxc);
                setPending(CUSTOM);
                await setBackground(mxc);
            } catch (e) {
                logger.error("Failed to upload chat background image", e);
                setPending(null);
                setError(_t("settings|appearance|chat_background_upload_error"));
            }
        },
        [client, setBackground],
    );

    return (
        <SettingsSubsection
            heading={_t("settings|appearance|chat_background")}
            description={_t("settings|appearance|chat_background_description")}
            legacy={false}
            data-testid="chatBackgroundPanel"
        >
            <fieldset className="mx_ChatBackgroundPanel_rail">
                <legend className="mx_ChatBackgroundPanel_legend">{_t("settings|appearance|chat_background")}</legend>

                <ChatBackgroundTile
                    value={NONE}
                    label={_t("settings|appearance|chat_background_none")}
                    selected={selected === NONE}
                    background={null}
                    onSelect={onSelect}
                />
                {CHAT_BACKGROUND_PRESETS.map((preset) => (
                    <ChatBackgroundTile
                        key={preset.id}
                        value={preset.id}
                        label={presetLabel(preset.id)}
                        selected={selected === preset.id}
                        background={resolveChatBackground(preset.id)}
                        onSelect={onSelect}
                    />
                ))}
                {customMxc && (
                    <div className="mx_ChatBackgroundPanel_slot">
                        <ChatBackgroundTile
                            value={CUSTOM}
                            label={_t("settings|appearance|chat_background_custom")}
                            selected={selected === CUSTOM}
                            background={resolveChatBackground(customMxc, client)}
                            opaque
                            onSelect={onSelect}
                        />
                        {/* A sibling of the label rather than a child of it: nested, a click here would also
                            activate the radio it sits on top of. */}
                        <IconButton
                            className="mx_ChatBackgroundPanel_removeCustom"
                            type="button"
                            size="20px"
                            destructive
                            tooltip={_t("settings|appearance|chat_background_remove")}
                            onClick={() => {
                                setCustomMxc(null);
                                void onSelect(NONE);
                            }}
                        >
                            <CloseIcon />
                        </IconButton>
                    </div>
                )}

                <button
                    type="button"
                    // mx_Dialog_nonDialogButton opts out of the dialog's blanket `button` styling, which would
                    // otherwise dress this tile up as a pill-shaped dialog button.
                    className="mx_Dialog_nonDialogButton mx_ChatBackgroundPanel_uploadTile"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <span className="mx_ChatBackgroundPanel_tile_preview" aria-hidden>
                        <PlusIcon width="20px" height="20px" />
                    </span>
                    <span className="mx_ChatBackgroundPanel_tile_caption">
                        {_t("settings|appearance|chat_background_upload")}
                    </span>
                </button>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    data-testid="chatBackgroundUpload"
                    onChange={onFileChange}
                />
            </fieldset>

            {error && (
                <SettingsSubsectionText className="mx_ChatBackgroundPanel_error" role="alert">
                    {error}
                </SettingsSubsectionText>
            )}

            <label className="mx_ChatBackgroundPanel_opacity">
                <span>{_t("settings|appearance|chat_background_opacity")}</span>
                <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={opacity}
                    disabled={selected === NONE}
                    onChange={onOpacityChange}
                />
            </label>
        </SettingsSubsection>
    );
}
