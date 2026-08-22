/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { access, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    ipcMain,
    nativeImage,
    Notification,
    type IpcMainEvent,
    type NativeImage,
    type NotificationConstructorOptions,
} from "electron";

// macOS resolves a named notification sound out of ~/Library/Sounds, and — despite what the
// Electron docs still say — not out of the app bundle at all, so the sound has to be installed
// there before it can be asked for. The name is the file's, without its extension.
const SOUND_NAME = "Element";
const SOUND_FILE = `${SOUND_NAME}.aiff`;
const SOUND_DIR = join(homedir(), "Library", "Sounds");

/**
 * Copies the bundled sound into ~/Library/Sounds so macOS can find it, unless it is already
 * there. Resolves false if it could not be installed, in which case the notification goes out
 * without naming a sound and macOS alerts in its own way.
 *
 * The file is checked rather than remembered: naming a sound macOS cannot find gets that name
 * cached as a failure for the rest of the login session, so an installation deleted underneath
 * a running app has to be repaired rather than assumed.
 */
async function installSound(): Promise<boolean> {
    const installed = join(SOUND_DIR, SOUND_FILE);
    try {
        await access(installed);
        return true;
    } catch {
        // Not installed yet, or no longer installed.
    }
    try {
        await mkdir(SOUND_DIR, { recursive: true });
        await copyFile(join(process.resourcesPath, SOUND_FILE), installed);
        return true;
    } catch (e) {
        console.error("Failed to install the notification sound", e);
        return false;
    }
}

const MAX_LIVE_NOTIFICATIONS = 64;

/** A request from the renderer to display one native notification. */
export interface ShowNotificationRequest {
    /** Renderer-assigned identifier, used to close this notification later. */
    id: number;
    title: string;
    body: string;
    /** `http(s)` URL of the sender's avatar, or `null` for no icon. */
    avatarUrl: string | null;
    /** Whether the operating system should sound this notification, subject to its own settings. */
    audible: boolean;
}

/** A command sent by the renderer over the `notification` channel. */
export type NotificationCommand =
    | { action: "show"; request: ShowNotificationRequest }
    | { action: "close"; id: number };

/** An event sent to the renderer over the `notificationEvent` channel. */
export interface NotificationEvent {
    id: number;
    action: "click" | "close";
}

const live = new Map<number, Notification | null>();

function emit(id: number, action: NotificationEvent["action"]): void {
    global.mainWindow?.webContents.send("notificationEvent", { id, action } satisfies NotificationEvent);
}

function evictOverflow(): void {
    while (live.size >= MAX_LIVE_NOTIFICATIONS) {
        const [oldest] = live.keys();
        const notification = live.get(oldest);
        live.delete(oldest);
        notification?.close();
        emit(oldest, "close");
    }
}

async function loadIcon(avatarUrl: string | null): Promise<NativeImage | undefined> {
    const session = global.mainWindow?.webContents.session;
    if (!avatarUrl || !session) return undefined;

    try {
        const resp = await session.fetch(avatarUrl);
        if (!resp.ok) return undefined;
        const icon = nativeImage.createFromBuffer(Buffer.from(await resp.arrayBuffer()));
        return icon.isEmpty() ? undefined : icon;
    } catch (e) {
        console.error("Failed to load notification icon", e);
        return undefined;
    }
}

/**
 * Displays a notification through the operating system's notification centre, so that the user's own
 * notification settings decide whether it is shown and whether it is audible.
 *
 * The avatar is fetched through the window's own {@link Electron.Session} rather than the main-process
 * global `fetch`, so that the authenticated-media interceptors apply. A failed or empty fetch degrades
 * to a notification with no icon rather than to no notification.
 */
export async function showNotification(request: ShowNotificationRequest): Promise<void> {
    if (!Notification.isSupported()) return;

    evictOverflow();
    live.set(request.id, null);

    const icon = await loadIcon(request.avatarUrl);
    if (!live.has(request.id)) return;

    const options: NotificationConstructorOptions = {
        title: request.title,
        body: request.body,
        icon,
        silent: !request.audible,
    };
    if (request.audible && process.platform === "darwin" && (await installSound())) {
        options.sound = SOUND_NAME;
    }
    const notification = new Notification(options);

    notification.on("click", () => emit(request.id, "click"));
    notification.on("close", () => {
        if (live.delete(request.id)) emit(request.id, "close");
    });
    notification.on("failed", (_ev, error) => {
        console.error(`Failed to display notification ${request.id}: ${error}`);
        if (live.delete(request.id)) emit(request.id, "close");
    });

    live.set(request.id, notification);
    notification.show();
}

/** Closes a previously shown notification, if it is still being tracked. */
export function closeNotification(id: number): void {
    const notification = live.get(id);
    live.delete(id);
    notification?.close();
}

ipcMain.on("notification", function (_ev: IpcMainEvent, command: NotificationCommand): void {
    switch (command.action) {
        case "show":
            showNotification(command.request).catch((e) => {
                console.error("Failed to display notification", e);
            });
            break;
        case "close":
            closeNotification(command.id);
            break;
    }
});
