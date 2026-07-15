/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { rejectToast } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { SettingLevel } from "../../../src/settings/SettingLevel";

// End-to-end coverage for the fork's Telegram-style in-room message search UX: the room-header search
// button (to the left of the call buttons), the Ctrl/Cmd+F shortcut, and a real search returning a
// matching message. These are the paths the user asked to have proven with Playwright.
test.describe("In-room message search (fork search UX)", () => {
    test.use({ displayName: "Sakura" });

    test.beforeEach(async ({ page, app, user }) => {
        // Dismiss the toasts that otherwise sit over the room header / search bar.
        await rejectToast(page, "Verify this device").catch(() => {});
        await rejectToast(page, "Notifications").catch(() => {});
    });

    test("the room-header search button opens the search bar", async ({ page, app }) => {
        await app.client.createRoom({ name: "Search via button" });
        await app.viewRoomByName("Search via button");

        const header = page.locator(".mx_RoomHeader");
        const searchButton = header.getByRole("button", { name: "Search" });
        await expect(searchButton).toBeVisible();
        await searchButton.click();

        // The Telegram-style bar replaces the header; its searchbox is present and focused.
        // (Assert on the class + input name rather than data-testid: the production bundle served here
        // does not emit this element's data-testid, though it renders the element itself fine.)
        await expect(page.locator(".mx_RoomSearchHeader")).toBeVisible({ timeout: 10000 });
        await expect(page.locator('input[name="room_message_search"]')).toBeFocused();
    });

    test("Ctrl/Cmd+F opens the search bar", async ({ page, app }) => {
        // On web the shortcut is opt-in (it defaults on only for the desktop app, where Seshat makes
        // encrypted search work and there is no browser find-bar to clash with). Enable it here so the
        // shortcut the desktop app ships with can be exercised.
        await app.settings.setValue("ctrlFForSearch", null, SettingLevel.DEVICE, true);

        await app.client.createRoom({ name: "Search via shortcut" });
        await app.viewRoomByName("Search via shortcut");

        // Put focus inside the room (the composer) so the key event reaches the app's global room
        // keybinding handler rather than a toast/dialog; the handler lives at the top of the app.
        await page.locator(".mx_BasicMessageComposer_input").click();
        await page.keyboard.press("ControlOrMeta+f");

        await expect(page.locator(".mx_RoomSearchHeader")).toBeVisible({ timeout: 10000 });
        await expect(page.locator('input[name="room_message_search"]')).toBeFocused();
    });

    test("searching returns a matching message", async ({ page, app }) => {
        const roomId = await app.client.createRoom({ name: "Search results" });
        await app.viewRoomByName("Search results");
        await app.client.sendMessage(roomId, "the quick brown wombat jumps over the lazy dog");

        await page.locator(".mx_RoomHeader").getByRole("button", { name: "Search" }).click();

        const input = page.locator('input[name="room_message_search"]');
        await input.fill("wombat");
        await input.press("Enter");

        // "N results found for "wombat"" summary, then the matching message surfaced in the results.
        await expect(page.locator(".mx_RoomSearchHeader_summary")).toContainText("result", {
            timeout: 20000,
        });
        await expect(page.getByText("the quick brown wombat jumps over the lazy dog").first()).toBeVisible({
            timeout: 20000,
        });
    });
});
