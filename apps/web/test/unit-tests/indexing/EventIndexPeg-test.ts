/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Mocked } from "jest-mock";

import { EventIndexPeg } from "../../../src/indexing/EventIndexPeg";
import type BaseEventIndexManager from "../../../src/indexing/BaseEventIndexManager";
import { mockPlatformPeg } from "../../test-utils";
import { MatrixClientPeg } from "../../../src/MatrixClientPeg";
import SettingsStore from "../../../src/settings/SettingsStore";
import { SettingLevel } from "../../../src/settings/SettingLevel";

// Stub out EventIndex so initEventIndex doesn't spin up the real crawler.
jest.mock("../../../src/indexing/EventIndex", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        init: jest.fn().mockResolvedValue(undefined),
    })),
}));

const USER_ID = "@alice:example.org";
const DEVICE_ID = "DEVICE1";

function mockIndexManager(overrides: Record<string, jest.Mock> = {}): Mocked<BaseEventIndexManager> {
    return {
        supportsEventIndexing: jest.fn().mockResolvedValue(true),
        initEventIndex: jest.fn().mockResolvedValue(undefined),
        getUserVersion: jest.fn().mockResolvedValue(1),
        isEventIndexEmpty: jest.fn().mockResolvedValue(true),
        setUserVersion: jest.fn().mockResolvedValue(undefined),
        closeEventIndex: jest.fn().mockResolvedValue(undefined),
        deleteEventIndex: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Mocked<BaseEventIndexManager>;
}

describe("EventIndexPeg", () => {
    afterEach(() => jest.restoreAllMocks());

    beforeEach(() => {
        jest.spyOn(MatrixClientPeg, "get").mockReturnValue({
            getUserId: () => USER_ID,
            getDeviceId: () => DEVICE_ID,
        } as unknown as ReturnType<typeof MatrixClientPeg.get>);
    });

    it("passes the configured tokenizer mode through to initEventIndex (#32038)", async () => {
        const indexManager = mockIndexManager();
        mockPlatformPeg({ getEventIndexingManager: () => indexManager });
        const getValueAt = jest.spyOn(SettingsStore, "getValueAt").mockReturnValue("ngram");

        const ok = await new EventIndexPeg().initEventIndex();

        expect(ok).toBe(true);
        expect(getValueAt).toHaveBeenCalledWith(SettingLevel.DEVICE, "tokenizerMode");
        expect(indexManager.initEventIndex).toHaveBeenCalledWith(USER_ID, DEVICE_ID, "ngram");
    });

    it("re-applies the tokenizer mode on the user-version-0 recreate path", async () => {
        const indexManager = mockIndexManager({
            getUserVersion: jest.fn().mockResolvedValue(0),
            isEventIndexEmpty: jest.fn().mockResolvedValue(false),
        });
        mockPlatformPeg({ getEventIndexingManager: () => indexManager });
        jest.spyOn(SettingsStore, "getValueAt").mockReturnValue("ngram");

        await new EventIndexPeg().initEventIndex();

        expect(indexManager.initEventIndex).toHaveBeenCalledTimes(2);
        expect(indexManager.initEventIndex).toHaveBeenNthCalledWith(1, USER_ID, DEVICE_ID, "ngram");
        expect(indexManager.initEventIndex).toHaveBeenNthCalledWith(2, USER_ID, DEVICE_ID, "ngram");
    });

    it("defaults to the language tokenizer", async () => {
        const indexManager = mockIndexManager();
        mockPlatformPeg({ getEventIndexingManager: () => indexManager });
        jest.spyOn(SettingsStore, "getValueAt").mockReturnValue("language");

        await new EventIndexPeg().initEventIndex();

        expect(indexManager.initEventIndex).toHaveBeenCalledWith(USER_ID, DEVICE_ID, "language");
    });
});
