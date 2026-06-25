/*
Copyright 2025 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    EventType,
    type IEvent,
    type IResultRoomEvents,
    type ISearchResults,
    MatrixEvent,
    SearchResult,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import eventSearch, {
    extractSearchHighlights,
    extractSearchMatches,
    hardenSeshatSearchTerm,
    getRoomSearchChain,
    searchPagination,
} from "../../src/Searching";
import EventIndexPeg from "../../src/indexing/EventIndexPeg";
import { createTestClient } from "../test-utils";

describe("Searching", () => {
    const mockClient = createTestClient();

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("localSearch", () => {
        it("removes state_key: null from search results", async () => {
            // Mock search results from Seshat that include state_key: null
            const mockSearchResults: IResultRoomEvents = {
                count: 2,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message 1", msgtype: "m.text" },
                            // Seshat incorrectly includes state_key: null for non-state events
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [
                                {
                                    event_id: "$before1",
                                    room_id: "!room:example.org",
                                    sender: "@user:example.org",
                                    type: "m.room.message",
                                    origin_server_ts: 1234567889,
                                    content: { body: "before message", msgtype: "m.text" },
                                    state_key: null,
                                } as any,
                            ],
                            events_after: [
                                {
                                    event_id: "$after1",
                                    room_id: "!room:example.org",
                                    sender: "@user:example.org",
                                    type: "m.room.message",
                                    origin_server_ts: 1234567891,
                                    content: { body: "after message", msgtype: "m.text" },
                                    state_key: null,
                                } as any,
                            ],
                            profile_info: {},
                        },
                    },
                    {
                        rank: 2,
                        result: {
                            event_id: "$event2",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567880,
                            content: { body: "test message 2", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [],
                            events_after: [],
                            profile_info: {},
                        },
                    },
                ],
                highlights: ["test"],
            };

            // Mock EventIndex.search to return results with state_key: null
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue(mockSearchResults),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            // Mock crypto to indicate room is encrypted
            jest.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(true),
            } as any);

            // Perform search in an encrypted room
            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);

            // Verify that state_key: null was removed from the search arguments passed to search
            expect(mockEventIndex.search).toHaveBeenCalled();

            // Get the mock search results that were passed to processRoomEventsSearch
            // The state_key should have been deleted from the original results object
            const mainEventResult = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect(mainEventResult.state_key).toBeUndefined();

            const beforeEvent = mockSearchResults.results![0].context!.events_before![0] as unknown as Record<
                string,
                unknown
            >;
            expect(beforeEvent.state_key).toBeUndefined();

            const afterEvent = mockSearchResults.results![0].context!.events_after![0] as unknown as Record<
                string,
                unknown
            >;
            expect(afterEvent.state_key).toBeUndefined();

            const secondResult = mockSearchResults.results![1].result as unknown as Record<string, unknown>;
            expect(secondResult.state_key).toBeUndefined();
        });

        it("does not modify events without state_key: null", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 1,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message", msgtype: "m.text" },
                            // No state_key property at all (correct behavior)
                        } as any,
                        context: {
                            events_before: [],
                            events_after: [],
                            profile_info: {},
                        },
                    },
                ],
                highlights: ["test"],
            };

            const mockEventIndex = {
                search: jest.fn().mockResolvedValue(mockSearchResults),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            jest.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(true),
            } as any);

            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);

            // Verify state_key is still undefined (not accidentally set to something)
            const eventResult = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect("state_key" in eventResult).toBe(false);
        });

        it("handles missing context fields and empty result sets", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 3,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$event1",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567890,
                            content: { body: "test message", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            events_before: [{ event_id: "$before1", state_key: "not-null" } as any],
                            events_after: [{ event_id: "$after1", state_key: "not-null" } as any],
                            profile_info: {},
                        },
                    },
                    {
                        rank: 2,
                        result: {
                            event_id: "$event2",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567891,
                            content: { body: "test message 2", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: {
                            profile_info: {},
                        } as any,
                    },
                    {
                        rank: 3,
                        result: {
                            event_id: "$event3",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1234567892,
                            content: { body: "test message 3", msgtype: "m.text" },
                            state_key: null,
                        } as any,
                        context: undefined as any,
                    },
                ],
                highlights: ["test"],
            };

            const mockEventIndex = {
                search: jest
                    .fn()
                    .mockResolvedValueOnce(mockSearchResults)
                    .mockResolvedValueOnce({ count: 0, highlights: ["test"] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            jest.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(true),
            } as any);

            const roomId = "!room:example.org";
            await eventSearch(mockClient, "test", roomId);
            await eventSearch(mockClient, "test", roomId);

            const firstMainEvent = mockSearchResults.results![0].result as unknown as Record<string, unknown>;
            expect(firstMainEvent.state_key).toBeUndefined();

            const beforeEvent = mockSearchResults.results![0].context!.events_before![0] as unknown as Record<
                string,
                unknown
            >;
            expect(beforeEvent.state_key).toBe("not-null");

            const afterEvent = mockSearchResults.results![0].context!.events_after![0] as unknown as Record<
                string,
                unknown
            >;
            expect(afterEvent.state_key).toBe("not-null");

            const secondMainEvent = mockSearchResults.results![1].result as unknown as Record<string, unknown>;
            expect(secondMainEvent.state_key).toBeUndefined();

            const thirdMainEvent = mockSearchResults.results![2].result as unknown as Record<string, unknown>;
            expect(thirdMainEvent.state_key).toBeUndefined();
        });
    });

    const mockEncryptedRoom = (): void => {
        jest.spyOn(mockClient, "getCrypto").mockReturnValue({
            isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(true),
        } as any);
    };

    describe("hardenSeshatSearchTerm (#32341)", () => {
        it("leaves a plain term unchanged", () => {
            expect(hardenSeshatSearchTerm("hello world")).toBe("hello world");
        });

        it("phrase-wraps a term containing a colon (tantivy field operator)", () => {
            expect(hardenSeshatSearchTerm("https://github.com")).toBe('"https://github.com"');
        });

        it("leaves a genuinely closed phrase unchanged", () => {
            expect(hardenSeshatSearchTerm('"https://github.com"')).toBe('"https://github.com"');
        });

        it("re-wraps an unbalanced leading-quote term containing a colon", () => {
            // A stray leading quote would otherwise be an odd-quote syntax error in tantivy.
            expect(hardenSeshatSearchTerm('"https://github.com')).toBe('"\\"https://github.com"');
        });

        it("escapes embedded double quotes when wrapping", () => {
            expect(hardenSeshatSearchTerm('a:"b')).toBe('"a:\\"b"');
        });

        it("passes the hardened term to Seshat but the raw term to the homeserver", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "https://github.com", "!room:example.org");

            expect(mockEventIndex.search).toHaveBeenCalledWith(
                expect.objectContaining({ search_term: '"https://github.com"' }),
            );
        });
    });

    describe("edited messages (#32356)", () => {
        const makeEditResult = (): IResultRoomEvents => ({
            count: 1,
            results: [
                {
                    rank: 1,
                    result: {
                        event_id: "$edit",
                        room_id: "!room:example.org",
                        sender: "@user:example.org",
                        type: "m.room.message",
                        origin_server_ts: 2000,
                        content: {
                            "body": "* edited text",
                            "msgtype": "m.text",
                            "m.new_content": { body: "edited text", msgtype: "m.text" },
                            "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
                        },
                        // encryption sidecar that restoreEncryptionInfo consumes after processing
                        curve25519Key: "curve",
                        ed25519Key: "ed",
                        algorithm: "m.megolm.v1.aes-sha2",
                    } as any,
                    context: { events_before: [], events_after: [], profile_info: {} },
                },
            ],
            highlights: ["edited"],
        });

        it("promotes m.new_content and drops the m.replace relation so the edit renders", async () => {
            const mockSearchResults = makeEditResult();
            const mockEventIndex = { search: jest.fn().mockResolvedValue(mockSearchResults) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "edited", "!room:example.org");

            const event = mockSearchResults.results![0].result as unknown as Record<string, any>;
            expect(event.content.body).toBe("edited text");
            expect(event.content.msgtype).toBe("m.text");
            expect(event.content["m.relates_to"]).toBeUndefined();
            expect(event.content["m.new_content"]).toBeUndefined();
            // Re-keyed to the original so the SDK event mapper resolves the renderable original
            // (which carries the aggregated edit in a loaded room) rather than the live m.replace.
            expect(event.event_id).toBe("$orig");
            expect(event.origin_server_ts).toBe(2000);
            // encryption sidecar fields preserved for restoreEncryptionInfo
            expect(event.curve25519Key).toBe("curve");
            expect(event.algorithm).toBe("m.megolm.v1.aes-sha2");
        });

        it("leaves a non-edit message untouched", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 1,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$plain",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1,
                            content: { body: "plain message", msgtype: "m.text" },
                        } as any,
                        context: { events_before: [], events_after: [], profile_info: {} },
                    },
                ],
                highlights: [],
            };
            const mockEventIndex = { search: jest.fn().mockResolvedValue(mockSearchResults) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "plain", "!room:example.org");

            const event = mockSearchResults.results![0].result as unknown as Record<string, any>;
            expect(event.content.body).toBe("plain message");
        });

        it("leaves an edit that only appears as context unchanged (no id collision risk)", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 1,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$match",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 3,
                            content: { body: "match", msgtype: "m.text" },
                        } as any,
                        context: {
                            events_before: [
                                {
                                    event_id: "$ctxEdit",
                                    room_id: "!room:example.org",
                                    sender: "@user:example.org",
                                    type: "m.room.message",
                                    origin_server_ts: 2,
                                    content: {
                                        "body": "* ctx edited",
                                        "msgtype": "m.text",
                                        "m.new_content": { body: "ctx edited", msgtype: "m.text" },
                                        "m.relates_to": { rel_type: "m.replace", event_id: "$ctxOrig" },
                                    },
                                } as any,
                            ],
                            events_after: [],
                            profile_info: {},
                        },
                    },
                ],
                highlights: [],
            };
            const mockEventIndex = { search: jest.fn().mockResolvedValue(mockSearchResults) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "ctx", "!room:example.org");

            // Context events are not re-keyed (only the matched event is), so the relation stays.
            const ctx = mockSearchResults.results![0].context!.events_before![0] as unknown as Record<string, any>;
            expect(ctx.event_id).toBe("$ctxEdit");
            expect(ctx.content["m.relates_to"]).toBeDefined();
        });

        it("de-duplicates a promoted edit and its original when both match", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 2,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$edit",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 2000,
                            content: {
                                "body": "* hello there",
                                "msgtype": "m.text",
                                "m.new_content": { body: "hello there", msgtype: "m.text" },
                                "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
                            },
                        } as any,
                        context: { events_before: [], events_after: [], profile_info: {} },
                    },
                    {
                        rank: 2,
                        result: {
                            event_id: "$orig",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 1000,
                            content: { body: "hello world", msgtype: "m.text" },
                        } as any,
                        context: { events_before: [], events_after: [], profile_info: {} },
                    },
                ],
                highlights: ["hello"],
            };
            const mockEventIndex = { search: jest.fn().mockResolvedValue(mockSearchResults) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org");

            // Both results re-key to $orig; only one survives to avoid a duplicate tile.
            expect(mockSearchResults.results).toHaveLength(1);
            expect((mockSearchResults.results![0].result as any).event_id).toBe("$orig");
        });

        it("leaves an edit with empty m.new_content untouched (no blank tile)", async () => {
            const mockSearchResults: IResultRoomEvents = {
                count: 1,
                results: [
                    {
                        rank: 1,
                        result: {
                            event_id: "$edit",
                            room_id: "!room:example.org",
                            sender: "@user:example.org",
                            type: "m.room.message",
                            origin_server_ts: 2000,
                            content: {
                                "body": "* edited",
                                "msgtype": "m.text",
                                "m.new_content": {},
                                "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
                            },
                        } as any,
                        context: { events_before: [], events_after: [], profile_info: {} },
                    },
                ],
                highlights: [],
            };
            const mockEventIndex = { search: jest.fn().mockResolvedValue(mockSearchResults) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "edited", "!room:example.org");

            const event = mockSearchResults.results![0].result as unknown as Record<string, any>;
            expect(event.event_id).toBe("$edit");
            expect(event.content.body).toBe("* edited");
            expect(event.content["m.relates_to"]).toBeDefined();
        });
    });

    describe("combinedSearch resilience (#32341)", () => {
        const serverResponse = {
            search_categories: { room_events: { results: [], count: 0, highlights: [] } },
        };

        it("returns server results when the local (Seshat) leg rejects in All Rooms", async () => {
            const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
            const mockEventIndex = {
                search: jest.fn().mockRejectedValue(new Error('Query is invalid. FieldDoesNotExist("https")')),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue(serverResponse as any);

            // roomId undefined => All Rooms => combinedSearch
            await expect(eventSearch(mockClient, "https://github.com")).resolves.toBeDefined();
            expect(searchSpy).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalled();
        });

        it("returns local results when the server leg rejects in All Rooms", async () => {
            const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            jest.spyOn(mockClient, "search").mockRejectedValue(new Error("Server unavailable"));

            await expect(eventSearch(mockClient, "anything")).resolves.toBeDefined();
            expect(mockEventIndex.search).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalled();
        });

        it("rejects only when BOTH legs fail", async () => {
            jest.spyOn(logger, "error").mockImplementation(() => {});
            const mockEventIndex = { search: jest.fn().mockRejectedValue(new Error("Seshat down")) };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            jest.spyOn(mockClient, "search").mockRejectedValue(new Error("Server down"));

            await expect(eventSearch(mockClient, "anything")).rejects.toThrow();
        });
    });

    describe("getRoomSearchChain (#32258)", () => {
        const roomWith = (predecessorRoomId: string | null) =>
            ({
                findPredecessor: jest.fn().mockReturnValue(predecessorRoomId ? { roomId: predecessorRoomId } : null),
            }) as any;

        it("returns just the room when it has no predecessor", () => {
            jest.spyOn(mockClient, "getRoom").mockReturnValue(roomWith(null));
            expect(getRoomSearchChain(mockClient, "!a:e.o")).toEqual(["!a:e.o"]);
        });

        it("walks the predecessor chain newest-first", () => {
            const rooms: Record<string, any> = {
                "!c": roomWith("!b"),
                "!b": roomWith("!a"),
                "!a": roomWith(null),
            };
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => rooms[id as string] ?? null);
            expect(getRoomSearchChain(mockClient, "!c")).toEqual(["!c", "!b", "!a"]);
        });

        it("guards against predecessor cycles", () => {
            const rooms: Record<string, any> = { "!x": roomWith("!y"), "!y": roomWith("!x") };
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => rooms[id as string] ?? null);
            expect(getRoomSearchChain(mockClient, "!x")).toEqual(["!x", "!y"]);
        });

        it("includes a predecessor even if its room object is not loaded, then stops", () => {
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => (id === "!new" ? roomWith("!gone") : null));
            expect(getRoomSearchChain(mockClient, "!new")).toEqual(["!new", "!gone"]);
        });

        it("caps traversal depth against a pathological chain", () => {
            jest.spyOn(mockClient, "getRoom").mockImplementation(
                (id) => ({ findPredecessor: () => ({ roomId: (id as string) + "x" }) }) as any,
            );
            expect(getRoomSearchChain(mockClient, "!a").length).toBe(20);
        });
    });

    describe("predecessor chain search (#32258)", () => {
        const roomWith = (roomId: string, predecessorRoomId: string | null) =>
            ({
                roomId,
                findPredecessor: jest.fn().mockReturnValue(predecessorRoomId ? { roomId: predecessorRoomId } : null),
            }) as any;

        const resultFor = (roomId: string, eventId: string, ts: number): IResultRoomEvents => ({
            count: 1,
            highlights: ["foo"],
            results: [
                {
                    rank: 1,
                    result: {
                        event_id: eventId,
                        room_id: roomId,
                        sender: "@u:e.o",
                        type: "m.room.message",
                        origin_server_ts: ts,
                        content: { body: "foo", msgtype: "m.text" },
                    } as any,
                    context: { events_before: [], events_after: [], profile_info: {} },
                },
            ],
        });

        it("searches the room and its predecessor and merges by recency (encrypted)", async () => {
            const rooms: Record<string, any> = {
                "!new:e.o": roomWith("!new:e.o", "!old:e.o"),
                "!old:e.o": roomWith("!old:e.o", null),
            };
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => rooms[id as string] ?? null);
            mockEncryptedRoom();

            const mockEventIndex = {
                search: jest
                    .fn()
                    .mockImplementation((args) =>
                        Promise.resolve(
                            args.room_id === "!new:e.o"
                                ? resultFor("!new:e.o", "$new", 200)
                                : resultFor("!old:e.o", "$old", 100),
                        ),
                    ),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            let captured: any;
            jest.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any, response: any) => {
                captured = response;
                return { ...sr, results: [], highlights: [] };
            }) as any);

            await eventSearch(mockClient, "foo", "!new:e.o");

            expect(mockEventIndex.search).toHaveBeenCalledTimes(2);
            const roomIdsSearched = mockEventIndex.search.mock.calls.map((c) => c[0].room_id);
            expect(roomIdsSearched).toEqual(expect.arrayContaining(["!new:e.o", "!old:e.o"]));
            const merged = captured.search_categories.room_events.results.map((r: any) => r.result.event_id);
            expect(merged).toEqual(["$new", "$old"]); // newest first
            expect(captured.search_categories.room_events.count).toBe(2);
        });

        it("uses the single-room path when there is no predecessor", async () => {
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) =>
                id === "!solo:e.o" ? roomWith("!solo:e.o", null) : null,
            );
            mockEncryptedRoom();
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            await eventSearch(mockClient, "foo", "!solo:e.o");

            expect(mockEventIndex.search).toHaveBeenCalledTimes(1);
            expect(mockEventIndex.search.mock.calls[0][0].room_id).toBe("!solo:e.o");
        });

        it("scopes the server-side search to the chain for a non-encrypted upgraded room", async () => {
            const rooms: Record<string, any> = {
                "!new:e.o": roomWith("!new:e.o", "!old:e.o"),
                "!old:e.o": roomWith("!old:e.o", null),
            };
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => rooms[id as string] ?? null);
            jest.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: jest.fn().mockResolvedValue(false),
            } as any);
            // eventIndex non-null so we reach eventIndexSearch's non-encrypted branch
            jest.spyOn(EventIndexPeg, "get").mockReturnValue({ search: jest.fn() } as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "foo", "!new:e.o");

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.filter.rooms).toEqual(["!new:e.o", "!old:e.o"]);
        });

        it("searches an encrypted room via Seshat and its non-encrypted predecessor via the homeserver", async () => {
            const rooms: Record<string, any> = {
                "!new:e.o": roomWith("!new:e.o", "!old:e.o"),
                "!old:e.o": roomWith("!old:e.o", null),
            };
            jest.spyOn(mockClient, "getRoom").mockImplementation((id) => rooms[id as string] ?? null);
            // new room is encrypted, the (loaded) predecessor is not
            jest.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: jest.fn().mockImplementation((id) => Promise.resolve(id === "!new:e.o")),
            } as any);

            const mockEventIndex = {
                search: jest.fn().mockResolvedValue(resultFor("!new:e.o", "$new", 200)),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: {
                    room_events: { results: resultFor("!old:e.o", "$old", 100).results, count: 1, highlights: ["foo"] },
                },
            } as any);

            let captured: any;
            jest.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any, response: any) => {
                captured = response;
                return { ...sr, results: [], highlights: [] };
            }) as any);

            await eventSearch(mockClient, "foo", "!new:e.o");

            // Seshat queried only the encrypted room; the homeserver queried only the predecessor.
            expect(mockEventIndex.search).toHaveBeenCalledTimes(1);
            expect(mockEventIndex.search.mock.calls[0][0].room_id).toBe("!new:e.o");
            expect((searchSpy.mock.calls[0][0] as any).body.search_categories.room_events.filter.rooms).toEqual([
                "!old:e.o",
            ]);
            // Both legs are merged by recency.
            const merged = captured.search_categories.room_events.results.map((r: any) => r.result.event_id);
            expect(merged).toEqual(["$new", "$old"]);
        });

        it("paginates a chain search across both the Seshat rooms and the homeserver leg", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue(resultFor("!new:e.o", "$new2", 150)),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: {
                    room_events: { results: resultFor("!old:e.o", "$old2", 50).results, count: 1, highlights: [] },
                },
            } as any);

            let captured: any;
            jest.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any, response: any) => {
                captured = response;
                return { ...sr, results: [], highlights: [] };
            }) as any);

            const searchResult: any = {
                results: [],
                highlights: [],
                cachedEvents: [],
                count: 4,
                seshatChainQueries: [{ search_term: "foo", room_id: "!new:e.o", next_batch: "s1" }],
                _query: { search_categories: { room_events: {} } },
                serverSideNextBatch: "srv1",
            };

            await searchPagination(mockClient, searchResult);

            // (the query object's next_batch is advanced in place after the call, so assert on room_id)
            expect(mockEventIndex.search).toHaveBeenCalledWith(expect.objectContaining({ room_id: "!new:e.o" }));
            expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ next_batch: "srv1" }));
            const merged = captured.search_categories.room_events.results.map((r: any) => r.result.event_id);
            expect(merged).toEqual(["$new2", "$old2"]);
        });
    });

    describe("extractSearchMatches", () => {
        const eventMapper = (obj: Partial<IEvent>): MatrixEvent => new MatrixEvent(obj);

        const makeResult = (roomId: string, eventId: string, ts = 1): SearchResult =>
            SearchResult.fromJson(
                {
                    rank: 1,
                    result: {
                        room_id: roomId,
                        event_id: eventId,
                        sender: "@user:example.org",
                        origin_server_ts: ts,
                        content: { body: "match", msgtype: "m.text" },
                        type: EventType.RoomMessage,
                    },
                    context: { profile_info: {}, events_before: [], events_after: [] },
                },
                eventMapper,
            );

        it("orders matches newest-first by event timestamp regardless of backend order", () => {
            const results = {
                results: [
                    makeResult("!room:example.org", "$old", 100),
                    makeResult("!room:example.org", "$new", 300),
                    makeResult("!room:example.org", "$mid", 200),
                ],
                highlights: [],
                count: 3,
            } as unknown as ISearchResults;

            expect(extractSearchMatches(results)).toEqual([
                { roomId: "!room:example.org", eventId: "$new" },
                { roomId: "!room:example.org", eventId: "$mid" },
                { roomId: "!room:example.org", eventId: "$old" },
            ]);
        });

        it("keeps the backend order for matches sharing a timestamp (stable sort)", () => {
            const results = {
                results: [makeResult("!room:example.org", "$a", 5), makeResult("!room:example.org", "$b", 5)],
                highlights: [],
                count: 2,
            } as unknown as ISearchResults;

            expect(extractSearchMatches(results)).toEqual([
                { roomId: "!room:example.org", eventId: "$a" },
                { roomId: "!room:example.org", eventId: "$b" },
            ]);
        });

        it("sorts a match missing a timestamp to the end without corrupting the dated order", () => {
            const undated = SearchResult.fromJson(
                {
                    rank: 1,
                    result: {
                        room_id: "!room:example.org",
                        event_id: "$undated",
                        sender: "@user:example.org",
                        // no origin_server_ts → MatrixEvent.getTs() is undefined
                        content: { body: "match", msgtype: "m.text" },
                        type: EventType.RoomMessage,
                    },
                    context: { profile_info: {}, events_before: [], events_after: [] },
                } as unknown as Parameters<typeof SearchResult.fromJson>[0],
                eventMapper,
            );
            const results = {
                results: [
                    undated,
                    makeResult("!room:example.org", "$b", 100),
                    makeResult("!room:example.org", "$a", 200),
                ],
                highlights: [],
                count: 3,
            } as unknown as ISearchResults;

            expect(extractSearchMatches(results)).toEqual([
                { roomId: "!room:example.org", eventId: "$a" },
                { roomId: "!room:example.org", eventId: "$b" },
                { roomId: "!room:example.org", eventId: "$undated" },
            ]);
        });

        it("skips results whose matched event lacks an id or room id", () => {
            const bad = SearchResult.fromJson(
                {
                    rank: 1,
                    result: {
                        // no event_id / room_id
                        sender: "@user:example.org",
                        origin_server_ts: 1,
                        content: { body: "match", msgtype: "m.text" },
                        type: EventType.RoomMessage,
                    },
                    context: { profile_info: {}, events_before: [], events_after: [] },
                } as unknown as Parameters<typeof SearchResult.fromJson>[0],
                eventMapper,
            );
            const results = {
                results: [makeResult("!room:example.org", "$a"), bad],
                highlights: [],
                count: 2,
            } as unknown as ISearchResults;

            expect(extractSearchMatches(results)).toEqual([{ roomId: "!room:example.org", eventId: "$a" }]);
        });

        it("returns an empty list when there are no results", () => {
            const results = { results: [], highlights: [], count: 0 } as unknown as ISearchResults;
            expect(extractSearchMatches(results)).toEqual([]);
        });

        it("merges matches from other rooms chronologically (e.g. predecessor-chain results), leaving scoping to the caller", () => {
            // A room-scoped search of an upgraded room also returns predecessor-room matches (#32258).
            // extractSearchMatches is a pure, scope-agnostic helper: it preserves every jumpable match
            // regardless of which room it belongs to, ordered newest-first. Restricting *live-timeline*
            // stepping to the current room (RoomView is keyed by room id) is the caller's responsibility, so
            // this helper must not pre-filter by room.
            // Timestamps interleave across rooms so the result can only be correct if matches are merged by ts
            // across rooms (not grouped by room then ordered): the predecessor match sorts *between* the two
            // current-room matches.
            const results = {
                results: [
                    makeResult("!current:example.org", "$old", 100),
                    makeResult("!predecessor:example.org", "$mid", 200),
                    makeResult("!current:example.org", "$new", 300),
                ],
                highlights: [],
                count: 3,
            } as unknown as ISearchResults;

            expect(extractSearchMatches(results)).toEqual([
                { roomId: "!current:example.org", eventId: "$new" },
                { roomId: "!predecessor:example.org", eventId: "$mid" },
                { roomId: "!current:example.org", eventId: "$old" },
            ]);
        });
    });

    describe("extractSearchHighlights", () => {
        it("appends the search term and sorts longest-first", () => {
            const results = { results: [], highlights: ["bb", "dddd"], count: 0 } as unknown as ISearchResults;
            expect(extractSearchHighlights(results, "ccc")).toEqual(["dddd", "ccc", "bb"]);
        });

        it("does not duplicate the term when the backend already returned it", () => {
            const results = { results: [], highlights: ["match", "xy"], count: 0 } as unknown as ISearchResults;
            expect(extractSearchHighlights(results, "match")).toEqual(["match", "xy"]);
        });

        it("returns just the term when the backend highlights are empty", () => {
            const results = { results: [], highlights: [], count: 0 } as unknown as ISearchResults;
            expect(extractSearchHighlights(results, "boat")).toEqual(["boat"]);
        });

        it("does not mutate the backend highlights array", () => {
            const backendHighlights = ["bb", "dddd"];
            const results = { results: [], highlights: backendHighlights, count: 0 } as unknown as ISearchResults;
            extractSearchHighlights(results, "ccc");
            expect(backendHighlights).toEqual(["bb", "dddd"]);
        });
    });

    describe("from:/sender filter (Phase 3 slice 2)", () => {
        const rawResult = (sender: string, eventId: string, ts: number): any => ({
            rank: 1,
            result: {
                event_id: eventId,
                room_id: "!room:example.org",
                sender,
                type: "m.room.message",
                origin_server_ts: ts,
                content: { body: "hello", msgtype: "m.text" },
            },
            context: { events_before: [], events_after: [], profile_info: {} },
        });

        const captureProcessed = (): { get: () => any } => {
            let captured: any;
            jest.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any, response: any) => {
                captured = response;
                return { ...sr, results: [], highlights: [] };
            }) as any);
            return { get: () => captured };
        };

        it("sets filter.senders on the homeserver search body when senders are given", async () => {
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(null); // no local index -> server-side path
            jest.spyOn(mockClient, "getRoom").mockReturnValue({ findPredecessor: () => null } as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@alice:example.org"]);

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.filter.senders).toEqual(["@alice:example.org"]);
            // The room/predecessor scope is preserved alongside the new sender scope.
            expect(body.search_categories.room_events.filter.rooms).toEqual(["!room:example.org"]);
        });

        it("carries filter.senders into the stored _query so server-side pagination keeps it", async () => {
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            jest.spyOn(mockClient, "getRoom").mockReturnValue({ findPredecessor: () => null } as any);
            jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);
            jest.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any) => sr) as any);

            const result: any = await eventSearch(mockClient, "hello", "!room:example.org", undefined, [
                "@alice:example.org",
            ]);

            expect(result._query.search_categories.room_events.filter.senders).toEqual(["@alice:example.org"]);
        });

        it("over-fetches the Seshat limit when a sender filter is active", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@bob:example.org"]);

            expect(mockEventIndex.search.mock.calls[0][0].limit).toBeGreaterThan(10);
        });

        it("keeps the default Seshat limit when no sender filter is given", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org");

            expect(mockEventIndex.search.mock.calls[0][0].limit).toBe(10);
        });

        it("post-filters Seshat results to the selected sender", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a", 200), rawResult("@bob:example.org", "$b", 100)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@bob:example.org"]);

            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@bob:example.org"]);
        });

        it("returns an empty result without throwing when the sender has no matches", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({
                    count: 1,
                    results: [rawResult("@alice:example.org", "$a", 200)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await expect(
                eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@nobody:example.org"]),
            ).resolves.toBeDefined();

            expect(processed.get().search_categories.room_events.results).toEqual([]);
        });

        it("re-applies the sender post-filter on Seshat pagination", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a2", 80), rawResult("@bob:example.org", "$b2", 70)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const processed = captureProcessed();

            const searchResult: any = {
                results: [],
                highlights: [],
                seshatQuery: { search_term: "hello", room_id: "!room:example.org", limit: 50, next_batch: "n1" },
                senderFilter: ["@bob:example.org"],
            };

            await searchPagination(mockClient, searchResult);

            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@bob:example.org"]);
        });

        it("filters both the homeserver and Seshat legs for an all-rooms search", async () => {
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$e", 90), rawResult("@bob:example.org", "$f", 80)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);
            const processed = captureProcessed();

            // roomId undefined => All Rooms => combinedSearch
            await eventSearch(mockClient, "hello", undefined, undefined, ["@bob:example.org"]);

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.filter.senders).toEqual(["@bob:example.org"]);
            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@bob:example.org"]);
        });

        it("does not set filter.senders on the homeserver body when no sender filter is given", async () => {
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            jest.spyOn(mockClient, "getRoom").mockReturnValue({ findPredecessor: () => null } as any);
            const searchSpy = jest.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "hello", "!room:example.org");

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.filter.senders).toBeUndefined();
        });

        it("treats an empty senders array as no filter (the cleared-filter case)", async () => {
            // The Clear action passes []; it must behave exactly like undefined — no homeserver filter, no Seshat
            // over-fetch, no post-filter dropping results.
            const mockEventIndex = {
                search: jest.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a", 200), rawResult("@bob:example.org", "$b", 100)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            jest.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, []);

            // Default Seshat limit (no over-fetch) and every sender preserved (no post-filter).
            expect(mockEventIndex.search.mock.calls[0][0].limit).toBe(10);
            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@alice:example.org", "@bob:example.org"]);
        });
    });
});
