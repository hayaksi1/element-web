/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    type IResultRoomEvents,
    type ISearchRequestBody,
    type ISearchResponse,
    type ISearchResult,
    type ISearchResults,
    SearchOrderBy,
    type IRoomEventFilter,
    EventType,
    type MatrixClient,
    type SearchResult,
    RelationType,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { type ISearchArgs } from "./indexing/BaseEventIndexManager";
import EventIndexPeg from "./indexing/EventIndexPeg";
import { isNotUndefined } from "./Typeguards";
import SettingsStore from "./settings/SettingsStore";

const SEARCH_LIMIT = 10;

// When a `from:`/sender filter is active the Seshat (local) leg cannot filter by sender at query time
// (its ISearchArgs has no sender field), so we post-filter the returned page client-side. A page of only
// SEARCH_LIMIT raw results could shrink to zero after dropping other senders, so we over-fetch from Seshat
// to give the post-filter enough candidates to still fill a page (search Phase 3 slice 2). The homeserver
// leg filters natively via IRoomEventFilter.senders and needs no over-fetch.
const SESHAT_SENDER_OVERFETCH_LIMIT = SEARCH_LIMIT * 5;

// A room-upgrade predecessor chain is normally 1-2 rooms; cap traversal so a
// malformed/cyclic predecessor graph can never spin (#32258).
const MAX_PREDECESSOR_CHAIN = 20;

/**
 * Seshat's full-text engine (tantivy) interprets an unescaped colon as a
 * `field:value` operator, so a query such as `https://github.com` is parsed as a
 * search of the non-existent field `https` and Seshat rejects the whole query
 * with `Query is invalid. FieldDoesNotExist("https")` (#32341). Wrapping the
 * term in double quotes forces tantivy into phrase mode and disables the field
 * operator — the maintainer-endorsed workaround. This is applied ONLY to the
 * Seshat (local) search term, never to the homeserver search body, which does a
 * plain substring match and must keep the raw term.
 */
export function hardenSeshatSearchTerm(term: string): string {
    // A genuinely closed phrase (balanced surrounding quotes with no stray inner quote) is
    // already safe for tantivy, and a term with no field-operator character cannot trip it —
    // leave both alone. Note: a leading-but-unbalanced quote (e.g. `"https://github.com`) is
    // NOT treated as a phrase here; it falls through to be escaped and re-wrapped so tantivy
    // does not reject it as an odd-quote syntax error.
    const isClosedPhrase =
        term.length >= 2 && term.startsWith('"') && term.endsWith('"') && !term.slice(1, -1).includes('"');
    if (isClosedPhrase || !term.includes(":")) return term;
    // Escape any embedded double quotes so the phrase stays well-formed, then phrase-wrap.
    return `"${term.replace(/"/g, '\\"')}"`;
}

interface IReplaceRelation {
    rel_type?: string;
    event_id?: string;
}

/**
 * Seshat indexes message edits (`m.replace`) as standalone events, so a search
 * for the edited text matches the edit event rather than the original message.
 * The search render path has no tile for a replace relation
 * (`haveRendererForEvent` -> `isRelation(RelationType.Replace)` returns false),
 * so the result silently fails to render even though the reported count includes
 * it (#32356). The live timeline never hits this because the SDK aggregates the
 * edit onto its target; that aggregation does not run in the search path.
 *
 * We cannot simply rewrite the edit's content, because the SDK event mapper
 * (`eventMapperFor`) resolves a result via `room.findEventById(event_id)` and,
 * when the event is loaded, REUSES that live model verbatim — discarding any
 * content we mutated and re-dropping the live `m.replace`. So instead we re-key
 * the result to the edit's TARGET (the original message id): the mapper then
 * resolves the renderable original — which already carries the aggregated edit
 * in a loaded room — and, when the original is not loaded, builds a fresh event
 * from the promoted `m.new_content` we leave behind. Either way the edited text
 * renders and the permalink targets the original message.
 *
 * We touch `content` and `event_id` only; the encryption sidecar fields
 * (curve25519Key/ed25519Key/algorithm/forwardingCurve25519KeyChain) that
 * `restoreEncryptionInfo` re-reads live at the event top level and are preserved.
 */
function promoteReplacementContent(event: Record<string, unknown> | undefined): void {
    const content = event?.content as Record<string, unknown> | undefined;
    if (!content) return;
    const relatesTo = content["m.relates_to"] as IReplaceRelation | undefined;
    const newContent = content["m.new_content"] as Record<string, unknown> | undefined;
    // Only act on a well-formed edit: a Replace relation with a target event id and a
    // non-empty replacement body (an empty m.new_content would otherwise blank the tile).
    if (
        relatesTo?.rel_type !== RelationType.Replace ||
        typeof relatesTo.event_id !== "string" ||
        typeof newContent?.body !== "string"
    ) {
        return;
    }
    event!.content = { ...newContent };
    event!.event_id = relatesTo.event_id;
}

/**
 * Post-process a raw Seshat search response in place: strip the spurious
 * `state_key: null` Seshat attaches to non-state events (which makes the SDK
 * treat them as state events) from every event, promote a matched edit so it
 * renders (#32356), and de-duplicate results that now resolve to the same
 * message (a promoted edit re-keyed to its original id alongside the original
 * itself) to avoid duplicate tiles / React-key collisions in RoomSearchView.
 */
function sanitizeSeshatResults(localResult: IResultRoomEvents): void {
    if (!localResult.results) return;
    const stripStateKey = (event: Record<string, unknown> | undefined): void => {
        if (event?.state_key === null) delete event.state_key;
    };
    for (const searchResult of localResult.results) {
        const matched = searchResult.result as unknown as Record<string, unknown>;
        stripStateKey(matched);
        // Promote only the MATCHED event: re-keying a context event would risk colliding
        // its id with another result/context event, and an edit appearing only as context
        // is harmlessly skipped by the renderer as before.
        promoteReplacementContent(matched);
        if (searchResult.context) {
            for (const ctxEvent of searchResult.context.events_before || []) {
                stripStateKey(ctxEvent as unknown as Record<string, unknown>);
            }
            for (const ctxEvent of searchResult.context.events_after || []) {
                stripStateKey(ctxEvent as unknown as Record<string, unknown>);
            }
        }
    }
    const seenIds = new Set<string>();
    localResult.results = localResult.results.filter((r) => {
        const id = (r.result as unknown as Record<string, unknown>)?.event_id;
        if (typeof id !== "string") return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
    });
}

/**
 * Drop Seshat results whose matched event was not sent by one of the selected senders, in place.
 *
 * The homeserver `/search` leg filters by sender natively (IRoomEventFilter.senders); the local Seshat
 * leg cannot, so we filter the raw response client-side before it is merged/paginated. Filtering at the
 * raw `IResultRoomEvents` level (matching `result.result.sender`, a full MXID) keeps the count/merge math
 * in one place and composes with `sanitizeSeshatResults`. A no-op when `senders` is empty.
 */
function filterSeshatResultsBySender(localResult: IResultRoomEvents | undefined, senders?: string[]): void {
    if (!localResult?.results || !senders || senders.length === 0) return;
    const allowed = new Set(senders);
    localResult.results = localResult.results.filter((r) => allowed.has(r.result.sender));
}

/**
 * Build the room-id search chain for a single-room search: the room itself
 * followed by its room-upgrade predecessors (#32258). Seshat indexes per
 * room_id and an upgraded room's new id differs from the old one, so without
 * walking `findPredecessor()` a single-room search can never see pre-upgrade
 * history. Cycle-guarded and depth-capped.
 */
export function getRoomSearchChain(client: MatrixClient, roomId: string): string[] {
    const dynamicPredecessors = SettingsStore.getValue("feature_dynamic_room_predecessors");
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = roomId;
    while (current && !seen.has(current) && chain.length < MAX_PREDECESSOR_CHAIN) {
        chain.push(current);
        seen.add(current);
        const predecessorRoomId: string | undefined = client
            .getRoom(current)
            ?.findPredecessor(dynamicPredecessors)?.roomId;
        current = predecessorRoomId;
    }
    return chain;
}

async function serverSideSearch(
    client: MatrixClient,
    term: string,
    roomIds?: string[],
    abortSignal?: AbortSignal,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<{ response: ISearchResponse; query: ISearchRequestBody }> {
    const filter: IRoomEventFilter = {
        limit: SEARCH_LIMIT,
    };

    // Scope to the given rooms (a single room, or — for an upgraded room — the
    // room plus its predecessor chain so pre-upgrade history is searched, #32258).
    if (roomIds && roomIds.length > 0) filter.rooms = roomIds;

    // Scope to the given senders (the `from:` filter, search Phase 3 slice 2). The homeserver applies
    // this natively; it is independent of `rooms`, so an all-rooms search narrows by sender alone. The
    // filter rides inside `body` below, which is stored as `_query` and replayed on every paginated
    // request, so server-side pagination keeps the sender scope with no extra work.
    if (senders && senders.length > 0) filter.senders = senders;

    const body: ISearchRequestBody = {
        search_categories: {
            room_events: {
                search_term: term,
                filter: filter,
                // Recency by default; the search header's order toggle can request relevance (search Phase 5
                // slice 1). The order rides inside `body` (stored as `_query`) so server pagination replays it.
                order_by: order,
                event_context: {
                    before_limit: 1,
                    after_limit: 1,
                    include_profile: true,
                },
            },
        },
    };

    const response = await client.search({ body: body }, abortSignal);

    return { response, query: body };
}

async function serverSideSearchProcess(
    client: MatrixClient,
    term: string,
    roomIds?: string[],
    abortSignal?: AbortSignal,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<ISearchResults> {
    const result = await serverSideSearch(client, term, roomIds, abortSignal, senders, order);

    // The js-sdk method backPaginateRoomEventsSearch() uses _query internally
    // so we're reusing the concept here since we want to delegate the
    // pagination back to backPaginateRoomEventsSearch() in some cases.
    const searchResults: ISearchResults = {
        abortSignal,
        _query: result.query,
        results: [],
        highlights: [],
    };

    return client.processRoomEventsSearch(searchResults, result.response);
}

function compareEvents(a: ISearchResult, b: ISearchResult): number {
    const aEvent = a.result;
    const bEvent = b.result;

    if (aEvent.origin_server_ts > bEvent.origin_server_ts) return -1;
    if (aEvent.origin_server_ts < bEvent.origin_server_ts) return 1;

    return 0;
}

async function combinedSearch(
    client: MatrixClient,
    searchTerm: string,
    abortSignal?: AbortSignal,
    senders?: string[],
): Promise<ISearchResults> {
    // Run the server-side and the local (Seshat) search concurrently, but
    // tolerate one leg failing: Seshat rejects some queries the homeserver
    // accepts and vice-versa (e.g. a URL trips tantivy's `field:` operator and
    // Seshat throws FieldDoesNotExist, #32341). Promise.all used to reject the
    // entire "All Rooms" search whenever either leg threw; degrade to the
    // surviving leg's results instead, and only fail if BOTH legs fail.
    //
    // Both legs are intentionally left on the recency default (no order param): the sliding-window merge below
    // (combineEvents/compareOldestEvents, which pages the next leg by oldest timestamp) only preserves global
    // order when both sources are recency-sorted, so the search header's relevance order is NOT honoured for an
    // all-rooms search in slice 1 — it would corrupt cross-page order. Honouring relevance here needs a
    // merge-by-rank/page-by-lowest-rank-frontier redesign (search Phase 5, deferred).
    const [serverSettled, localSettled] = await Promise.allSettled([
        serverSideSearch(client, searchTerm, undefined, abortSignal, senders),
        localSearch(searchTerm, undefined, senders),
    ]);

    if (serverSettled.status === "rejected" && localSettled.status === "rejected") {
        logger.error("Both server-side and local search failed", serverSettled.reason, localSettled.reason);
        throw serverSettled.reason;
    }

    // Degradation is intentionally sticky for the session: a leg that fails here leaves its
    // query undefined, so eventIndexSearchPagination routes later pages to the surviving leg
    // only (it never retries the failed one). This is sound because each leg returns at most
    // SEARCH_LIMIT results, so the degraded first page never overflows into cachedEvents (which
    // the single-leg paginators do not drain). A future limit bump would need to revisit this.

    let serverSideResult: { response: ISearchResponse; query: ISearchRequestBody } | undefined;
    if (serverSettled.status === "fulfilled") {
        serverSideResult = serverSettled.value;
    } else {
        logger.warn("Server-side search failed; returning local search results only", serverSettled.reason);
    }

    let localResult: { response: IResultRoomEvents; query: ISearchArgs } | undefined;
    if (localSettled.status === "fulfilled") {
        localResult = localSettled.value;
    } else {
        logger.warn("Local (Seshat) search failed; returning server-side search results only", localSettled.reason);
    }

    const serverQuery = serverSideResult?.query;
    const serverResponse = serverSideResult?.response;

    const localQuery = localResult?.query;
    const localResponse = localResult?.response;

    // Store our queries for later on so we can support pagination.
    //
    // We're reusing _query here again to not introduce separate code paths and
    // concepts for our different pagination methods. We're storing the
    // server-side next batch separately since the query is the json body of
    // the request and next_batch needs to be a query parameter.
    //
    // We can't put it in the final result that _processRoomEventsSearch()
    // returns since that one can be either a server-side one, a local one or a
    // fake one to fetch the remaining cached events. See the docs for
    // combineEvents() for an explanation why we need to cache events.
    const emptyResult: ISeshatSearchResults = {
        seshatQuery: localQuery,
        _query: serverQuery,
        serverSideNextBatch: serverResponse?.search_categories.room_events.next_batch,
        cachedEvents: [],
        oldestEventFrom: "server",
        results: [],
        highlights: [],
        // Remember the sender filter so combinedPagination can re-apply the post-filter to later Seshat
        // pages (the server leg keeps it via the stored _query). The Seshat leg over-fetches, so with a
        // sender filter a degraded (server-failed) combined search may push overflow into cachedEvents
        // that the single-leg local paginator does not drain — accepted as a v1 limitation, matching the
        // existing degradation note above.
        senderFilter: senders,
    };

    // Combine our results (combineResponses tolerates either source being undefined,
    // so a degraded single-leg search still produces a valid, paginatable result).
    const combinedResult = combineResponses(emptyResult, localResponse, serverResponse?.search_categories.room_events);

    // Let the client process the combined result.
    const response: ISearchResponse = {
        search_categories: {
            room_events: combinedResult,
        },
    };

    const result = client.processRoomEventsSearch(emptyResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(result.results);

    return result;
}

function buildSeshatSearchArgs(
    searchTerm: string,
    roomId?: string,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): ISearchArgs {
    const hasSenderFilter = !!senders && senders.length > 0;
    return {
        search_term: hardenSeshatSearchTerm(searchTerm),
        before_limit: 1,
        after_limit: 1,
        // Over-fetch when a sender filter is active so the client-side post-filter still has enough
        // candidates to fill a page (search Phase 3 slice 2). Seshat has no native sender filter.
        limit: hasSenderFilter ? SESHAT_SENDER_OVERFETCH_LIMIT : SEARCH_LIMIT,
        // Recency unless the order toggle requested relevance (search Phase 5 slice 1): with order_by_recency
        // false, Seshat/tantivy orders results by its full-text relevance (BM25) score instead of timestamp.
        order_by_recency: order !== SearchOrderBy.Rank,
        room_id: roomId,
    };
}

async function localSearch(
    searchTerm: string,
    roomId?: string,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<{ response: IResultRoomEvents; query: ISearchArgs }> {
    const eventIndex = EventIndexPeg.get();

    const searchArgs = buildSeshatSearchArgs(searchTerm, roomId, senders, order);

    const localResult = await eventIndex!.search(searchArgs);
    if (!localResult) {
        throw new Error("Local search failed");
    }

    // Strip Seshat's spurious `state_key: null` (which makes the SDK treat non-state events as
    // state events) and promote edited messages so they render in results (#32356).
    sanitizeSeshatResults(localResult);

    // Apply the `from:`/sender filter Seshat cannot do at query time (search Phase 3 slice 2).
    filterSeshatResultsBySender(localResult, senders);

    searchArgs.next_batch = localResult.next_batch;

    const result = {
        response: localResult,
        query: searchArgs,
    };

    return result;
}

export interface ISeshatSearchResults extends ISearchResults {
    seshatQuery?: ISearchArgs;
    cachedEvents?: ISearchResult[];
    oldestEventFrom?: "local" | "server";
    serverSideNextBatch?: string;
    // Per-room Seshat queries when searching an upgraded room across its predecessor
    // chain locally (#32258). Each entry carries its own room_id + next_batch so the
    // chain can be paginated independently.
    seshatChainQueries?: ISearchArgs[];
    // The active `from:`/sender filter (full MXIDs), carried so each Seshat pagination page can re-apply
    // the client-side post-filter Seshat cannot do at query time (search Phase 3 slice 2). The homeserver
    // leg keeps the filter via the stored `_query` body and needs no carry here.
    senderFilter?: string[];
}

// Sentinel next_batch token marking a local multi-room (predecessor-chain) search that
// still has buffered/uncrawled results to page through.
const LOCAL_CHAIN_NEXT_BATCH = "local-chain";

async function localSearchProcess(
    client: MatrixClient,
    searchTerm: string,
    roomId?: string,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<ISeshatSearchResults> {
    const emptyResult = {
        results: [],
        highlights: [],
        senderFilter: senders,
    } as ISeshatSearchResults;

    if (searchTerm === "") return emptyResult;

    const result = await localSearch(searchTerm, roomId, senders, order);

    emptyResult.seshatQuery = result.query;

    const response: ISearchResponse = {
        search_categories: {
            room_events: result.response,
        },
    };

    const processedResult = client.processRoomEventsSearch(emptyResult, response);
    // Restore our encryption info so we can properly re-verify the events.
    restoreEncryptionInfo(processedResult.results);

    return processedResult;
}

async function localPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (!searchResult.seshatQuery) {
        throw new Error("localSearchProcess must be called first");
    }

    const localResult = await eventIndex!.search(searchResult.seshatQuery);
    if (!localResult) {
        throw new Error("Local search pagination failed");
    }

    // Re-apply the `from:`/sender post-filter to this page (search Phase 3 slice 2); the over-fetch limit
    // is already baked into the stored seshatQuery.
    filterSeshatResultsBySender(localResult, searchResult.senderFilter);

    searchResult.seshatQuery.next_batch = localResult.next_batch;

    // We only need to restore the encryption state for the new results, so
    // remember how many of them we got.
    const newResultCount = localResult.results?.length ?? 0;

    const response = {
        search_categories: {
            room_events: localResult,
        },
    };

    const result = client.processRoomEventsSearch(searchResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);

    searchResult.pendingRequest = undefined;

    return result;
}

/**
 * Merge a freshly-fetched batch of local results into the carry-over cache,
 * emit the newest SEARCH_LIMIT for this page, and return the remainder to cache.
 * Because every non-exhausted chain room is paged on every call, each room's
 * frontier stays <= the page's minimum timestamp, so this simple re-sort
 * preserves global recency order across pages (#32258).
 */
function mergeChainResults(
    newResults: ISearchResult[],
    cache: ISearchResult[],
): { page: ISearchResult[]; cache: ISearchResult[] } {
    const combined = newResults.concat(cache).sort(compareEvents);
    return { page: combined.slice(0, SEARCH_LIMIT), cache: combined.slice(SEARCH_LIMIT) };
}

/**
 * Run a single page of a Seshat search for one chain room, post-process it, and
 * advance that room's next_batch in place. An empty reply marks the room
 * exhausted rather than failing the whole search.
 */
async function fetchChainRoomPage(
    query: ISearchArgs,
    senders?: string[],
): Promise<{ results: ISearchResult[]; count: number; highlights: string[] }> {
    const eventIndex = EventIndexPeg.get();
    const localResult = await eventIndex!.search(query);
    if (!localResult) {
        query.next_batch = undefined;
        return { results: [], count: 0, highlights: [] };
    }
    sanitizeSeshatResults(localResult);
    // Apply the `from:`/sender post-filter to this chain room's page (search Phase 3 slice 2).
    filterSeshatResultsBySender(localResult, senders);
    query.next_batch = localResult.next_batch;
    return {
        results: localResult.results ?? [],
        count: localResult.count ?? 0,
        highlights: localResult.highlights ?? [],
    };
}

/**
 * Search across an upgraded room's predecessor chain (#32258). The encrypted
 * rooms in the chain are searched locally via Seshat (which only filters on a
 * single scalar room_id, so each is queried separately); any chain rooms that
 * are known to be NON-encrypted are searched on the homeserver (Seshat never
 * indexes them) — covering the mixed-encryption upgrade case. All sources are
 * recency-ordered, so a single k-way merge by timestamp yields the page, reusing
 * the same processRoomEventsSearch + restoreEncryptionInfo path as a single-room
 * search. Because every non-exhausted source is paged on every call, each
 * source's frontier stays <= the page minimum, so pagination preserves global
 * recency order.
 */
async function chainSearchProcess(
    client: MatrixClient,
    searchTerm: string,
    seshatRoomIds: string[],
    serverRoomIds: string[],
    abortSignal?: AbortSignal,
    senders?: string[],
): Promise<ISeshatSearchResults> {
    const result: ISeshatSearchResults = {
        results: [],
        highlights: [],
        cachedEvents: [],
        seshatChainQueries: [],
        senderFilter: senders,
    };

    if (searchTerm === "") return result;

    // Every source is left on the recency default: mergeChainResults re-sorts the pooled pages by timestamp
    // (compareEvents), and the cross-page invariant only holds for recency-sorted sources, so the search
    // header's relevance order is NOT honoured on a predecessor-chain search in slice 1 (search Phase 5,
    // deferred with the all-rooms case in combinedSearch).
    const queries = seshatRoomIds.map((id) => buildSeshatSearchArgs(searchTerm, id, senders));
    const [pages, server] = await Promise.all([
        Promise.all(queries.map((q) => fetchChainRoomPage(q, senders))),
        serverRoomIds.length > 0
            ? serverSideSearch(client, searchTerm, serverRoomIds, abortSignal, senders)
            : Promise.resolve(undefined),
    ]);

    let count = 0;
    let highlights: string[] = [];
    let pool: ISearchResult[] = [];
    for (const eventPage of pages) {
        count += eventPage.count;
        highlights = highlights.concat(eventPage.highlights);
        pool = pool.concat(eventPage.results);
    }
    if (server) {
        const serverEvents = server.response.search_categories.room_events;
        count += serverEvents.count ?? 0;
        highlights = highlights.concat(serverEvents.highlights ?? []);
        pool = pool.concat(serverEvents.results ?? []);
        result._query = server.query;
        result.serverSideNextBatch = serverEvents.next_batch;
    }

    const { page, cache } = mergeChainResults(pool, []);
    const hasMore = cache.length > 0 || queries.some((q) => !!q.next_batch) || !!result.serverSideNextBatch;

    result.seshatChainQueries = queries;
    result.cachedEvents = cache;
    result.count = count;

    const response: ISearchResponse = {
        search_categories: {
            room_events: {
                results: page,
                highlights: Array.from(new Set(highlights)),
                count,
                next_batch: hasMore ? LOCAL_CHAIN_NEXT_BATCH : undefined,
            },
        },
    };

    const processedResult = client.processRoomEventsSearch(result, response);
    restoreEncryptionInfo(processedResult.results);

    return processedResult;
}

async function chainSearchPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const queries = searchResult.seshatChainQueries ?? [];

    // Page every chain source that still has a next_batch (Seshat rooms + the optional
    // homeserver leg); exhausted sources are skipped.
    const [pages, server] = await Promise.all([
        Promise.all(
            queries.map((q) =>
                q.next_batch
                    ? fetchChainRoomPage(q, searchResult.senderFilter)
                    : Promise.resolve({ results: [], count: 0, highlights: [] }),
            ),
        ),
        searchResult._query && searchResult.serverSideNextBatch
            ? client.search({ body: searchResult._query, next_batch: searchResult.serverSideNextBatch })
            : Promise.resolve(undefined),
    ]);

    const newResults: ISearchResult[] = pages.flatMap((p) => p.results);
    if (server) {
        const serverEvents = server.search_categories.room_events;
        newResults.push(...(serverEvents.results ?? []));
        searchResult.serverSideNextBatch = serverEvents.next_batch;
    }

    const { page, cache } = mergeChainResults(newResults, searchResult.cachedEvents ?? []);
    searchResult.cachedEvents = cache;

    const hasMore = cache.length > 0 || queries.some((q) => !!q.next_batch) || !!searchResult.serverSideNextBatch;

    const response: ISearchResponse = {
        search_categories: {
            room_events: {
                results: page,
                highlights: searchResult.highlights ?? [],
                count: searchResult.count,
                next_batch: hasMore ? LOCAL_CHAIN_NEXT_BATCH : undefined,
            },
        },
    };

    const oldResultCount = searchResult.results ? searchResult.results.length : 0;
    const result = client.processRoomEventsSearch(searchResult, response);

    const newResultCount = result.results.length - oldResultCount;
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);

    searchResult.pendingRequest = undefined;

    return result;
}

function compareOldestEvents(firstResults: ISearchResult[], secondResults: ISearchResult[]): number {
    try {
        const oldestFirstEvent = firstResults[firstResults.length - 1].result;
        const oldestSecondEvent = secondResults[secondResults.length - 1].result;

        if (oldestFirstEvent.origin_server_ts <= oldestSecondEvent.origin_server_ts) {
            return -1;
        } else {
            return 1;
        }
    } catch {
        return 0;
    }
}

function combineEventSources(
    previousSearchResult: ISeshatSearchResults,
    response: IResultRoomEvents,
    a: ISearchResult[],
    b: ISearchResult[],
): void {
    // Merge event sources and sort the events.
    const combinedEvents = a.concat(b).sort(compareEvents);
    // Put half of the events in the response, and cache the other half.
    response.results = combinedEvents.slice(0, SEARCH_LIMIT);
    previousSearchResult.cachedEvents = combinedEvents.slice(SEARCH_LIMIT);
}

/**
 * Combine the events from our event sources into a sorted result
 *
 * This method will first be called from the combinedSearch() method. In this
 * case we will fetch SEARCH_LIMIT events from the server and the local index.
 *
 * The method will put the SEARCH_LIMIT newest events from the server and the
 * local index in the results part of the response, the rest will be put in the
 * cachedEvents field of the previousSearchResult (in this case an empty search
 * result).
 *
 * Every subsequent call will be made from the combinedPagination() method, in
 * this case we will combine the cachedEvents and the next SEARCH_LIMIT events
 * from either the server or the local index.
 *
 * Since we have two event sources and we need to sort the results by date we
 * need keep on looking for the oldest event. We are implementing a variation of
 * a sliding window.
 *
 * The event sources are here represented as two sorted lists where the smallest
 * number represents the newest event. The two lists need to be merged in a way
 * that preserves the sorted property so they can be shown as one search result.
 * We first fetch SEARCH_LIMIT events from both sources.
 *
 * If we set SEARCH_LIMIT to 3:
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                |01, 02, 04|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |03, 05, 09|
 *
 *  We note that the oldest event is from the local index, and we combine the
 *  results:
 *
 *  Server window [01, 02, 04]
 *  Local window  [03, 05, 09]
 *
 *  Combined events [01, 02, 03, 04, 05, 09]
 *
 *  We split the combined result in the part that we want to present and a part
 *  that will be cached.
 *
 *  Presented events [01, 02, 03]
 *  Cached events    [04, 05, 09]
 *
 *  We slide the window for the server since the oldest event is from the local
 *  index.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |06, 07, 08|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                |XX, XX, XX|
 *  Cached events [04, 05, 09]
 *
 *  We note that the oldest event is from the server and we combine the new
 *  server events with the cached ones.
 *
 *  Cached events [04, 05, 09]
 *  Server events [06, 07, 08]
 *
 *  Combined events [04, 05, 06, 07, 08, 09]
 *
 *  We split again.
 *
 *  Presented events [04, 05, 06]
 *  Cached events    [07, 08, 09]
 *
 *  We slide the local window, the oldest event is on the server.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                            |XX, XX, XX|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |10, 12, 14|
 *
 *  Cached events [07, 08, 09]
 *  Local events  [10, 12, 14]
 *  Combined events [07, 08, 09, 10, 12, 14]
 *
 *  Presented events [07, 08, 09]
 *  Cached events    [10, 12, 14]
 *
 *  Next up we slide the server window again.
 *
 *  Server events [01, 02, 04, 06, 07, 08, 11, 13]
 *                                        |11, 13|
 *  Local events  [03, 05, 09, 10, 12, 14, 15, 16]
 *                            |XX, XX, XX|
 *
 *  Cached events [10, 12, 14]
 *  Server events [11, 13]
 *  Combined events [10, 11, 12, 13, 14]
 *
 *  Presented events [10, 11, 12]
 *  Cached events    [13, 14]
 *
 *  We have one source exhausted, we fetch the rest of our events from the other
 *  source and combine it with our cached events.
 *
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @return {object} A response object that combines the events from the
 * different event sources.
 *
 */
function combineEvents(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    const response = {} as IResultRoomEvents;

    const cachedEvents = previousSearchResult.cachedEvents ?? [];
    let oldestEventFrom = previousSearchResult.oldestEventFrom;
    response.highlights = previousSearchResult.highlights;

    if (localEvents && serverEvents && serverEvents.results) {
        // This is a first search call, combine the events from the server and
        // the local index. Note where our oldest event came from, we shall
        // fetch the next batch of events from the other source.
        if (compareOldestEvents(localEvents.results ?? [], serverEvents.results) < 0) {
            oldestEventFrom = "local";
        }

        combineEventSources(previousSearchResult, response, localEvents.results ?? [], serverEvents.results);
        response.highlights = (localEvents.highlights ?? []).concat(serverEvents.highlights ?? []);
    } else if (localEvents) {
        // This is a pagination call fetching more events from the local index,
        // meaning that our oldest event was on the server.
        // Change the source of the oldest event if our local event is older
        // than the cached one.
        if (compareOldestEvents(localEvents.results ?? [], cachedEvents) < 0) {
            oldestEventFrom = "local";
        }
        combineEventSources(previousSearchResult, response, localEvents.results ?? [], cachedEvents);
    } else if (serverEvents && serverEvents.results) {
        // This is a pagination call fetching more events from the server,
        // meaning that our oldest event was in the local index.
        // Change the source of the oldest event if our server event is older
        // than the cached one.
        if (compareOldestEvents(serverEvents.results, cachedEvents) < 0) {
            oldestEventFrom = "server";
        }
        combineEventSources(previousSearchResult, response, serverEvents.results, cachedEvents);
    } else {
        // This is a pagination call where we exhausted both of our event
        // sources, let's push the remaining cached events.
        response.results = cachedEvents;
        previousSearchResult.cachedEvents = [];
    }

    previousSearchResult.oldestEventFrom = oldestEventFrom;

    return response;
}

/**
 * Combine the local and server search responses
 *
 * @param {object} previousSearchResult A search result from a previous search
 * call.
 * @param {object} localEvents An unprocessed search result from the event
 * index.
 * @param {object} serverEvents An unprocessed search result from the server.
 *
 * @return {object} A response object that combines the events from the
 * different event sources.
 */
function combineResponses(
    previousSearchResult: ISeshatSearchResults,
    localEvents?: IResultRoomEvents,
    serverEvents?: IResultRoomEvents,
): IResultRoomEvents {
    // Combine our events first.
    const response = combineEvents(previousSearchResult, localEvents, serverEvents);

    // Our first search will contain counts from both sources, subsequent
    // pagination requests will fetch responses only from one of the sources, so
    // reuse the first count when we're paginating.
    if (previousSearchResult.count) {
        response.count = previousSearchResult.count;
    } else {
        const localEventCount = localEvents?.count ?? 0;
        const serverEventCount = serverEvents?.count ?? 0;

        response.count = localEventCount + serverEventCount;
    }

    // Update our next batch tokens for the given search sources.
    if (localEvents && isNotUndefined(previousSearchResult.seshatQuery)) {
        previousSearchResult.seshatQuery.next_batch = localEvents.next_batch;
    }
    if (serverEvents) {
        previousSearchResult.serverSideNextBatch = serverEvents.next_batch;
    }

    // Set the response next batch token to one of the tokens from the sources,
    // this makes sure that if we exhaust one of the sources we continue with
    // the other one.
    if (previousSearchResult.seshatQuery?.next_batch) {
        response.next_batch = previousSearchResult.seshatQuery.next_batch;
    } else if (previousSearchResult.serverSideNextBatch) {
        response.next_batch = previousSearchResult.serverSideNextBatch;
    }

    // We collected all search results from the server as well as from Seshat,
    // we still have some events cached that we'll want to display on the next
    // pagination request.
    //
    // Provide a fake next batch token for that case.
    if (
        !response.next_batch &&
        isNotUndefined(previousSearchResult.cachedEvents) &&
        previousSearchResult.cachedEvents.length > 0
    ) {
        response.next_batch = "cached";
    }

    return response;
}

interface IEncryptedSeshatEvent {
    curve25519Key?: string;
    ed25519Key?: string;
    algorithm?: string;
    forwardingCurve25519KeyChain?: string[];
}

function restoreEncryptionInfo(searchResultSlice: SearchResult[] = []): void {
    for (const result of searchResultSlice) {
        const timeline = result.context.getTimeline();

        for (const mxEv of timeline) {
            const ev = mxEv.event as IEncryptedSeshatEvent;

            if (ev.curve25519Key) {
                mxEv.makeEncrypted(
                    EventType.RoomMessageEncrypted,
                    { algorithm: ev.algorithm },
                    ev.curve25519Key,
                    ev.ed25519Key!,
                );
                // @ts-ignore
                mxEv.forwardingCurve25519KeyChain = ev.forwardingCurve25519KeyChain;

                delete ev.curve25519Key;
                delete ev.ed25519Key;
                delete ev.algorithm;
                delete ev.forwardingCurve25519KeyChain;
            }
        }
    }
}

async function combinedPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    const eventIndex = EventIndexPeg.get();

    const searchArgs = searchResult.seshatQuery;
    const oldestEventFrom = searchResult.oldestEventFrom;

    let localResult: IResultRoomEvents | undefined;
    let serverSideResult: ISearchResponse | undefined;

    // Fetch events from the local index if we have a token for it and if it's
    // the local indexes turn or the server has exhausted its results.
    if (searchArgs?.next_batch && (!searchResult.serverSideNextBatch || oldestEventFrom === "server")) {
        localResult = await eventIndex!.search(searchArgs);
        // Re-apply the `from:`/sender post-filter to this Seshat page (search Phase 3 slice 2); the server
        // leg keeps the filter natively via the stored _query body.
        filterSeshatResultsBySender(localResult, searchResult.senderFilter);
    }

    // Fetch events from the server if we have a token for it and if it's the
    // local indexes turn or the local index has exhausted its results.
    if (searchResult.serverSideNextBatch && (oldestEventFrom === "local" || !searchArgs?.next_batch)) {
        const body = { body: searchResult._query!, next_batch: searchResult.serverSideNextBatch };
        serverSideResult = await client.search(body);
    }

    const serverEvents: IResultRoomEvents | undefined = serverSideResult?.search_categories.room_events;

    // Combine our events.
    const combinedResult = combineResponses(searchResult, localResult, serverEvents);

    const response = {
        search_categories: {
            room_events: combinedResult,
        },
    };

    const oldResultCount = searchResult.results ? searchResult.results.length : 0;

    // Let the client process the combined result.
    const result = client.processRoomEventsSearch(searchResult, response);

    // Restore our encryption info so we can properly re-verify the events.
    const newResultCount = result.results.length - oldResultCount;
    const newSlice = result.results.slice(Math.max(result.results.length - newResultCount, 0));
    restoreEncryptionInfo(newSlice);

    searchResult.pendingRequest = undefined;

    return result;
}

async function eventIndexSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<ISearchResults> {
    let searchPromise: Promise<ISearchResults>;

    if (roomId !== undefined) {
        // Search the room together with its room-upgrade predecessors so pre-upgrade
        // history is included (#32258). Partition the chain by encryption: a room KNOWN
        // (loaded) to be non-encrypted lives on the homeserver, not in Seshat; everything
        // else (encrypted, or an unloaded predecessor that may be encrypted-and-indexed) is
        // searched locally. This keeps the common encrypted-only chain on Seshat while also
        // covering a mixed-encryption upgrade.
        const roomIds = getRoomSearchChain(client, roomId);
        const crypto = client.getCrypto();
        const seshatRoomIds: string[] = [];
        const serverRoomIds: string[] = [];
        for (const id of roomIds) {
            if (client.getRoom(id) && !(await crypto?.isEncryptionEnabledInRoom(id))) {
                serverRoomIds.push(id);
            } else {
                seshatRoomIds.push(id);
            }
        }

        if (seshatRoomIds.length === 0) {
            // Entirely (known) non-encrypted chain: server-side search scoped to the chain. Single source, so the
            // backend order is honoured verbatim — thread the requested order through (search Phase 5 slice 1).
            searchPromise = serverSideSearchProcess(client, term, roomIds, abortSignal, senders, order);
        } else if (seshatRoomIds.length === 1 && serverRoomIds.length === 0) {
            // Single encrypted room, no predecessors — the common case. Single Seshat source, so the requested
            // order is honoured (recency vs Seshat relevance) (search Phase 5 slice 1).
            searchPromise = localSearchProcess(client, term, seshatRoomIds[0], senders, order);
        } else {
            // Multi-room chain (encrypted predecessors and/or known non-encrypted ones):
            // Seshat for the local rooms, homeserver for the known non-encrypted ones, merged. The merge re-sorts
            // by recency, so `order` is intentionally NOT threaded here (forced recency, see chainSearchProcess).
            searchPromise = chainSearchProcess(client, term, seshatRoomIds, serverRoomIds, abortSignal, senders);
        }
    } else {
        // Search across all rooms, combine a server side search and a local search. The combined merge re-sorts
        // by recency, so `order` is intentionally NOT threaded here (forced recency, see combinedSearch).
        searchPromise = combinedSearch(client, term, abortSignal, senders);
    }

    return searchPromise;
}

function eventIndexSearchPagination(
    client: MatrixClient,
    searchResult: ISeshatSearchResults,
): Promise<ISeshatSearchResults> {
    // A multi-room (predecessor chain) search paginates each chain source — the Seshat
    // rooms and the optional homeserver leg (#32258). Checked first because such a result
    // may also carry _query (the server leg) which would otherwise mis-route below.
    if (searchResult.seshatChainQueries) {
        const promise = chainSearchPagination(client, searchResult);
        searchResult.pendingRequest = promise;
        return promise;
    }

    const seshatQuery = searchResult.seshatQuery;
    const serverQuery = searchResult._query;

    if (!seshatQuery) {
        // This is a search in a non-encrypted room. Do the normal server-side
        // pagination.
        return client.backPaginateRoomEventsSearch(searchResult);
    } else if (!serverQuery) {
        // This is a search in a encrypted room. Do a local pagination.
        const promise = localPagination(client, searchResult);
        searchResult.pendingRequest = promise;

        return promise;
    } else {
        // We have both queries around, this is a search across all rooms so a
        // combined pagination needs to be done.
        const promise = combinedPagination(client, searchResult);
        searchResult.pendingRequest = promise;

        return promise;
    }
}

export function searchPagination(client: MatrixClient, searchResult: ISearchResults): Promise<ISearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (searchResult.pendingRequest) return searchResult.pendingRequest;

    if (eventIndex === null) return client.backPaginateRoomEventsSearch(searchResult);
    else return eventIndexSearchPagination(client, searchResult);
}

export default function eventSearch(
    client: MatrixClient,
    term: string,
    roomId?: string,
    abortSignal?: AbortSignal,
    senders?: string[],
    order: SearchOrderBy = SearchOrderBy.Recent,
): Promise<ISearchResults> {
    const eventIndex = EventIndexPeg.get();

    if (eventIndex === null) {
        // No local index: search the room plus its predecessor chain server-side (#32258).
        const roomIds = roomId !== undefined ? getRoomSearchChain(client, roomId) : undefined;
        return serverSideSearchProcess(client, term, roomIds, abortSignal, senders, order);
    } else {
        return eventIndexSearch(client, term, roomId, abortSignal, senders, order);
    }
}

/**
 * The scope for a message search, either in the current room or across all rooms.
 */
export enum SearchScope {
    Room = "Room",
    All = "All",
}

/**
 * The location of a single search match, used for stepping through matches in the live timeline.
 */
export interface SearchMatch {
    /**
     * The room the matched event belongs to.
     */
    roomId: string;
    /**
     * The id of the matched event.
     */
    eventId: string;
}

/**
 * Build a chronologically ordered list of match locations from a set of search results, for in-timeline
 * stepping.
 *
 * Matches are ordered newest-first by event timestamp so that the up/down arrows mean a consistent
 * "newer/older" independent of how the backend happened to order the raw results. (The backend order is recency
 * by default, but the search header's order toggle can request relevance ({@link SearchOrderBy.Rank}) on the
 * single-source paths (search Phase 5 slice 1); either way this explicit client-side sort guarantees a single
 * chronological order on the merged stepping list, so stepping stays "newer/older" even under relevance.)
 * `Array.prototype.sort` is stable, so matches sharing a timestamp keep their backend order; a match whose
 * event has no timestamp sinks to the end (treated as oldest). Results whose matched event is missing an event
 * id or room id are skipped — they cannot be jumped to in the timeline.
 */
export function extractSearchMatches(results: ISearchResults): SearchMatch[] {
    const matches: Array<SearchMatch & { ts: number }> = [];
    for (const result of results.results ?? []) {
        const event = result.context.getEvent();
        const eventId = event.getId();
        const roomId = event.getRoomId();
        if (eventId && roomId) {
            // getTs() is typed as number but masks a possibly-absent origin_server_ts with a non-null
            // assertion; default to 0 so an undated match can never produce a NaN comparison and corrupt order.
            matches.push({ roomId, eventId, ts: event.getTs() ?? 0 });
        }
    }
    matches.sort((a, b) => b.ts - a.ts);
    return matches.map(({ roomId, eventId }) => ({ roomId, eventId }));
}

/**
 * A single search result enriched for the Telegram-style results dropdown (search Phase 6): the jumpable location
 * ({@link SearchMatch}) plus the data a compact row needs — sender MXID, the matched message body and timestamp.
 */
export interface SearchResultPreview extends SearchMatch {
    /** The MXID of the matched event's sender. */
    sender: string;
    /** The matched message body (plain text) shown as the row preview. */
    body: string;
    /** The matched event's origin-server timestamp (ms), used to render the row date. */
    ts: number;
}

/**
 * Build the ordered list of result previews for the search results dropdown.
 *
 * Ordered identically to {@link extractSearchMatches} (newest-first by timestamp, stable, undated last, results
 * missing an event/room id skipped) so that preview row index `i` maps to match `i` — letting a row click reuse the
 * existing {@link SearchMatch}-based live-timeline stepping. Pure: the backend results are not mutated.
 */
export function extractSearchResultPreviews(results: ISearchResults): SearchResultPreview[] {
    const previews: SearchResultPreview[] = [];
    for (const result of results.results ?? []) {
        const event = result.context.getEvent();
        const eventId = event.getId();
        const roomId = event.getRoomId();
        if (eventId && roomId) {
            previews.push({
                roomId,
                eventId,
                sender: event.getSender() ?? "",
                body: event.getContent().body ?? "",
                // Default an absent timestamp to 0 so it sorts last and never produces a NaN comparison.
                ts: event.getTs() ?? 0,
            });
        }
    }
    previews.sort((a, b) => b.ts - a.ts);
    return previews;
}

/**
 * Build the ordered list of terms to highlight in matched message bodies for a set of search results.
 *
 * Mirrors the enrichment the results list applies (see RoomSearchView): the literal search term is always
 * highlighted even if the backend (Synapse/Seshat) did not echo it back, and terms are ordered longest-first so
 * that overlapping highlights favour the more specific term. Pure — the backend `highlights` array is not mutated.
 */
export function extractSearchHighlights(results: ISearchResults, term: string): string[] {
    const highlights = [...(results.highlights ?? [])];
    if (!highlights.includes(term)) {
        highlights.push(term);
    }
    return highlights.sort((a, b) => b.length - a.length);
}

/**
 * Information about a message search in progress.
 */
export interface SearchInfo {
    /**
     * Opaque ID for this search.
     */
    searchId: number;
    /**
     * The room ID being searched, or undefined if searching all rooms.
     */
    roomId?: string;
    /**
     * The search term.
     */
    term: string;
    /**
     * The scope of the search.
     */
    scope: SearchScope;
    /**
     * The active `from:`/sender filter (full MXIDs), or undefined/empty for no sender filter (search Phase 3
     * slice 2). Mirrors {@link SearchSessionParams.senders} into the per-room-view render state.
     */
    senders?: string[];
    /**
     * The requested result ordering — {@link SearchOrderBy.Recent} (default) or {@link SearchOrderBy.Rank}
     * (relevance) (search Phase 5 slice 1). Mirrors {@link SearchSessionParams.order} into the per-room-view
     * render state. Only the single-source search paths honour relevance; all-rooms/chain stay recency.
     */
    order?: SearchOrderBy;
    /**
     * The promise for the search results.
     */
    promise: Promise<ISearchResults>;
    /**
     * Controller for aborting the search.
     */
    abortController?: AbortController;
    /**
     * Whether the search is currently awaiting data from the backend.
     */
    inProgress?: boolean;
    /**
     * The total count of matching results as returned by the backend.
     */
    count?: number;
    /**
     * Ordered list of match locations (display order) used to step through matches in the live timeline.
     */
    matches?: SearchMatch[];
    /**
     * Ordered list of result previews (parallel to {@link matches}) rendered as rows in the Telegram-style results
     * dropdown (search Phase 6). See {@link extractSearchResultPreviews}.
     */
    previews?: SearchResultPreview[];
    /**
     * Index into {@link matches} of the currently-focused match, or -1/undefined when no match is active.
     */
    currentMatchIndex?: number;
    /**
     * Terms to highlight in matched message bodies (longest-first), used to highlight the focused match in the
     * live timeline while stepping. See {@link extractSearchHighlights}.
     */
    highlights?: string[];
    /**
     * Describe the error if any occured.
     */
    error?: Error;
}
