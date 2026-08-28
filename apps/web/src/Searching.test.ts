/*
Copyright 2025 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    EventType,
    type IEvent,
    type IResultRoomEvents,
    type ISearchResults,
    MatrixEvent,
    SearchOrderBy,
    SearchResult,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { createTestClient } from "test-utils";

import eventSearch, { extractSearchResultPreviews, hardenSeshatSearchTerm, searchPagination } from "./Searching";
import EventIndexPeg from "./indexing/EventIndexPeg";

describe("Searching", () => {
    const mockClient = createTestClient();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
                search: vi.fn().mockResolvedValue(mockSearchResults),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            // Mock crypto to indicate room is encrypted
            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
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
                search: vi.fn().mockResolvedValue(mockSearchResults),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
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
                search: vi
                    .fn()
                    .mockResolvedValueOnce(mockSearchResults)
                    .mockResolvedValueOnce({ count: 0, highlights: ["test"] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);

            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
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
        vi.spyOn(mockClient, "getCrypto").mockReturnValue({
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
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
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const mockEventIndex = { search: vi.fn().mockResolvedValue(mockSearchResults) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const mockEventIndex = { search: vi.fn().mockResolvedValue(mockSearchResults) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const mockEventIndex = { search: vi.fn().mockResolvedValue(mockSearchResults) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const mockEventIndex = { search: vi.fn().mockResolvedValue(mockSearchResults) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const mockEventIndex = { search: vi.fn().mockResolvedValue(mockSearchResults) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
            const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
            const mockEventIndex = {
                search: vi.fn().mockRejectedValue(new Error('Query is invalid. FieldDoesNotExist("https")')),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue(serverResponse as any);

            // roomId undefined => All Rooms => combinedSearch
            await expect(eventSearch(mockClient, "https://github.com")).resolves.toBeDefined();
            expect(searchSpy).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalled();
        });

        it("returns local results when the server leg rejects in All Rooms", async () => {
            const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            vi.spyOn(mockClient, "search").mockRejectedValue(new Error("Server unavailable"));

            await expect(eventSearch(mockClient, "anything")).resolves.toBeDefined();
            expect(mockEventIndex.search).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalled();
        });

        it("rejects only when BOTH legs fail, reporting both reasons", async () => {
            vi.spyOn(logger, "error").mockImplementation(() => {});
            const localReason = new Error("Seshat down");
            const serverReason = new Error("Server down");
            const mockEventIndex = { search: vi.fn().mockRejectedValue(localReason) };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            vi.spyOn(mockClient, "search").mockRejectedValue(serverReason);

            await expect(eventSearch(mockClient, "anything")).rejects.toThrow(
                "Both the server-side and the local search failed",
            );
            await expect(eventSearch(mockClient, "anything")).rejects.toMatchObject({
                cause: { serverSide: serverReason, local: localReason },
            });
        });
    });

    describe("from:/sender filter", () => {
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

        // Pretend the searched room is encrypted so eventSearch takes the local (Seshat) path.
        const mockEncryptedRoom = (): void => {
            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            } as any);
        };

        const captureProcessed = (): { get: () => any } => {
            let captured: any;
            vi.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any, response: any) => {
                captured = response;
                return { ...sr, results: [], highlights: [] };
            }) as any);
            return { get: () => captured };
        };

        it("sets filter.senders on the homeserver search body when senders are given", async () => {
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null); // no local index -> server-side path
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@alice:example.org"]);

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.filter.senders).toEqual(["@alice:example.org"]);
            // The room scope is preserved alongside the new sender scope.
            expect(body.search_categories.room_events.filter.rooms).toEqual(["!room:example.org"]);
        });

        it("carries filter.senders into the stored _query so server-side pagination keeps it", async () => {
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);
            vi.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any) => sr) as any);

            const result: any = await eventSearch(mockClient, "hello", "!room:example.org", undefined, [
                "@alice:example.org",
            ]);

            expect(result._query.search_categories.room_events.filter.senders).toEqual(["@alice:example.org"]);
        });

        it("over-fetches the Seshat limit when a sender filter is active", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@bob:example.org"]);

            expect(mockEventIndex.search.mock.calls[0][0].limit).toBeGreaterThan(10);
        });

        it("keeps the default Seshat limit when no sender filter is given", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org");

            expect(mockEventIndex.search.mock.calls[0][0].limit).toBe(10);
        });

        it("post-filters Seshat results to the selected sender", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a", 200), rawResult("@bob:example.org", "$b", 100)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@bob:example.org"]);

            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@bob:example.org"]);
        });

        it("returns an empty result without throwing when the sender has no matches", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({
                    count: 1,
                    results: [rawResult("@alice:example.org", "$a", 200)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await expect(
                eventSearch(mockClient, "hello", "!room:example.org", undefined, ["@nobody:example.org"]),
            ).resolves.toBeDefined();

            expect(processed.get().search_categories.room_events.results).toEqual([]);
        });

        it("re-applies the sender post-filter on Seshat pagination", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a2", 80), rawResult("@bob:example.org", "$b2", 70)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
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
                search: vi.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$e", 90), rawResult("@bob:example.org", "$f", 80)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
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
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
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
                search: vi.fn().mockResolvedValue({
                    count: 2,
                    results: [rawResult("@alice:example.org", "$a", 200), rawResult("@bob:example.org", "$b", 100)],
                    highlights: [],
                } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();
            const processed = captureProcessed();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, []);

            // Default Seshat limit (no over-fetch) and every sender preserved (no post-filter).
            expect(mockEventIndex.search.mock.calls[0][0].limit).toBe(10);
            const senders = processed.get().search_categories.room_events.results.map((r: any) => r.result.sender);
            expect(senders).toEqual(["@alice:example.org", "@bob:example.org"]);
        });
    });

    describe("relevance-vs-recency order", () => {
        // Pretend the searched room is encrypted so eventSearch takes the local (Seshat) path.
        const mockEncryptedRoom = (): void => {
            vi.spyOn(mockClient, "getCrypto").mockReturnValue({
                isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
            } as any);
        };

        it("sets order_by: Rank on the homeserver body when relevance order is requested", async () => {
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null); // no local index -> server-side path
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, undefined, SearchOrderBy.Rank);

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.order_by).toBe(SearchOrderBy.Rank);
        });

        it("defaults the homeserver body to Recent order", async () => {
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);

            await eventSearch(mockClient, "hello", "!room:example.org");

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.order_by).toBe(SearchOrderBy.Recent);
        });

        it("carries order_by into the stored _query so server-side pagination keeps the order", async () => {
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(null);
            vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);
            vi.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any) => sr) as any);

            const result: any = await eventSearch(
                mockClient,
                "hello",
                "!room:example.org",
                undefined,
                undefined,
                SearchOrderBy.Rank,
            );

            expect(result._query.search_categories.room_events.order_by).toBe(SearchOrderBy.Rank);
        });

        it("orders a single encrypted room by Seshat relevance (order_by_recency false) under relevance order", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org", undefined, undefined, SearchOrderBy.Rank);

            expect(mockEventIndex.search.mock.calls[0][0].order_by_recency).toBe(false);
        });

        it("keeps a single encrypted room ordered by recency (order_by_recency true) by default", async () => {
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            mockEncryptedRoom();

            await eventSearch(mockClient, "hello", "!room:example.org");

            expect(mockEventIndex.search.mock.calls[0][0].order_by_recency).toBe(true);
        });

        it("keeps recency order on both legs of an all-rooms search even when relevance is requested", async () => {
            // The combined (All-rooms) path merges the two legs with a sliding-window cache that only preserves
            // global order when both legs are recency-sorted, so a relevance order must NOT propagate to either leg
            // (deferred until the merge is redesigned). The single-source paths above honour it; the merged path
            // stays recency by construction.
            const mockEventIndex = {
                search: vi.fn().mockResolvedValue({ count: 0, results: [], highlights: [] } as IResultRoomEvents),
            };
            vi.spyOn(EventIndexPeg, "get").mockReturnValue(mockEventIndex as any);
            const searchSpy = vi.spyOn(mockClient, "search").mockResolvedValue({
                search_categories: { room_events: { results: [], count: 0, highlights: [] } },
            } as any);
            vi.spyOn(mockClient, "processRoomEventsSearch").mockImplementation(((sr: any) => ({
                ...sr,
                results: [],
                highlights: [],
            })) as any);

            // roomId undefined => All Rooms => combinedSearch.
            await eventSearch(mockClient, "hello", undefined, undefined, undefined, SearchOrderBy.Rank);

            const body = (searchSpy.mock.calls[0][0] as any).body;
            expect(body.search_categories.room_events.order_by).toBe(SearchOrderBy.Recent);
            expect(mockEventIndex.search.mock.calls[0][0].order_by_recency).toBe(true);
        });
    });

    describe("extractSearchResultPreviews", () => {
        const eventMapper = (obj: Partial<IEvent>): MatrixEvent => new MatrixEvent(obj);

        const makeResult = (eventId: string, ts: number, body: string, sender = "@user:example.org"): SearchResult =>
            SearchResult.fromJson(
                {
                    rank: 1,
                    result: {
                        room_id: "!room:example.org",
                        event_id: eventId,
                        sender,
                        origin_server_ts: ts,
                        content: { body, msgtype: "m.text" },
                        type: EventType.RoomMessage,
                    },
                    context: { profile_info: {}, events_before: [], events_after: [] },
                },
                eventMapper,
            );

        it("returns newest-first preview rows carrying sender, body and timestamp (parallel to extractSearchMatches)", () => {
            const results = {
                results: [
                    makeResult("$old", 100, "older"),
                    makeResult("$new", 300, "newer"),
                    makeResult("$mid", 200, "middle"),
                ],
                highlights: [],
                count: 3,
            } as unknown as ISearchResults;

            expect(extractSearchResultPreviews(results)).toEqual([
                { roomId: "!room:example.org", eventId: "$new", sender: "@user:example.org", body: "newer", ts: 300 },
                { roomId: "!room:example.org", eventId: "$mid", sender: "@user:example.org", body: "middle", ts: 200 },
                { roomId: "!room:example.org", eventId: "$old", sender: "@user:example.org", body: "older", ts: 100 },
            ]);
        });

        it("skips results whose matched event lacks an id or room id", () => {
            const bad = SearchResult.fromJson(
                {
                    rank: 1,
                    result: {
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
                results: [makeResult("$a", 5, "a"), bad],
                highlights: [],
                count: 2,
            } as unknown as ISearchResults;

            expect(extractSearchResultPreviews(results)).toEqual([
                { roomId: "!room:example.org", eventId: "$a", sender: "@user:example.org", body: "a", ts: 5 },
            ]);
        });

        it("returns an empty list when there are no results", () => {
            const results = { results: [], highlights: [], count: 0 } as unknown as ISearchResults;
            expect(extractSearchResultPreviews(results)).toEqual([]);
        });
    });
});
