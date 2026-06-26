/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path, { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fs as memfs, vol } from "memfs";
import { dialog } from "electron";

import { type ConfigOptions, deepMergeConfig, getConfigCandidatePaths, loadMergedLocalConfig } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock("node:fs", () => ({ default: memfs }));
vi.mock("node:fs/promises", () => ({ default: memfs.promises }));

vi.mock("electron", () => ({
    app: {
        getPath: vi.fn().mockReturnValue("/Users/name/Library/Application Support/Element"),
        // loadConfig now routes through loadMergedLocalConfig, which derives candidate paths from the
        // build product name; provide it so the darwin/win32 machine-wide branch has a name to use.
        getName: vi.fn().mockReturnValue("Element"),
        whenReady: (): Promise<void> => Promise.resolve(),
    },
    dialog: {
        showMessageBox: vi.fn(),
    },
}));

beforeEach(() => {
    // Reset the state of the in-memory fs
    vol.reset();
});

describe("getConfigCandidatePaths", () => {
    it("returns only the explicit location, bypassing every fallback", () => {
        expect(
            getConfigCandidatePaths({
                platform: "darwin",
                userDataPath: "/Users/test/Library/Application Support/Element",
                productName: "Element",
                env: {},
                explicitLocation: "/custom/config.json",
            }),
        ).toEqual(["/custom/config.json"]);
    });

    it("prefers the per-user config over the macOS machine-wide path", () => {
        expect(
            getConfigCandidatePaths({
                platform: "darwin",
                userDataPath: "/Users/test/Library/Application Support/Element",
                productName: "Element",
                env: {},
            }),
        ).toEqual([
            path.join("/Users/test/Library/Application Support/Element", "config.json"),
            path.join("/Library/Application Support", "Element", "config.json"),
        ]);
    });

    it("uses the build product name for the macOS system path (white-label rebrands)", () => {
        const [, systemPath] = getConfigCandidatePaths({
            platform: "darwin",
            userDataPath: "/u",
            productName: "Acme Chat",
            env: {},
        });
        expect(systemPath).toBe(path.join("/Library/Application Support", "Acme Chat", "config.json"));
    });

    it("uses PROGRAMDATA for the Windows machine-wide path", () => {
        const [, systemPath] = getConfigCandidatePaths({
            platform: "win32",
            userDataPath: "C:\\u",
            productName: "Element",
            env: { PROGRAMDATA: "D:\\PD" },
        });
        expect(systemPath).toBe(path.join("D:\\PD", "Element", "config.json"));
    });

    it("falls back to C:\\ProgramData on Windows when PROGRAMDATA is unset", () => {
        const [, systemPath] = getConfigCandidatePaths({
            platform: "win32",
            userDataPath: "C:\\u",
            productName: "Element",
            env: {},
        });
        expect(systemPath).toBe(path.join("C:\\ProgramData", "Element", "config.json"));
    });

    it("uses /etc/element-desktop on Linux", () => {
        expect(
            getConfigCandidatePaths({
                platform: "linux",
                userDataPath: "/home/test/.config/Element",
                productName: "Element",
                env: {},
            }),
        ).toEqual([
            path.join("/home/test/.config/Element", "config.json"),
            path.join("/etc/element-desktop", "config.json"),
        ]);
    });
});

describe("deepMergeConfig", () => {
    it("merges nested objects key-by-key instead of clobbering", () => {
        expect(
            deepMergeConfig({ room_directory: { servers: ["a"], foo: 1 } }, { room_directory: { foo: 2 } }),
        ).toStrictEqual({ room_directory: { servers: ["a"], foo: 2 } });
    });

    it("merges independent nested sections from each side", () => {
        expect(
            deepMergeConfig(
                { features: { a: 1 }, setting_defaults: { x: 1 } },
                { features: { b: 2 }, element_call: { url: "u" } },
            ),
        ).toStrictEqual({ features: { a: 1, b: 2 }, setting_defaults: { x: 1 }, element_call: { url: "u" } });
    });

    it("replaces arrays rather than concatenating them", () => {
        expect(deepMergeConfig({ modules: ["a", "b"] }, { modules: ["c"] })).toStrictEqual({ modules: ["c"] });
    });

    it("lets the override primitive win, including explicit null", () => {
        expect(deepMergeConfig({ a: "old", b: "keep" }, { a: "new", c: null })).toStrictEqual({
            a: "new",
            b: "keep",
            c: null,
        });
    });

    it("replaces an object with a primitive and vice-versa on a type change", () => {
        expect(deepMergeConfig({ a: { nested: 1 } }, { a: "scalar" })).toStrictEqual({ a: "scalar" });
        expect(deepMergeConfig({ a: "scalar" }, { a: { nested: 1 } })).toStrictEqual({ a: { nested: 1 } });
    });

    it("does not mutate the base object", () => {
        const base = { room_directory: { servers: ["a"] } };
        deepMergeConfig(base, { room_directory: { servers: ["b"] } });
        expect(base).toStrictEqual({ room_directory: { servers: ["a"] } });
    });

    it("ignores prototype-polluting keys from untrusted config", () => {
        const malicious = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "safe": 1}');
        const result = deepMergeConfig({}, malicious);

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
        expect(result).toStrictEqual({ safe: 1 });
    });

    it("strips prototype-polluting keys nested in a one-sided subtree", () => {
        const malicious = JSON.parse('{"section": {"__proto__": {"polluted": true}, "ok": 1}}');
        const result = deepMergeConfig({}, malicious);

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(result.section, "__proto__")).toBe(false);
        expect(result).toStrictEqual({ section: { ok: 1 } });
    });
});

describe("loadMergedLocalConfig", () => {
    beforeEach(() => {
        vol.reset();
    });

    const darwinOpts = {
        platform: "darwin" as NodeJS.Platform,
        userDataPath: "/Users/test/Library/Application Support/Element",
        productName: "Element",
        env: {} as NodeJS.ProcessEnv,
    };

    const userPath = path.join("/Users/test/Library/Application Support/Element", "config.json");
    const systemPath = path.join("/Library/Application Support", "Element", "config.json");

    it("reads the machine-wide config when no per-user config exists", () => {
        vol.fromJSON({ [systemPath]: JSON.stringify({ default_server_name: "matrix.org", from: "system" }) });

        expect(loadMergedLocalConfig(darwinOpts)).toStrictEqual({
            default_server_name: "matrix.org",
            from: "system",
        });
    });

    it("lets the per-user config override the machine-wide one, keeping system-only keys", () => {
        vol.fromJSON({
            [systemPath]: JSON.stringify({ shared: "system", systemOnly: 1 }),
            [userPath]: JSON.stringify({ shared: "user", userOnly: 2 }),
        });

        expect(loadMergedLocalConfig(darwinOpts)).toStrictEqual({
            shared: "user",
            systemOnly: 1,
            userOnly: 2,
        });
    });

    it("deep-merges nested sections across the two layers", () => {
        vol.fromJSON({
            [systemPath]: JSON.stringify({ features: { a: 1 } }),
            [userPath]: JSON.stringify({ features: { b: 2 } }),
        });

        expect(loadMergedLocalConfig(darwinOpts)).toStrictEqual({ features: { a: 1, b: 2 } });
    });

    it("reads only the explicit location and ignores the system/user paths", () => {
        vol.fromJSON({
            [systemPath]: JSON.stringify({ from: "system" }),
            [userPath]: JSON.stringify({ from: "user" }),
            "/custom/config.json": JSON.stringify({ from: "explicit" }),
        });

        expect(loadMergedLocalConfig({ ...darwinOpts, explicitLocation: "/custom/config.json" })).toStrictEqual({
            from: "explicit",
        });
    });

    it("returns an empty object when no config file exists anywhere", () => {
        expect(loadMergedLocalConfig(darwinOpts)).toStrictEqual({});
    });

    it("skips a malformed machine-wide config and still loads the valid user config", () => {
        vol.fromJSON({
            [systemPath]: "{ this is not valid json",
            [userPath]: JSON.stringify({ from: "user" }),
        });

        expect(loadMergedLocalConfig(darwinOpts)).toStrictEqual({ from: "user" });
    });

    it("rethrows on a malformed user config (so the existing misconfigured dialog surfaces)", () => {
        vol.fromJSON({ [userPath]: "{ not json" });

        expect(() => loadMergedLocalConfig(darwinOpts)).toThrow();
    });

    it("rethrows on a malformed explicit config", () => {
        vol.fromJSON({ "/custom/config.json": "nope" });

        expect(() => loadMergedLocalConfig({ ...darwinOpts, explicitLocation: "/custom/config.json" })).toThrow();
    });
});

describe("loadConfig", () => {
    let loadConfig: (localConfigPath: string | undefined) => Promise<ConfigOptions>;

    beforeEach(async () => {
        vol.fromJSON(
            {
                "../webapp.asar/config.json": JSON.stringify({
                    web_base_url: "https://chat.org.com",
                    default_hs_url: "https://matrix.org.com",
                }),
            },
            __dirname,
        );

        vi.resetModules();
        ({ loadConfig } = await import("./config.js"));
    });

    it("should ignore localConfigPath if does not exist", async () => {
        const config = await loadConfig(resolve(__dirname, "../custom-config.json"));
        expect(config.brand).toBe("Element");
        expect(config.web_base_url).toBe("https://chat.org.com");
        expect(config.default_hs_url).toBe("https://matrix.org.com");
    });

    it("should read localConfigPath if exists", async () => {
        vol.fromJSON({
            "/home/custom-config.json": JSON.stringify({
                brand: "foobar",
            }),
        });

        const config = await loadConfig("/home/custom-config.json");
        expect(config.brand).toBe("foobar");
    });

    it("should load default local config if exists", async () => {
        vol.fromJSON({
            "/Users/name/Library/Application Support/Element/config.json": JSON.stringify({
                brand: "foobar",
            }),
        });

        const config = await loadConfig(undefined);
        expect(config.brand).toBe("foobar");
    });

    it("should apply defaults to any missing fields", async () => {
        vol.fromJSON({
            "/home/custom-config.json": JSON.stringify({
                brand: "foobar",
            }),
        });

        const config = await loadConfig("/home/custom-config.json");
        expect(config.help_url).toBe("https://element.io/help");
        expect(config.web_base_url).toBe("https://chat.org.com");
    });

    it("should support all config files missing", async () => {
        vol.reset();
        vol.fromJSON(
            {
                "../webapp.asar/version": "v1.2.3",
            },
            __dirname,
        );

        const config = await loadConfig(undefined);
        expect(config.help_url).toBe("https://element.io/help");
        expect(config.web_base_url).toBe("https://app.element.io/");
    });

    it("should handle key conflicts around default homeserver config", async () => {
        vol.fromJSON({
            "/home/custom-config.json": JSON.stringify({
                default_server_name: "other-org.com",
            }),
        });

        const config = await loadConfig("/home/custom-config.json");
        expect(config.default_server_name).toBe("other-org.com");
        expect(config.default_hs_url).toBeUndefined();
        expect(config.default_server_config).toBeUndefined();
    });

    it("should map module paths correctly", async () => {
        vol.fromJSON(
            {
                "../webapp.asar/config.json": JSON.stringify({
                    web_base_url: "https://chat.org.com",
                    default_hs_url: "https://matrix.org.com",
                    modules: ["/modules/banner", "module2"],
                }),
            },
            __dirname,
        );

        const config = await loadConfig("/home/custom-config.json");
        expect(config.help_url).toBe("https://element.io/help");
        expect(config.web_base_url).toBe("https://chat.org.com");
        expect(config.modules).toStrictEqual(["/webapp/modules/banner", "module2"]);
    });

    it("should show a dialog when encountering a SyntaxError", async () => {
        vol.fromJSON({
            "/home/custom-config.json": "NOT_JSON",
        });

        await loadConfig("/home/custom-config.json");
        expect(dialog.showMessageBox).toHaveBeenCalledWith({
            detail: "Unexpected token 'N', \"NOT_JSON\" is not valid JSON",
            message:
                "Your custom Element configuration contains invalid JSON. Please correct the problem and reopen Element.",
            title: "Your Element is misconfigured",
            type: "error",
        });
    });
});

describe("getConfig", () => {
    let loadConfig: (localConfigPath: string | undefined) => Promise<ConfigOptions>;
    let getConfig: () => ConfigOptions;

    beforeEach(async () => {
        vol.fromJSON(
            {
                "../webapp.asar/config.json": JSON.stringify({
                    web_base_url: "https://chat.org.com",
                }),
            },
            __dirname,
        );

        vi.resetModules();
        ({ loadConfig, getConfig } = await import("./config.js"));
    });

    it("should return undefined if loadConfig has not been called", () => {
        expect(getConfig()).toBeUndefined();
    });

    it("should return the config once it is loaded", async () => {
        const config = await loadConfig(undefined);
        expect(config.web_base_url).toBe("https://chat.org.com");
        expect(config).toStrictEqual(getConfig());
    });
});
