/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fs as memfs, vol } from "memfs";

import { deepMergeConfig, getConfigCandidatePaths, loadMergedLocalConfig } from "./config.js";

vi.mock("node:fs", () => ({ default: memfs }));
vi.mock("node:fs/promises", () => ({ default: memfs.promises }));

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
