/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path from "node:path";

import { type Json, type JsonObject, loadJsonFile } from "./utils.js";

export function getBrand(): string {
    return global.vectorConfig.brand || "Element";
}

export const LocalConfigFilename = "config.json";

export interface ConfigPathOptions {
    /** `process.platform` */
    platform: NodeJS.Platform;
    /** `app.getPath("userData")` */
    userDataPath: string;
    /** `app.getName()` — the build-time product name, NOT the runtime `vectorConfig.brand` */
    productName: string;
    /** `process.env` — used for `PROGRAMDATA` on Windows */
    env: NodeJS.ProcessEnv;
    /** `ELEMENT_DESKTOP_CONFIG_JSON ?? argv["config"]`, if any */
    explicitLocation?: string;
}

/**
 * Returns the ordered list of candidate `config.json` paths, highest precedence first.
 *
 * - An explicit location (`ELEMENT_DESKTOP_CONFIG_JSON` / `--config`) WINS and bypasses every
 *   fallback: it is returned as the only candidate (preserves the prior single-source behaviour).
 * - Otherwise the per-user `userData` config takes precedence over the machine-wide (MDM/enterprise)
 *   config, which is read when no per-user config exists (element-web#32351):
 *     - macOS:   `/Library/Application Support/<productName>/config.json`
 *     - Windows: `%PROGRAMDATA%\<productName>\config.json` (default `C:\ProgramData`)
 *     - Linux:   `/etc/element-desktop/config.json`
 */
export function getConfigCandidatePaths(opts: ConfigPathOptions): string[] {
    if (opts.explicitLocation) {
        return [opts.explicitLocation];
    }

    const userConfig = path.join(opts.userDataPath, LocalConfigFilename);

    let systemConfig: string;
    switch (opts.platform) {
        case "darwin":
            systemConfig = path.join("/Library/Application Support", opts.productName, LocalConfigFilename);
            break;
        case "win32":
            systemConfig = path.join(opts.env.PROGRAMDATA ?? "C:\\ProgramData", opts.productName, LocalConfigFilename);
            break;
        default:
            // Linux uses a fixed FHS path (not productName-derived like mac/Windows): stable, Nightly and
            // white-label builds all read /etc/element-desktop/config.json. This is intentional — there is
            // no Linux convention for per-variant /etc dirs, and deployments target one well-known path.
            systemConfig = path.join("/etc/element-desktop", LocalConfigFilename);
            break;
    }

    return [userConfig, systemConfig];
}

// JSON.parse can produce an own "__proto__" key (and "constructor"/"prototype"); merging those would
// pollute Object.prototype. Skip them when merging untrusted (machine-wide/user) config.
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `override` onto `base`, returning a NEW object.
 *
 * - Plain objects merge key-by-key recursively, so nested config sections (`room_directory`,
 *   `features`, `setting_defaults`, `element_call`, …) are merged rather than clobbered — unlike the
 *   prior shallow `Object.assign`.
 * - Arrays and primitives REPLACE (override wins); arrays are never concatenated.
 * - Dangerous keys (`__proto__`, `prototype`, `constructor`) are dropped at every depth to avoid
 *   prototype pollution from untrusted (machine-wide/user) config.
 */
export function deepMergeConfig(base: JsonObject, override: JsonObject): JsonObject {
    const out: JsonObject = { ...base };

    for (const key of Object.keys(override)) {
        if (FORBIDDEN_KEYS.has(key)) continue;

        const overrideVal = override[key];
        const baseVal = out[key];
        if (isPlainObject(overrideVal)) {
            // Recurse even when the base lacks a matching object, so forbidden keys nested in a
            // one-sided subtree (an object present only in the override) are still stripped at depth.
            out[key] = deepMergeConfig(isPlainObject(baseVal) ? baseVal : {}, overrideVal);
        } else {
            out[key] = overrideVal;
        }
    }

    return out;
}

/**
 * Loads and deep-merges every local config layer in precedence order, or the single explicit
 * location when one is given. Higher-precedence layers (per-user `userData`) override lower ones
 * (machine-wide). Missing files are skipped (`loadJsonFile` returns `{}`).
 *
 * A malformed machine-wide (MDM) config is skipped (and logged) rather than aborting the whole load —
 * it is an admin-managed file the user cannot fix, and it must not discard the user's own valid config
 * or trigger the "your configuration contains invalid JSON" dialog. Only the user-controlled primary
 * config (explicit `--config`/`ELEMENT_DESKTOP_CONFIG_JSON`, else the per-user `userData` config)
 * rethrows on malformed JSON, preserving that existing user-facing dialog.
 */
export function loadMergedLocalConfig(opts: ConfigPathOptions): JsonObject {
    // Candidates are highest precedence first; apply lowest precedence first so higher layers override.
    const candidates = getConfigCandidatePaths(opts);
    const primary = candidates[0];
    let merged: JsonObject = {};
    for (const candidate of [...candidates].reverse()) {
        let layer: Json;
        try {
            layer = loadJsonFile<Json>(candidate);
        } catch (e) {
            if (candidate === primary) throw e;
            console.error(`Ignoring malformed config at ${candidate}`, e);
            continue;
        }
        if (isPlainObject(layer)) {
            merged = deepMergeConfig(merged, layer);
        }
    }
    return merged;
}
