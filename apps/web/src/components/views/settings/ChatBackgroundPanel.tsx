/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useCallback, useRef, useState } from "react";
import { Button, Field, Label, RadioControl, Root } from "@vector-im/compound-web";
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

interface SwatchProps {
    /** The value written to the setting when this swatch is chosen. */
    value: string;
    /** The accessible label. */
    label: string;
    /** Whether this swatch is currently selected. */
    selected: boolean;
    /** The resolved background to preview, or `null` for the "none" swatch. */
    background: ResolvedChatBackground | null;
}

/**
 * A single selectable background swatch.
 */
function ChatBackgroundSwatch({ value, label, selected, background }: SwatchProps): JSX.Element {
    const style: React.CSSProperties | undefined = background
        ? {
              backgroundImage: background.image,
              backgroundRepeat: background.repeat,
              backgroundSize: background.size,
          }
        : undefined;

    return (
        <Field name="chatBackground" className="mx_ChatBackgroundPanel_swatch">
            <Label aria-label={label}>
                <div className="mx_ChatBackgroundPanel_swatch_preview" style={style} />
                <div className="mx_ChatBackgroundPanel_swatch_row">
                    <RadioControl name="chatBackground" value={value} defaultChecked={selected} />
                    <span>{label}</span>
                </div>
            </Label>
        </Field>
    );
}

/**
 * A section of the Appearance settings that lets the user choose a wallpaper shown behind the
 * message timeline: one of the bundled presets, a custom uploaded image, or none. The choice is an
 * account-level setting so it follows the user across their devices.
 */
export function ChatBackgroundPanel(): JSX.Element {
    const client = useMatrixClientContext();
    const value = useSettingValue("RoomView.backgroundImage");
    const opacity = useSettingValue("RoomView.backgroundOpacity");
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const isCustom = typeof value === "string" && value.startsWith("mxc://");
    const selected = !value ? NONE : isCustom ? CUSTOM : value;

    const setBackground = useCallback(async (next: string | null): Promise<void> => {
        await SettingsStore.setValue("RoomView.backgroundImage", null, SettingLevel.ACCOUNT, next);
    }, []);

    const onPresetChange = useCallback(
        async (evt: React.FormEvent<HTMLFormElement>): Promise<void> => {
            const picked = new FormData(evt.currentTarget).get("chatBackground");
            if (picked === NONE) await setBackground(null);
            else if (picked === CUSTOM) {
                // The custom image is already stored; selecting it is a no-op.
            } else if (typeof picked === "string") await setBackground(picked);
        },
        [setBackground],
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
                await setBackground(mxc);
            } catch (e) {
                logger.error("Failed to upload chat background image", e);
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
            {/* Remount on external changes so the uncontrolled radios reflect the current value. */}
            <Root key={selected} className="mx_ChatBackgroundPanel_presets" onChange={onPresetChange}>
                <ChatBackgroundSwatch
                    value={NONE}
                    label={_t("settings|appearance|chat_background_none")}
                    selected={selected === NONE}
                    background={null}
                />
                {CHAT_BACKGROUND_PRESETS.map((preset) => (
                    <ChatBackgroundSwatch
                        key={preset.id}
                        value={preset.id}
                        label={presetLabel(preset.id)}
                        selected={selected === preset.id}
                        background={resolveChatBackground(preset.id)}
                    />
                ))}
                {isCustom && (
                    <ChatBackgroundSwatch
                        value={CUSTOM}
                        label={_t("settings|appearance|chat_background_custom")}
                        selected
                        background={resolveChatBackground(value, client)}
                    />
                )}
            </Root>

            <div className="mx_ChatBackgroundPanel_actions">
                <Button kind="secondary" size="md" onClick={() => fileInputRef.current?.click()}>
                    {_t("settings|appearance|chat_background_upload")}
                </Button>
                {isCustom && (
                    <Button kind="tertiary" size="md" onClick={() => setBackground(null)}>
                        {_t("settings|appearance|chat_background_remove")}
                    </Button>
                )}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    data-testid="chatBackgroundUpload"
                    onChange={onFileChange}
                />
            </div>

            {error && <SettingsSubsectionText className="mx_ChatBackgroundPanel_error">{error}</SettingsSubsectionText>}

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
