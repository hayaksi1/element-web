/*
Copyright 2018-2025 New Vector Ltd.
Copyright 2017-2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Squirrel on windows starts the app with various flags as hooks to tell us when we've been installed/uninstalled etc.
import "./squirrelhooks.js";
import {
    app,
    BrowserWindow,
    Menu,
    autoUpdater,
    dialog,
    type Input,
    type Event,
    session,
    protocol,
    desktopCapturer,
    nativeTheme,
    screen,
} from "electron";
// eslint-disable-next-line n/file-extension-in-import
import * as Sentry from "@sentry/electron/main";
import path, { dirname } from "node:path";
import fs from "node:fs";
import { URL, fileURLToPath } from "node:url";
import minimist from "minimist";

import "./ipc.js";
import "./seshat.js";
import "./settings.js";
import "./badge.js";
import * as tray from "./tray.js";
import Store from "./store.js";
import { buildMenuTemplate } from "./vectormenu.js";
import webContentsHandler from "./webcontents-handler.js";
import * as updater from "./updater.js";
import ProtocolHandler from "./protocol.js";
import { _t, AppLocalization } from "./language-helper.js";
import { setDisplayMediaCallback } from "./displayMediaCallback.js";
import { WindowStateManager } from "./window-state.js";
import { shouldQuitAfterConfirm } from "./confirm-quit.js";
import { setupMacosTitleBar } from "./macos-titlebar.js";
import { type Json, type JsonObject, loadJsonFile } from "./utils.js";
import { deepMergeConfig, loadMergedLocalConfig } from "./config.js";
import { setupMediaAuth } from "./media-auth.js";
import { setupMediaPermissions } from "./media-permissions.js";
import { resolveBackgroundColor } from "./background-color.js";
import { resolveWindowCloseBehavior } from "./window-close.js";
import { getBuildConfig } from "./build-config.js";
import { getAsarPath } from "./asar.js";
import { getIconPath } from "./icon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = minimist(process.argv, {
    alias: { help: "h" },
});

if (argv["help"]) {
    console.log("Options:");
    console.log("  --profile-dir {path}: Path to where to store the profile.");
    console.log(
        `  --profile {name}:     Name of alternate profile to use, allows for running multiple accounts.\n` +
            `                         Ignored if --profile-dir is specified.\n` +
            `                         The ELEMENT_PROFILE_DIR environment variable may be used to change the default profile path.\n` +
            `                         It is overridden by --profile-dir, but can be combined with --profile.`,
    );
    console.log("  --devtools:           Install and use react-devtools and react-perf.");
    console.log(
        `  --config:             Path to the config.json file. May also be specified via the ELEMENT_DESKTOP_CONFIG_JSON environment variable.\n` +
            `                         Otherwise use the default user location '${app.getPath("userData")}'`,
    );
    console.log("  --no-update:          Disable automatic updating.");
    console.log("  --hidden:             Start the application hidden in the system tray.");
    console.log("  --help:               Displays this help message.");
    console.log("And more such as --proxy, see: https://electronjs.org/docs/api/command-line-switches");
    app.exit();
}

const LocalConfigLocation = process.env.ELEMENT_DESKTOP_CONFIG_JSON ?? argv["config"];
const LocalConfigFilename = "config.json";

// Electron creates the user data directory (with just an empty 'Dictionaries' directory...)
// as soon as the app path is set, so pick a random path in it that must exist if it's a
// real user data directory.
function isRealUserDataDir(d: string): boolean {
    return fs.existsSync(path.join(d, "IndexedDB"));
}

const buildConfig = getBuildConfig();
const protocolHandler = new ProtocolHandler(buildConfig.protocol);

// check if we are passed a profile in the SSO callback url
let userDataPath: string;

const userDataPathInProtocol = protocolHandler.getProfileFromDeeplink(argv["_"]);
if (userDataPathInProtocol) {
    userDataPath = userDataPathInProtocol;
} else if (argv["profile-dir"]) {
    userDataPath = argv["profile-dir"];
} else {
    let newUserDataPath = process.env.ELEMENT_PROFILE_DIR ?? app.getPath("userData");
    if (argv["profile"]) {
        newUserDataPath += "-" + argv["profile"];
    }
    const newUserDataPathExists = isRealUserDataDir(newUserDataPath);
    let oldUserDataPath = path.join(app.getPath("appData"), app.getName().replace("Element", "Riot"));
    if (argv["profile"]) {
        oldUserDataPath += "-" + argv["profile"];
    }

    const oldUserDataPathExists = isRealUserDataDir(oldUserDataPath);
    console.log(newUserDataPath + " exists: " + (newUserDataPathExists ? "yes" : "no"));
    console.log(oldUserDataPath + " exists: " + (oldUserDataPathExists ? "yes" : "no"));
    if (!newUserDataPathExists && oldUserDataPathExists) {
        console.log("Using legacy user data path: " + oldUserDataPath);
        userDataPath = oldUserDataPath;
    } else {
        userDataPath = newUserDataPath;
    }
}
app.setPath("userData", userDataPath);

const homeserverProps = ["default_is_url", "default_hs_url", "default_server_name", "default_server_config"] as const;

function loadLocalConfigFile(): Json {
    // Read config from (in precedence order) an explicit ELEMENT_DESKTOP_CONFIG_JSON/--config path,
    // else the per-user userData config, else a machine-wide path for MDM/enterprise deployments.
    // See config.ts and element-web#32351.
    return loadMergedLocalConfig({
        platform: process.platform,
        userDataPath: app.getPath("userData"),
        productName: app.getName(),
        env: process.env,
        explicitLocation: LocalConfigLocation,
    });
}

let loadConfigPromise: Promise<void> | undefined;
// Loads the config from asar, and applies a config.json from userData atop if one exists
// Writes config to `global.vectorConfig`. Idempotent, returns the same promise on subsequent calls.
function loadConfig(): Promise<void> {
    if (loadConfigPromise) return loadConfigPromise;

    async function actuallyLoadConfig(): Promise<void> {
        const asarPath = await getAsarPath();

        try {
            console.log(`Loading app config: ${path.join(asarPath, LocalConfigFilename)}`);
            global.vectorConfig = loadJsonFile(asarPath, LocalConfigFilename);
        } catch {
            // it would be nice to check the error code here and bail if the config
            // is unparsable, but we get MODULE_NOT_FOUND in the case of a missing
            // file or invalid json, so node is just very unhelpful.
            // Continue with the defaults (ie. an empty config)
            global.vectorConfig = {};
        }

        try {
            // Load local config and use it to override values from the one baked with the build
            const localConfig = loadLocalConfigFile();

            // If the local config has a homeserver defined, don't use the homeserver from the build
            // config. This is to avoid a problem where Riot thinks there are multiple homeservers
            // defined, and panics as a result.
            if (Object.keys(localConfig).find((k) => homeserverProps.includes(<any>k))) {
                // Rip out all the homeserver options from the vector config
                global.vectorConfig = Object.keys(global.vectorConfig)
                    .filter((k) => !homeserverProps.includes(<any>k))
                    .reduce(
                        (obj, key) => {
                            obj[key] = global.vectorConfig[key];
                            return obj;
                        },
                        {} as Omit<Partial<(typeof global)["vectorConfig"]>, keyof typeof homeserverProps>,
                    );
            }

            // Deep-merge so nested config sections (room_directory, features, setting_defaults,
            // element_call, …) merge rather than being clobbered by a shallow Object.assign.
            global.vectorConfig = deepMergeConfig(global.vectorConfig, localConfig as JsonObject);
        } catch (e) {
            if (e instanceof SyntaxError) {
                await app.whenReady();
                void dialog.showMessageBox({
                    type: "error",
                    title: `Your ${global.vectorConfig.brand || "Element"} is misconfigured`,
                    message:
                        `Your custom ${global.vectorConfig.brand || "Element"} configuration contains invalid JSON. ` +
                        `Please correct the problem and reopen ${global.vectorConfig.brand || "Element"}.`,
                    detail: e.message || "",
                });
            }

            // Could not load local config, this is expected in most cases.
        }

        // Tweak modules paths as they assume the root is at the same level as webapp, but for `vector://vector/webapp` it is not.
        if (Array.isArray(global.vectorConfig.modules)) {
            global.vectorConfig.modules = global.vectorConfig.modules.map((m) => {
                if (m.startsWith("/")) {
                    return "/webapp" + m;
                }
                return m;
            });
        }
    }
    loadConfigPromise = actuallyLoadConfig();
    return loadConfigPromise;
}

// Configure Electron Sentry and crashReporter using sentry.dsn in config.json if one is present.
async function configureSentry(): Promise<void> {
    await loadConfig();
    const { dsn, environment } = global.vectorConfig.sentry || {};
    if (dsn) {
        console.log(`Enabling Sentry with dsn=${dsn} environment=${environment}`);
        Sentry.init({
            dsn,
            environment,
            // We don't actually use this IPC, but we do not want Sentry injecting preloads
            ipcMode: Sentry.IPCMode.Classic,
        });
    }
}

global.appQuitting = false;

const exitShortcuts: Array<(input: Input, platform: string) => boolean> = [
    (input, platform): boolean => platform !== "darwin" && input.alt && input.key.toUpperCase() === "F4",
    (input, platform): boolean => platform !== "darwin" && input.control && input.key.toUpperCase() === "Q",
    (input, platform): boolean =>
        platform === "darwin" && input.meta && !input.control && input.key.toUpperCase() === "Q",
];

void configureSentry();

// handle uncaught errors otherwise it displays
// stack traces in popup dialogs, which is terrible (which
// it will do any time the auto update poke fails, and there's
// no other way to catch this error).
// Assuming we generally run from the console when developing,
// this is far preferable.
process.on("uncaughtException", function (error: Error): void {
    console.log("Unhandled exception", error);
});

app.commandLine.appendSwitch("--enable-usermedia-screen-capturing");
if (!app.commandLine.hasSwitch("enable-features")) {
    app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    console.log("Other instance detected: exiting");
    app.exit();
}

// do this after we know we are the primary instance of the app
protocolHandler.initialise(userDataPath);

// Register the scheme the app is served from as 'standard'
// which allows things like relative URLs and IndexedDB to
// work.
// Also mark it as secure (ie. accessing resources from this
// protocol and HTTPS won't trigger mixed content warnings).
protocol.registerSchemesAsPrivileged([
    {
        scheme: "vector",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
        },
    },
]);

// Turn the sandbox on for *all* windows we might generate. Doing this means we don't
// have to specify a `sandbox: true` to each BrowserWindow.
//
// This also fixes an issue with window.open where if we only specified the sandbox
// on the main window we'd run into cryptic "ipc_renderer be broke" errors. Turns out
// it's trying to jump the sandbox and make some calls into electron, which it can't
// do when half of it is sandboxed. By turning on the sandbox for everything, the new
// window (no matter how temporary it may be) is also sandboxed, allowing for a clean
// transition into the user's browser.
app.enableSandbox();

// We disable media controls here. We do this because calls use audio and video elements and they sometimes capture the media keys. See https://github.com/vector-im/element-web/issues/15704
app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling,MediaSessionService");

const store = Store.initialize(argv["storage-mode"]); // must be called before any async actions

// Disable hardware acceleration if the setting has been set.
if (store.get("disableHardwareAcceleration")) {
    console.log("Disabling hardware acceleration.");
    app.disableHardwareAcceleration();
}

app.on("ready", async () => {
    console.debug("Reached Electron ready state");

    let asarPath: string;

    try {
        asarPath = await getAsarPath();
        await loadConfig();
    } catch (e) {
        console.log("App setup failed: exiting", e);
        process.exit(1);
        // process.exit doesn't cause node to stop running code immediately,
        // so return (we could let the exception propagate but then we end up
        // with node printing all sorts of stuff about unhandled exceptions
        // when we want the actual error to be as obvious as possible).
        return;
    }

    if (argv["devtools"]) {
        try {
            const { installExtension, REACT_DEVELOPER_TOOLS } = await import("electron-devtools-installer");
            installExtension(REACT_DEVELOPER_TOOLS)
                .then((ext) => console.log(`Added Extension: ${ext.name}`))
                .catch((err: unknown) => console.log("An error occurred: ", err));
        } catch (e) {
            console.log(e);
        }
    }

    protocol.registerFileProtocol("vector", (request, callback) => {
        if (request.method !== "GET") {
            callback({ error: -322 }); // METHOD_NOT_SUPPORTED from chromium/src/net/base/net_error_list.h
            return null;
        }

        const parsedUrl = new URL(request.url);
        if (parsedUrl.protocol !== "vector:") {
            callback({ error: -302 }); // UNKNOWN_URL_SCHEME
            return;
        }
        if (parsedUrl.host !== "vector") {
            callback({ error: -105 }); // NAME_NOT_RESOLVED
            return;
        }

        const target = parsedUrl.pathname.split("/");

        // path starts with a '/'
        if (target[0] !== "") {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }

        if (target[target.length - 1] == "") {
            target[target.length - 1] = "index.html";
        }

        let baseDir: string;
        if (target[1] === "webapp") {
            baseDir = asarPath;
        } else {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }

        // Normalise the base dir and the target path separately, then make sure
        // the target path isn't trying to back out beyond its root
        baseDir = path.normalize(baseDir);

        const relTarget = path.normalize(path.join(...target.slice(2)));
        if (relTarget.startsWith("..")) {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }
        const absTarget = path.join(baseDir, relTarget);

        callback({
            path: absTarget,
        });
    });

    // Minimist parses `--no-`-prefixed arguments as booleans with value `false` rather than verbatim.
    if (argv["update"] === false) {
        console.log("Auto update disabled via command line flag");
    } else if (global.vectorConfig["update_base_url"]) {
        void updater.start(global.vectorConfig["update_base_url"]);
    } else {
        console.log("No update_base_url is defined: auto update is disabled");
    }

    // Route the menu and tray Quit items through the same warn-before-exit decision as the ⌘Q/Ctrl+Q
    // keyboard path (#32287). Must be set before AppLocalization builds the initial menus below.
    tray.setQuitHandler(confirmAndQuit);

    // Set up i18n before loading storage as we need translations for dialogs
    global.appLocalization = new AppLocalization({
        components: [
            (): void => tray.initApplicationMenu(),
            (): void => Menu.setApplicationMenu(buildMenuTemplate(confirmAndQuit)),
        ],
        store,
    });

    // Load the previous window state (size/position/maximized) with fallback to defaults, clamped to
    // the displays currently connected. See window-state.ts (#32228 / #32360).
    const windowState = new WindowStateManager();
    const restoreState = windowState.getRestoreState(screen.getAllDisplays());

    console.debug("Opening main window");
    const preloadScript = path.normalize(`${__dirname}/preload.cjs`);
    global.mainWindow = new BrowserWindow({
        // An opaque background avoids blurry font rendering
        // (https://www.electronjs.org/docs/faq#the-font-looks-blurry-what-is-this-and-what-can-i-do)
        // and paints the window in the user's theme colour before the web app's CSS loads,
        // avoiding the white launch flash (https://github.com/element-hq/element-web/issues/32260).
        backgroundColor: resolveBackgroundColor(store.get("backgroundColor"), nativeTheme.shouldUseDarkColors),

        titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
        trafficLightPosition: { x: 9, y: 8 },

        icon: await getIconPath(),
        show: false,
        autoHideMenuBar: store.get("autoHideMenuBar"),

        x: restoreState.bounds.x,
        y: restoreState.bounds.y,
        width: restoreState.bounds.width,
        height: restoreState.bounds.height,
        webPreferences: {
            preload: preloadScript,
            nodeIntegration: false,
            //sandbox: true, // We enable sandboxing from app.enableSandbox() above
            contextIsolation: true,
            webgl: true,
        },
    });

    global.mainWindow.setContentProtection(store.get("enableContentProtection"));

    try {
        console.debug("Ensuring storage is ready");
        if (!(await store.prepareSafeStorage(global.mainWindow.webContents.session))) return;
    } catch (e) {
        console.error(e);
        app.exit(1);
    }

    void global.mainWindow.loadURL("vector://vector/webapp/");

    if (process.platform === "darwin") {
        setupMacosTitleBar(global.mainWindow);
    }

    // Handle spellchecker
    // For some reason spellCheckerEnabled isn't persisted, so we have to use the store here
    global.mainWindow.webContents.session.setSpellCheckerEnabled(store.get("spellCheckerEnabled", true));

    // Create trayIcon icon
    if (store.get("minimizeToTray")) await tray.create();

    global.mainWindow.once("ready-to-show", () => {
        if (!global.mainWindow) return;

        // Now the window exists, restore the maximized state and start tracking changes. Fullscreen
        // is deliberately not restored so the app never auto-starts fullscreen (#32360).
        if (restoreState.isMaximized) global.mainWindow.maximize();
        windowState.monitor(global.mainWindow);

        if (!argv["hidden"]) {
            global.mainWindow.show();
        } else {
            // hide here explicitly because maximize() above can show the window
            global.mainWindow.hide();
        }
    });

    global.mainWindow.webContents.on("before-input-event", (event: Event, input: Input): void => {
        const exitShortcutPressed =
            input.type === "keyDown" && exitShortcuts.some((shortcutFn) => shortcutFn(input, process.platform));

        // We only care about the exit shortcuts here
        if (!exitShortcutPressed || !global.mainWindow) return;

        // Prevent the default behaviour (this also suppresses the menu's Quit accelerator, so the
        // menu Quit item's click handler never double-fires for the same keypress).
        event.preventDefault();

        // Ask the user if they really want to exit, honouring the warn-before-exit setting. The same
        // decision drives the menu/tray Quit items via confirmAndQuit().
        if (!shouldQuitAfterConfirm({ warnBeforeExit: store.shouldWarnBeforeExit(), confirm: confirmQuit })) return;

        // Persist the window geometry before exiting: app.exit() terminates immediately and fires no
        // `close` event, so the close-handler flush below would otherwise be skipped on this path.
        windowState.persist(global.mainWindow);

        // Exit the app
        app.exit();
    });

    global.mainWindow.on("closed", () => {
        global.mainWindow = null;
    });
    global.mainWindow.on("close", async (e) => {
        // Capture the final geometry synchronously while the window is still alive — this is the only
        // reliable flush on the macOS hide-on-close path (where `closed` never fires) and also picks up
        // any geometry change still sitting in the debounce when the user quits. See window-state.ts.
        windowState.persist(global.mainWindow!);

        const behavior = resolveWindowCloseBehavior({
            appQuitting: global.appQuitting,
            hasTray: tray.hasTray(),
            platform: process.platform,
        });

        // A real quit is in progress (or there is nothing to hide to): let the window actually close,
        // which on this single-window app cascades into `window-all-closed` → `app.quit()`.
        if (behavior === "quit") return;

        // On macOS we hide the whole *app* (⌘W ≡ ⌘H, #32267) rather than just the window: hiding only
        // the window leaves Element frontmost with an empty menu bar and no window (a "limbo state"),
        // whereas hiding the app activates another app — you bring Element back via the dock icon.
        // Elsewhere (with a tray) we hide the window to minimise to tray.
        e.preventDefault();
        const hide = behavior === "hide-app" ? (): void => app.hide() : (): void => global.mainWindow?.hide();

        if (global.mainWindow?.isFullScreen()) {
            global.mainWindow.once("leave-full-screen", hide);

            global.mainWindow.setFullScreen(false);
        } else {
            hide();
        }

        return false;
    });

    if (process.platform === "win32") {
        // Handle forward/backward mouse buttons in Windows
        global.mainWindow.on("app-command", (e, cmd) => {
            if (cmd === "browser-backward" && global.mainWindow?.webContents.canGoBack()) {
                global.mainWindow.webContents.goBack();
            } else if (cmd === "browser-forward" && global.mainWindow?.webContents.canGoForward()) {
                global.mainWindow.webContents.goForward();
            }
        });
    }

    webContentsHandler(global.mainWindow.webContents);

    session.defaultSession.setDisplayMediaRequestHandler(
        (_, callback) => {
            if (process.env.XDG_SESSION_TYPE === "wayland") {
                // On Wayland, calling getSources() opens the xdg-desktop-portal picker.
                // The user can only select a single source there, so Electron will return an array with exactly one entry.
                desktopCapturer
                    .getSources({ types: ["screen", "window"] })
                    .then((sources) => {
                        callback({ video: sources[0] });
                    })
                    .catch((err) => {
                        // If the user cancels the dialog an error occurs "Failed to get sources"
                        console.error("Wayland: failed to get user-selected source:", err);
                        callback({ video: { id: "", name: "" } }); // The promise does not return if no dummy is passed here as source
                    });
            } else {
                global.mainWindow?.webContents.send("openDesktopCapturerSourcePicker");
            }
            setDisplayMediaCallback(callback);
        },
        { useSystemPicker: true },
    ); // Use Mac OS 15+ native picker

    setupMediaAuth(global.mainWindow);
    setupMediaPermissions();
});

app.on("window-all-closed", () => {
    app.quit();
});

app.on("activate", () => {
    global.mainWindow?.show();
});

/**
 * Shows the "are you sure you want to quit?" confirmation, returning true if the user chose to
 * proceed. Shared by every quit entry point so they all present the same dialog. Returns true
 * (proceed) when there is no window to parent the dialog to.
 */
function confirmQuit(): boolean {
    if (!global.mainWindow) return true;
    return (
        dialog.showMessageBoxSync(global.mainWindow, {
            type: "question",
            buttons: [
                _t("action|cancel"),
                _t("action|close_brand", {
                    brand: global.vectorConfig.brand || "Element",
                }),
            ],
            message: _t("confirm_quit"),
            defaultId: 1,
            cancelId: 0,
        }) !== 0
    );
}

/**
 * Quit entry point for the app/File-menu Quit item and the tray Quit item. Honours the
 * warn-before-exit setting exactly like the ⌘Q/Ctrl+Q keyboard path, so File→Quit and tray Quit no
 * longer silently bypass the confirmation on the platforms where it is the default (Windows/Linux).
 * Uses app.quit() (not app.exit()) so the window `close` handler still runs and persists the window
 * geometry. See element-web#32287.
 */
function confirmAndQuit(): void {
    if (shouldQuitAfterConfirm({ warnBeforeExit: store.shouldWarnBeforeExit(), confirm: confirmQuit })) {
        app.quit();
    }
}

function beforeQuit(): void {
    global.appQuitting = true;
    global.mainWindow?.webContents.send("before-quit");
}

app.on("before-quit", beforeQuit);
autoUpdater.on("before-quit-for-update", beforeQuit);

app.on("second-instance", (ev, commandLine, workingDirectory) => {
    // If other instance launched with --hidden then skip showing window
    if (commandLine.includes("--hidden")) return;

    // Someone tried to run a second instance, we should focus our window.
    if (global.mainWindow) {
        // On macOS the window may have been hidden via app.hide() (the ⌘W/close path, #32267).
        // app.hide() is an NSApplication-level hide that does NOT clear BrowserWindow.isVisible(),
        // so the isVisible() guard below can't detect it — un-hide the app first (no-op if not hidden).
        if (process.platform === "darwin") app.show();
        if (!global.mainWindow.isVisible()) global.mainWindow.show();
        if (global.mainWindow.isMinimized()) global.mainWindow.restore();
        global.mainWindow.focus();
    }
});

// This is required to make notification handlers work
// on Windows 8.1/10/11 (and is a noop on other platforms);
// It must also match the ID found in 'electron-builder'
// in order to get the title and icon to show up correctly.
// Ref: https://stackoverflow.com/a/77314604/3525780
app.setAppUserModelId(buildConfig.appId);
