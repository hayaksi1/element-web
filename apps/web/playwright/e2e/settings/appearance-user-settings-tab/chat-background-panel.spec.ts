/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import path from "node:path";

import { type Page } from "@playwright/test";
import { rejectToast } from "@element-hq/element-web-playwright-common";

import { expect, test } from ".";
import { SettingLevel } from "../../../../src/settings/SettingLevel";

// Playwright runs from apps/web; drop the captures somewhere the user can actually open them.
const SHOTS = path.resolve(process.cwd(), "../../screenshots");

// A 2x2 magenta PNG: enough to prove the upload round-trip and give the custom tile something to show.
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4ECwESJ5uFhAADrOwMBnDeHDwAAAABJRU5ErkJggg==",
    "base64",
);

/**
 * Locate the panel by class, not by test id: webpack drops `data-testid` from the production bundle that the
 * `CI=1` web server serves, so `getByTestId("chatBackgroundPanel")` finds nothing even though it renders.
 */
const chatBackgroundPanel = (page: Page) =>
    page.locator(".mx_SettingsSubsection").filter({ has: page.locator(".mx_ChatBackgroundPanel_rail") });

/**
 * The tile a user actually clicks. The radio itself is deliberately hidden behind the preview, so driving it
 * directly is both unclickable and a lie about how the control is used.
 */
const tile = (page: Page, name: string) =>
    chatBackgroundPanel(page).locator(".mx_ChatBackgroundPanel_tile", { hasText: name });

test.describe("Chat background panel", () => {
    test.use({ displayName: "Hanako" });

    test("lets the user pick, upload and clear a wallpaper", async ({ page, app, user, util, axe }) => {
        await rejectToast(page, "Verify this device");
        await util.disableSystemTheme();
        await util.openAppearanceTab();

        const panel = chatBackgroundPanel(page);
        await expect(panel).toBeVisible();

        // Nothing is chosen, so the opacity slider has nothing to act on.
        await expect(panel.getByRole("radio", { name: "None" })).toBeChecked();
        await expect(panel.getByRole("slider")).toBeDisabled();
        await page.locator(".mx_SettingsTab").screenshot({ path: `${SHOTS}/chat-background-1-tab-light.png` });
        await panel.screenshot({ path: `${SHOTS}/chat-background-2-rail-none-light.png` });

        // The rail fits on one row -- the whole point of the redesign.
        const railBox = await panel.locator(".mx_ChatBackgroundPanel_rail").boundingBox();
        const tileBox = await panel.locator(".mx_ChatBackgroundPanel_tile").first().boundingBox();
        expect(railBox!.height).toBeLessThan(tileBox!.height * 2);

        await tile(page, "Dots").click();
        await expect(panel.getByRole("radio", { name: "Dots" })).toBeChecked();
        await expect(panel.getByRole("slider")).toBeEnabled();
        await panel.screenshot({ path: `${SHOTS}/chat-background-3-rail-dots-light.png` });

        // The wallpaper reaches the timeline, not just the setting.
        await util.closeAppearanceTab();
        await util.createAndDisplayRoom();
        await expect(page.locator(".mx_RoomView_timeline")).toHaveCSS("--mx-chat-background-repeat", "repeat");
        await page.screenshot({ path: `${SHOTS}/chat-background-4-timeline-dots.png` });

        await util.openAppearanceTab();
        await panel.locator('input[type="file"]').setInputFiles({
            name: "wallpaper.png",
            mimeType: "image/png",
            buffer: PNG,
        });

        // Uploading selects the image, and its tile survives picking a preset afterwards -- otherwise the only
        // way back to it is to upload it again.
        const custom = panel.getByRole("radio", { name: "Custom image" });
        await expect(custom).toBeChecked();
        await tile(page, "Grid").click();
        await expect(panel.getByRole("radio", { name: "Grid" })).toBeChecked();
        await expect(custom).toBeVisible();
        await panel.screenshot({ path: `${SHOTS}/chat-background-5-custom-persists-light.png` });

        // Re-selecting it restores the uploaded image rather than doing nothing.
        await tile(page, "Custom image").click();
        await expect(custom).toBeChecked();

        await expect(axe).toHaveNoViolations();

        // Removing drops the tile and falls back to no wallpaper.
        await panel.getByRole("button", { name: "Remove" }).click();
        await expect(custom).not.toBeVisible();
        await expect(panel.getByRole("radio", { name: "None" })).toBeChecked();
    });

    test("renders the rail in the dark theme", async ({ page, app, user, util }) => {
        await rejectToast(page, "Verify this device");
        await util.disableSystemTheme();
        await app.settings.setValue("theme", null, SettingLevel.DEVICE, "dark");
        await util.openAppearanceTab();

        const panel = chatBackgroundPanel(page);
        await expect(panel).toBeVisible();
        await tile(page, "Diagonal").click();
        await expect(panel.getByRole("radio", { name: "Diagonal" })).toBeChecked();

        await panel.screenshot({ path: `${SHOTS}/chat-background-6-rail-dark.png` });
        await page.locator(".mx_SettingsTab").screenshot({ path: `${SHOTS}/chat-background-7-tab-dark.png` });
    });

    test("moves between tiles with the arrow keys", async ({ page, app, user, util }) => {
        await rejectToast(page, "Verify this device");
        await util.openAppearanceTab();

        const panel = chatBackgroundPanel(page);
        await panel.getByRole("radio", { name: "None" }).focus();

        // A native radio group is one tab stop that arrow keys walk. This is why the form is no longer remounted
        // on every pick: the remount destroyed focus and stopped the walk dead.
        await page.keyboard.press("ArrowRight");
        await expect(panel.getByRole("radio", { name: "Dots" })).toBeChecked();
        await expect(panel.getByRole("radio", { name: "Dots" })).toBeFocused();

        await page.keyboard.press("ArrowRight");
        await expect(panel.getByRole("radio", { name: "Grid" })).toBeChecked();
        await expect(panel.getByRole("radio", { name: "Grid" })).toBeFocused();
    });
});
