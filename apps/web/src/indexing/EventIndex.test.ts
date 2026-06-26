/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mock, type Mocked } from "vitest";
import {
    Direction,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    type Room,
    type RoomState,
    ClientEvent,
    RoomEvent,
    RoomStateEvent,
    EventType,
    HTTPError,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import EventIndex from "./EventIndex.ts";
import {
    emitPromise,
    flushPromises,
    getMockClientWithEventEmitter,
    mockClientMethodsRooms,
    mockPlatformPeg,
} from "../../test/test-utils";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import { type ICrawlerCheckpoint } from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";
import { logErrorAndShowErrorDialog } from "../utils/ErrorUtils.tsx";
import type * as ErrorUtilsModule from "../utils/ErrorUtils.tsx";

vi.mock("../utils/ErrorUtils.tsx", async () => ({
    ...(await vi.importActual<typeof ErrorUtilsModule>("../utils/ErrorUtils.tsx")),
    logErrorAndShowErrorDialog: vi.fn(),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndex", () => {
    it("crawls through the loaded checkpoints", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        let changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;

        indexer.startCrawler();

        // Mock out the /messags request, and wait for the crawler to hit the first room
        const mock1 = mockCreateMessagesRequest(mockClient);
        let changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room1:id");

        await mock1.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room1:id", "token1", 100, "b");

        // Continue, and wait for the crawler to hit the second room
        changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;
        mock1.resolve({ chunk: [] });
        changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room2:id");

        // Mock out the /messages request again, and wait for it to be called
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
    });

    it("adds checkpoints for the encrypted rooms after the first sync", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = {
            roomId: "!room1:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "token1",
            }),
        } as any as Room;
        const room2 = {
            roomId: "!room2:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "token2",
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room1, room2]),
        });

        const commitLiveEventsCalled = Promise.withResolvers<void>();
        mockIndexingManager.commitLiveEvents.mockImplementation(async () => {
            commitLiveEventsCalled.resolve();
        });

        const indexer = new EventIndex();
        await indexer.init();

        // During the first sync, some events are added to the index, meaning that `isEventIndexEmpty` will now be false.
        mockIndexingManager.isEventIndexEmpty.mockResolvedValue(false);

        // The first sync completes:
        mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});

        // Wait for `commitLiveEvents` to be called, by which time the checkpoints should have been added.
        await commitLiveEventsCalled.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(4);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Forward,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Forward,
        });
    });

    describe("when the sync handler throws (#33501)", () => {
        /**
         * Build an indexer whose `commitLiveEvents` always rejects, so that the `onSync`
         * handler throws on every sync. Returns the indexer and the mock client.
         */
        async function setUpFailingIndexer(): Promise<{ indexer: EventIndex; mockClient: Mocked<MatrixClient> }> {
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue([]),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                commitLiveEvents: vi.fn().mockRejectedValue(new Error("indexer boom")),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                // Crypto not ready, so the reconciliation pass is deferred and the
                // failure here comes from `commitLiveEvents` (the indexer throw), not
                // from `getCrypto` being undefined.
                getCrypto: vi.fn().mockReturnValue(undefined),
                ...mockClientMethodsRooms([]),
            });

            const indexer = new EventIndex();
            await indexer.init();
            // Don't actually start the background crawler loop (avoids real timers in the test).
            vi.spyOn(indexer, "startCrawler").mockImplementation(() => {});

            return { indexer, mockClient };
        }

        it("only shows the error dialog once even if syncs keep failing", async () => {
            vi.mocked(logErrorAndShowErrorDialog).mockClear();
            const { mockClient } = await setUpFailingIndexer();

            // First failing sync: the user should be told once.
            mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
            await flushPromises();
            expect(logErrorAndShowErrorDialog).toHaveBeenCalledTimes(1);

            // Subsequent failing syncs must NOT keep popping the dialog (this is what made the app unusable).
            mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
            await flushPromises();
            mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
            await flushPromises();
            expect(logErrorAndShowErrorDialog).toHaveBeenCalledTimes(1);
        });

        it("stops the crawler when indexing errors", async () => {
            vi.mocked(logErrorAndShowErrorDialog).mockClear();
            const { indexer, mockClient } = await setUpFailingIndexer();
            const stopCrawler = vi.spyOn(indexer, "stopCrawler");

            mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
            await flushPromises();

            expect(stopCrawler).toHaveBeenCalled();
        });
    });

    describe("onTimelineReset re-seeding (#33957)", () => {
        const TOKEN = "reset-token";

        async function setUpIndexer(
            room: Room,
            { encryptionEnabled = true }: { encryptionEnabled?: boolean } = {},
        ): Promise<{
            mockClient: Mocked<MatrixClient>;
            addCrawlerCheckpoint: Mock;
        }> {
            const addCrawlerCheckpoint = vi.fn();
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue([]),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                addCrawlerCheckpoint,
                removeCrawlerCheckpoint: vi.fn(),
                commitLiveEvents: vi.fn(),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                // onTimelineReset now also runs the crypto-aware `isRoomIndexable`
                // gate; `encryptionEnabled` controls whether the crypto module can
                // "speak" the room's encryption.
                getCrypto: () =>
                    ({
                        isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(encryptionEnabled),
                    }) as any,
                ...mockClientMethodsRooms([room]),
                // Override AFTER the spread: mockClientMethodsRooms sets isRoomEncrypted to a stub
                // returning undefined, which would trip onTimelineReset's encrypted-room guard.
                isRoomEncrypted: vi.fn().mockReturnValue(true),
            });

            const indexer = new EventIndex();
            await indexer.init();
            // Don't actually start the background crawler loop (avoids real timers in the test).
            vi.spyOn(indexer, "startCrawler").mockImplementation(() => {});

            return { mockClient, addCrawlerCheckpoint };
        }

        function makeRoom(unfilteredTimelineSet: object): Room {
            return {
                roomId: "!room1:id",
                getUnfilteredTimelineSet: () => unfilteredTimelineSet,
                getLiveTimeline: () => ({
                    getPaginationToken: () => TOKEN,
                }),
            } as any as Room;
        }

        it("ignores resets from thread/filtered timeline sets (no spurious checkpoint)", async () => {
            const unfilteredTimelineSet = {};
            const threadTimelineSet = {};
            const room = makeRoom(unfilteredTimelineSet);
            const { mockClient, addCrawlerCheckpoint } = await setUpIndexer(room);

            // The SDK re-emits RoomEvent.TimelineReset from thread/filtered timeline sets via its
            // ReEmitter; these must NOT re-seed the crawl list (the #32119 startup CPU spike).
            mockClient.emit(RoomEvent.TimelineReset, room, threadTimelineSet as any, false);
            await flushPromises();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
        });

        it("seeds a backward gap-fill checkpoint when the room's own live timeline resets", async () => {
            const unfilteredTimelineSet = {};
            const room = makeRoom(unfilteredTimelineSet);
            const { mockClient, addCrawlerCheckpoint } = await setUpIndexer(room);

            mockClient.emit(RoomEvent.TimelineReset, room, unfilteredTimelineSet as any, false);
            await flushPromises();

            expect(addCrawlerCheckpoint).toHaveBeenCalledWith({
                roomId: "!room1:id",
                token: TOKEN,
                direction: Direction.Backward,
                fullCrawl: false,
            });
        });

        it("still seeds when no timeline set is provided (guards the `timelineSet &&` short-circuit)", async () => {
            // The pinned SDK always emits a defined timelineSet; this covers the optional-arg contract
            // so an absent timelineSet does not over-block (only a mismatched set should early-return).
            const room = makeRoom({});
            const { mockClient, addCrawlerCheckpoint } = await setUpIndexer(room);

            mockClient.emit(RoomEvent.TimelineReset, room, undefined as any, false);
            await flushPromises();

            expect(addCrawlerCheckpoint).toHaveBeenCalledWith(
                expect.objectContaining({ roomId: "!room1:id", direction: Direction.Backward, fullCrawl: false }),
            );
        });

        it("does not re-seed a legacy-encrypted room whose encryption crypto cannot speak", async () => {
            // Pins the new crypto-aware isRoomIndexable gate in onTimelineReset: the room is
            // state-encrypted (isRoomEncrypted=true) on its own unfiltered timeline, but the crypto
            // module reports encryption is not enabled, so no checkpoint should be seeded.
            const unfilteredTimelineSet = {};
            const room = makeRoom(unfilteredTimelineSet);
            const { mockClient, addCrawlerCheckpoint } = await setUpIndexer(room, { encryptionEnabled: false });

            mockClient.emit(RoomEvent.TimelineReset, room, unfilteredTimelineSet as any, false);
            await flushPromises();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
        });
    });

    describe("reconcileMissedRooms (#32266, #32011)", () => {
        interface ReconcileSetup {
            indexer: EventIndex;
            addCrawlerCheckpoint: Mock;
            addEventToIndex: Mock;
            isRoomIndexed: Mock;
            getCrypto: Mock;
            triggerSync: () => Promise<void>;
        }

        type PerRoom<T> = T | ((roomId: string) => T);
        const resolve = <T>(v: PerRoom<T>, roomId: string): T =>
            typeof v === "function" ? (v as (r: string) => T)(roomId) : v;

        async function setUpReconcile(
            rooms: Room[],
            {
                loadCheckpoints = [],
                roomIndexed = false,
                encryptionEnabled = true,
                roomEncrypted = true,
            }: {
                loadCheckpoints?: ICrawlerCheckpoint[];
                roomIndexed?: PerRoom<boolean>;
                encryptionEnabled?: PerRoom<boolean>;
                roomEncrypted?: PerRoom<boolean>;
            } = {},
        ): Promise<ReconcileSetup> {
            const addCrawlerCheckpoint = vi.fn();
            const addEventToIndex = vi.fn();
            const isRoomIndexed = vi.fn((roomId: string) => Promise.resolve(resolve(roomIndexed, roomId)));

            // Recreated per sync so we can await several syncs (e.g. crypto-not-ready retry).
            let commitResolve: (() => void) | undefined;
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue(loadCheckpoints),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                isRoomIndexed,
                addCrawlerCheckpoint,
                removeCrawlerCheckpoint: vi.fn(),
                addEventToIndex,
                commitLiveEvents: vi.fn().mockImplementation(async () => commitResolve?.()),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const isEncryptionEnabledInRoom = vi.fn((roomId: string) =>
                Promise.resolve(resolve(encryptionEnabled, roomId)),
            );
            const getCrypto = vi.fn().mockReturnValue({ isEncryptionEnabledInRoom });
            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
                getCrypto,
                ...mockClientMethodsRooms(rooms),
                isRoomEncrypted: vi.fn((roomId: string) => resolve(roomEncrypted, roomId)),
            });

            const indexer = new EventIndex();
            await indexer.init();
            // Don't actually start the background crawler loop (avoids real timers in the test).
            vi.spyOn(indexer, "startCrawler").mockImplementation(() => {});

            const triggerSync = async (): Promise<void> => {
                const committed = Promise.withResolvers<void>();
                commitResolve = committed.resolve;
                mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
                await committed.promise;
                await flushPromises();
            };

            return { indexer, addCrawlerCheckpoint, addEventToIndex, isRoomIndexed, getCrypto, triggerSync };
        }

        it("seeds a fullCrawl backward checkpoint for a missed joined encrypted room", async () => {
            const { addCrawlerCheckpoint, triggerSync } = await setUpReconcile([
                joinedRoom("!room1:id", { token: "tok1" }),
            ]);

            await triggerSync();

            expect(addCrawlerCheckpoint).toHaveBeenCalledTimes(1);
            expect(addCrawlerCheckpoint).toHaveBeenCalledWith({
                roomId: "!room1:id",
                token: "tok1",
                fullCrawl: true,
                direction: Direction.Backward,
            });
        });

        it("ignores rooms we are only invited to / have left", async () => {
            const { addCrawlerCheckpoint, isRoomIndexed, triggerSync } = await setUpReconcile([
                joinedRoom("!invite:id", { membership: KnownMembership.Invite }),
                joinedRoom("!left:id", { membership: KnownMembership.Leave }),
            ]);

            await triggerSync();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
            // Short-circuits at the membership gate, before any Seshat read.
            expect(isRoomIndexed).not.toHaveBeenCalled();
        });

        it("records a joined room whose encryption it cannot speak as unindexable (not seeded, not counted)", async () => {
            const { indexer, addCrawlerCheckpoint, triggerSync } = await setUpReconcile([joinedRoom("!room1:id")], {
                encryptionEnabled: false,
                roomEncrypted: true,
            });

            await triggerSync();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
            // The unindexable room is excluded from the status breakdown entirely.
            expect(indexer.getIndexingStatus()).toEqual({ indexing: 0, indexed: 0, errored: 0 });
        });

        it("skips rooms that already have indexed events", async () => {
            const { addCrawlerCheckpoint, triggerSync } = await setUpReconcile([joinedRoom("!room1:id")], {
                roomIndexed: true,
            });

            await triggerSync();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
        });

        it("hydrates the fully-crawled sentinel and never re-seeds (or crawls) that room", async () => {
            const { indexer, addCrawlerCheckpoint, triggerSync } = await setUpReconcile([joinedRoom("!room1:id")], {
                loadCheckpoints: [
                    { roomId: "!room1:id", token: "fully_crawled", fullCrawl: true, direction: Direction.Backward },
                ],
                roomIndexed: false,
            });

            await triggerSync();

            // The sentinel is filtered out of the crawl queue and short-circuits reconciliation,
            // so the room is treated as fully indexed rather than re-seeded.
            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
            expect(indexer.getIndexingStatus()).toEqual({ indexing: 0, indexed: 1, errored: 0 });
        });

        it("indexes the live timeline directly when there is no back-pagination token", async () => {
            const { addCrawlerCheckpoint, addEventToIndex, triggerSync } = await setUpReconcile([
                joinedRoom("!room1:id", { token: null, events: [validMessageEvent("!room1:id")] }),
            ]);

            await triggerSync();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
            expect(addEventToIndex).toHaveBeenCalledTimes(1);
        });

        it("defers reconciliation until crypto is ready and retries on a later sync", async () => {
            const { addCrawlerCheckpoint, getCrypto, triggerSync } = await setUpReconcile([
                joinedRoom("!room1:id", { token: "tok1" }),
            ]);

            // First sync: crypto isn't ready yet, so reconciliation is skipped.
            getCrypto.mockReturnValueOnce(undefined);
            await triggerSync();
            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();

            // Second sync: crypto is ready, so the missed room is recovered.
            await triggerSync();
            expect(addCrawlerCheckpoint).toHaveBeenCalledTimes(1);
            expect(addCrawlerCheckpoint).toHaveBeenCalledWith({
                roomId: "!room1:id",
                token: "tok1",
                fullCrawl: true,
                direction: Direction.Backward,
            });
        });

        it("contains a per-room failure so it never trips the #33501 global circuit-breaker", async () => {
            // reconcileMissedRooms runs inside onSyncInner, whose .catch is the global breaker
            // (stops ALL indexing + shows the error dialog once). A single misbehaving room must
            // be logged-and-skipped, never escape: here one room's getLiveTimeline throws while a
            // healthy room is still recovered.
            vi.mocked(logErrorAndShowErrorDialog).mockClear();
            const bad = joinedRoom("!bad:id", { token: "tokbad" });
            (bad as any).getLiveTimeline = () => {
                throw new Error("boom");
            };
            const good = joinedRoom("!good:id", { token: "tokgood" });
            const { indexer, addCrawlerCheckpoint, triggerSync } = await setUpReconcile([bad, good]);
            const stopCrawler = vi.spyOn(indexer, "stopCrawler");

            await triggerSync();

            // The healthy room is still recovered ...
            expect(addCrawlerCheckpoint).toHaveBeenCalledWith({
                roomId: "!good:id",
                token: "tokgood",
                fullCrawl: true,
                direction: Direction.Backward,
            });
            // ... while the bad room neither seeds, errors, nor trips the breaker.
            expect(addCrawlerCheckpoint).not.toHaveBeenCalledWith(expect.objectContaining({ roomId: "!bad:id" }));
            expect(logErrorAndShowErrorDialog).not.toHaveBeenCalled();
            expect(stopCrawler).not.toHaveBeenCalled();
            expect(indexer.getIndexingStatus().errored).toBe(0);
        });
    });

    describe("crawler error handling and fully-crawled marker (#32119)", () => {
        function setUpCrawler({ checkpoints, rooms }: { checkpoints: ICrawlerCheckpoint[]; rooms: Room[] }): {
            mockClient: Mocked<MatrixClient>;
            addHistoricEvents: Mock;
            removeCrawlerCheckpoint: Mock;
        } {
            const addHistoricEvents = vi.fn().mockResolvedValue(false);
            const removeCrawlerCheckpoint = vi.fn().mockResolvedValue(undefined);
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue(checkpoints),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                addHistoricEvents,
                removeCrawlerCheckpoint,
                deleteEvent: vi.fn(),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
                ...mockClientMethodsRooms(rooms),
                isRoomEncrypted: vi.fn().mockReturnValue(true),
            });
            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any =>
                settingName === "crawlerSleepTime" ? 0 : undefined,
            );

            return { mockClient, addHistoricEvents, removeCrawlerCheckpoint };
        }

        it.each([400, 403, 404])("gives up and marks a room errored on a permanent %s error", async (status) => {
            const { mockClient, removeCrawlerCheckpoint } = setUpCrawler({
                checkpoints: [{ roomId: "!room1:id", token: "tok1", fullCrawl: true, direction: Direction.Backward }],
                rooms: [joinedRoom("!room1:id")],
            });
            mockClient.createMessagesRequest.mockRejectedValue(new HTTPError("permanent", status));

            const indexer = new EventIndex();
            await indexer.init();
            indexer.startCrawler();

            await waitFor(() => removeCrawlerCheckpoint.mock.calls.length > 0, "checkpoint removed");
            await waitFor(() => indexer.getIndexingStatus().indexing === 0, "queue drained");
            indexer.stopCrawler();

            expect(removeCrawlerCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ roomId: "!room1:id" }));
            expect(indexer.getIndexingStatus()).toEqual({ indexing: 0, indexed: 0, errored: 1 });
        });

        it.each([401, 429, 500])("retries (does not drop or error) on a transient %s error", async (status) => {
            const { mockClient, removeCrawlerCheckpoint } = setUpCrawler({
                checkpoints: [{ roomId: "!room1:id", token: "tok1", fullCrawl: true, direction: Direction.Backward }],
                rooms: [joinedRoom("!room1:id")],
            });
            mockClient.createMessagesRequest.mockRejectedValue(new HTTPError("transient", status));

            const indexer = new EventIndex();
            await indexer.init();
            indexer.startCrawler();

            // The crawler keeps retrying the same checkpoint rather than giving up.
            await waitFor(() => mockClient.createMessagesRequest.mock.calls.length >= 2, "retried");
            indexer.stopCrawler();

            expect(removeCrawlerCheckpoint).not.toHaveBeenCalled();
            const status2 = indexer.getIndexingStatus();
            expect(status2.errored).toBe(0);
            expect(status2.indexing).toBe(1);
        });

        it("records a fully-crawled sentinel (not a delete) when a backward fullCrawl reaches history start", async () => {
            const { mockClient, addHistoricEvents, removeCrawlerCheckpoint } = setUpCrawler({
                checkpoints: [{ roomId: "!room1:id", token: "tok1", fullCrawl: true, direction: Direction.Backward }],
                rooms: [joinedRoom("!room1:id")],
            });
            mockClient.createMessagesRequest.mockResolvedValue({ chunk: [] } as any);

            const indexer = new EventIndex();
            await indexer.init();
            indexer.startCrawler();

            await waitFor(() => addHistoricEvents.mock.calls.length > 0, "sentinel written");
            await waitFor(() => indexer.getIndexingStatus().indexing === 0, "queue drained");
            indexer.stopCrawler();

            expect(addHistoricEvents).toHaveBeenCalledWith(
                [],
                { roomId: "!room1:id", token: "fully_crawled", fullCrawl: true, direction: Direction.Backward },
                expect.objectContaining({ roomId: "!room1:id", token: "tok1" }),
            );
            expect(removeCrawlerCheckpoint).not.toHaveBeenCalled();
            // No checkpoint left and no error => the room counts as fully indexed.
            expect(indexer.getIndexingStatus()).toEqual({ indexing: 0, indexed: 1, errored: 0 });
        });

        it("just deletes the checkpoint (no sentinel) for a non-fullCrawl empty chunk", async () => {
            const { mockClient, addHistoricEvents, removeCrawlerCheckpoint } = setUpCrawler({
                checkpoints: [{ roomId: "!room1:id", token: "tok1", direction: Direction.Backward }],
                rooms: [joinedRoom("!room1:id")],
            });
            mockClient.createMessagesRequest.mockResolvedValue({ chunk: [] } as any);

            const indexer = new EventIndex();
            await indexer.init();
            indexer.startCrawler();

            await waitFor(() => removeCrawlerCheckpoint.mock.calls.length > 0, "checkpoint removed");
            indexer.stopCrawler();

            expect(removeCrawlerCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ roomId: "!room1:id" }));
            expect(addHistoricEvents).not.toHaveBeenCalled();
        });
    });

    describe("duplicate checkpoint guard (hasQueuedCheckpoint)", () => {
        it("does not queue an exact-duplicate checkpoint twice", async () => {
            const addCrawlerCheckpoint = vi.fn();
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue([]),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                addCrawlerCheckpoint,
                removeCrawlerCheckpoint: vi.fn(),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const room = joinedRoom("!room1:id", { token: "same-token" });
            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) }) as any,
                ...mockClientMethodsRooms([room]),
                isRoomEncrypted: vi.fn().mockReturnValue(true),
            });

            const indexer = new EventIndex();
            await indexer.init();
            vi.spyOn(indexer, "startCrawler").mockImplementation(() => {});

            // Two gappy-sync resets with the same unchanged backward token: the second must be deduped.
            mockClient.emit(RoomEvent.TimelineReset, room, room.getLiveTimeline().getTimelineSet() as any, false);
            await flushPromises();
            mockClient.emit(RoomEvent.TimelineReset, room, room.getLiveTimeline().getTimelineSet() as any, false);
            await flushPromises();

            expect(addCrawlerCheckpoint).toHaveBeenCalledTimes(1);
        });
    });

    describe("getIndexingStatus (#33956)", () => {
        it("counts indexing/indexed joined encrypted rooms and ignores invites and unencrypted rooms", async () => {
            const mockIndexingManager = {
                loadCheckpoints: vi
                    .fn()
                    .mockResolvedValue([
                        { roomId: "!crawling:id", token: "tok", fullCrawl: true, direction: Direction.Backward },
                    ]),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const rooms = [
                joinedRoom("!crawling:id"), // has a checkpoint => indexing
                joinedRoom("!done:id"), // joined+encrypted, no checkpoint => indexed
                joinedRoom("!invite:id", { membership: KnownMembership.Invite }), // ignored
                joinedRoom("!plain:id"), // not encrypted => ignored
            ];
            getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                ...mockClientMethodsRooms(rooms),
                isRoomEncrypted: vi.fn((roomId: string) => roomId !== "!plain:id"),
            });

            const indexer = new EventIndex();
            await indexer.init();

            expect(indexer.getIndexingStatus()).toEqual({ indexing: 1, indexed: 1, errored: 0 });
        });
    });

    describe("onRoomStateEvent newly-encrypted seeding", () => {
        async function setUp(
            reconciled: boolean,
            encryptionEnabled = true,
        ): Promise<{
            mockClient: Mocked<MatrixClient>;
            addCrawlerCheckpoint: Mock;
        }> {
            const addCrawlerCheckpoint = vi.fn();
            let commitResolve: (() => void) | undefined;
            const mockIndexingManager = {
                loadCheckpoints: vi.fn().mockResolvedValue([]),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                isRoomIndexed: vi.fn().mockResolvedValue(false),
                addCrawlerCheckpoint,
                removeCrawlerCheckpoint: vi.fn(),
                commitLiveEvents: vi.fn().mockImplementation(async () => commitResolve?.()),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            const newRoom = joinedRoom("!new:id", { token: "newtok" });
            const mockClient = getMockClientWithEventEmitter({
                getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
                createMessagesRequest: vi.fn(),
                getCrypto: () => ({ isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(encryptionEnabled) }) as any,
                // getRooms empty so the reconciliation pass is a no-op; getRoom still resolves !new:id
                // so addRoomCheckpoint (driven by onRoomStateEvent) can read its live timeline.
                ...mockClientMethodsRooms([]),
                getRoom: vi.fn((id: string) => (id === "!new:id" ? newRoom : null)),
                isRoomEncrypted: vi.fn().mockReturnValue(true),
            });

            const indexer = new EventIndex();
            await indexer.init();
            vi.spyOn(indexer, "startCrawler").mockImplementation(() => {});

            if (reconciled) {
                const committed = Promise.withResolvers<void>();
                commitResolve = committed.resolve;
                mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
                await committed.promise;
                await flushPromises();
            }

            return { mockClient, addCrawlerCheckpoint };
        }

        function encryptionEvent(): MatrixEvent {
            return new MatrixEvent({ type: EventType.RoomEncryption, room_id: "!new:id", state_key: "", content: {} });
        }

        it("does not seed before the reconciliation pass has run (avoids the initial-sync flood)", async () => {
            const { mockClient, addCrawlerCheckpoint } = await setUp(/* reconciled */ false);

            mockClient.emit(RoomStateEvent.Events, encryptionEvent(), { roomId: "!new:id" } as any as RoomState, null);
            await flushPromises();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
        });

        it("seeds a checkpoint for a room newly encrypted after reconciliation", async () => {
            const { mockClient, addCrawlerCheckpoint } = await setUp(/* reconciled */ true);

            mockClient.emit(RoomStateEvent.Events, encryptionEvent(), { roomId: "!new:id" } as any as RoomState, null);
            await flushPromises();

            expect(addCrawlerCheckpoint).toHaveBeenCalledWith({
                roomId: "!new:id",
                token: "newtok",
                fullCrawl: true,
                direction: Direction.Backward,
            });
        });

        it("does not seed a newly-encrypted room whose encryption crypto cannot speak", async () => {
            // Pins the crypto-aware isRoomIndexable gate in onRoomStateEvent: reconciliation has
            // run (so the !reconciliationDone guard passes), but the crypto module cannot speak the
            // room's encryption, so no checkpoint is seeded.
            const { mockClient, addCrawlerCheckpoint } = await setUp(
                /* reconciled */ true,
                /* encryptionEnabled */ false,
            );

            mockClient.emit(RoomStateEvent.Events, encryptionEvent(), { roomId: "!new:id" } as any as RoomState, null);
            await flushPromises();

            expect(addCrawlerCheckpoint).not.toHaveBeenCalled();
        });
    });
});

/**
 * Mock out the `createMessagesRequest` method on the client, with an implementation that will block until a resolver is called.
 *
 * @returns An object with the following properties:
 *  * `called`: A promise that resolves when `createMessagesRequest` is called.
 *  * `resolve`: A function that can be called to allow `createMessagesRequest` to complete.
 */
function mockCreateMessagesRequest(mockClient: Mocked<MatrixClient>): {
    called: Promise<void>;
    resolve: (result: any) => void;
} {
    const messagesCalledPromise = Promise.withResolvers<void>();
    const messagesResultPromise = Promise.withResolvers();
    mockClient.createMessagesRequest.mockImplementationOnce(() => {
        messagesCalledPromise.resolve();
        return messagesResultPromise.promise as any;
    });
    return {
        called: messagesCalledPromise.promise,
        resolve: messagesResultPromise.resolve,
    };
}

/** Real-timer sleep (the crawler loop sleeps ≥100ms between passes, so fake timers don't help here). */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until truthy (or fail), to await asynchronous crawler-loop progress deterministically. */
async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await realSleep(5);
    }
    throw new Error(`waitFor: ${label} never became true`);
}

/** A joined room mock with just enough surface for the indexer's room reads. */
function joinedRoom(
    roomId: string,
    {
        token = `token-${roomId}`,
        events = [] as MatrixEvent[],
        membership = KnownMembership.Join,
    }: { token?: string | null; events?: MatrixEvent[]; membership?: string } = {},
): Room {
    const timelineSet = {};
    return {
        roomId,
        getMyMembership: () => membership,
        getUnfilteredTimelineSet: () => timelineSet,
        getLiveTimeline: () => ({
            getPaginationToken: () => token,
            getEvents: () => events,
            getTimelineSet: () => timelineSet,
        }),
    } as any as Room;
}

/** A valid, indexable `m.room.message` event for the given room. */
function validMessageEvent(roomId: string): MatrixEvent {
    return new MatrixEvent({
        type: "m.room.message",
        room_id: roomId,
        event_id: `$ev-${roomId}`,
        sender: "@alice:id",
        origin_server_ts: 0,
        content: { msgtype: "m.text", body: "hello" },
    });
}
