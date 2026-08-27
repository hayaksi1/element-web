/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach } from "vitest";

import { defaultBindingsProvider } from "./KeyBindingsDefaults";
import SettingsStore from "./settings/SettingsStore";
import { KeyBindingAction } from "./accessibility/KeyboardShortcuts";
import { type KeyBinding } from "./KeyBindingsManager";
import { Key } from "./Keyboard";

const searchBinding = (bindings: KeyBinding[]): KeyBinding | undefined =>
    bindings.find((b) => b.action === KeyBindingAction.SearchInRoom);

describe("defaultBindingsProvider.getRoomBindings", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers the Ctrl/Cmd+F room-search binding when ctrlFForSearch is enabled", () => {
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => name === "ctrlFForSearch");

        const binding = searchBinding(defaultBindingsProvider.getRoomBindings());

        expect(binding).toBeDefined();
        expect(binding!.keyCombo).toEqual({ key: Key.F, ctrlOrCmdKey: true });
    });

    it("omits the room-search binding when ctrlFForSearch is disabled", () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);

        expect(searchBinding(defaultBindingsProvider.getRoomBindings())).toBeUndefined();
    });
});
