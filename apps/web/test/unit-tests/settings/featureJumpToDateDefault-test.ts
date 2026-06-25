/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { SETTINGS } from "../../../src/settings/Settings";
import ServerSupportUnstableFeatureController from "../../../src/settings/controllers/ServerSupportUnstableFeatureController";

// The `feature_jump_to_date` default is `!!IS_ELECTRON`, evaluated when Settings.tsx is first imported, so we mock
// the Keyboard module (which exposes IS_ELECTRON) and re-import Settings in isolation to assert both branches. This
// locks the Phase-3 decision: jump-to-date defaults on for the desktop app and stays off on web (matching the
// `ctrlFForSearch` gate), while the ServerSupportUnstableFeatureController still forces it off without MSC3030.

describe("feature_jump_to_date default", () => {
    const loadDefault = (isElectron: boolean): unknown => {
        let value: unknown;
        jest.isolateModules(() => {
            jest.doMock("../../../src/Keyboard", () => ({
                ...jest.requireActual("../../../src/Keyboard"),
                IS_ELECTRON: isElectron,
            }));
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a sync re-import
            const { SETTINGS } = require("../../../src/settings/Settings");
            value = SETTINGS["feature_jump_to_date"].default;
        });
        return value;
    };

    afterEach(() => {
        jest.dontMock("../../../src/Keyboard");
        jest.resetModules();
    });

    it("defaults on for the desktop app (Electron)", () => {
        expect(loadDefault(true)).toBe(true);
    });

    it("defaults off on web", () => {
        expect(loadDefault(false)).toBe(false);
    });

    it("keeps the MSC3030 server-support controller that forces the feature off on unsupporting servers", () => {
        // The desktop-default-on is only safe because this controller forces the value back off when the homeserver
        // lacks MSC3030. Lock the wiring so dropping the controller (re-enabling broken UI on desktop) fails CI.
        expect(SETTINGS["feature_jump_to_date"].controller).toBeInstanceOf(ServerSupportUnstableFeatureController);
    });
});
