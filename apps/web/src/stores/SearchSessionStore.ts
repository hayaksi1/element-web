/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import EventEmitter from "events";
import { type ISearchResults, type SearchOrderBy } from "matrix-js-sdk/src/matrix";

import { type SearchMatch, type SearchScope } from "../Searching";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ActionPayload } from "../dispatcher/payloads";

export enum SearchSessionStoreEvent {
    Update = "update",
}

/**
 * The immutable identity of a search session — mirrors the start-time fields of a {@link SearchInfo}.
 */
export interface SearchSessionParams {
    searchId: number;
    term: string;
    scope: SearchScope;
    /** The room the search was started from, or undefined for an all-rooms search. */
    roomId?: string;
    /**
     * The active `from:`/sender filter (full MXIDs), or undefined/empty for no sender filter. Part of the
     * session identity (search Phase 3 slice 2): it survives RoomView remounts during cross-room stepping and
     * is preserved verbatim by {@link SearchSessionStore.updateResults}, so a re-search keeps the filter.
     */
    senders?: string[];
    /**
     * The requested result ordering — {@link SearchOrderBy.Recent} (default) or {@link SearchOrderBy.Rank}
     * (relevance) (search Phase 5 slice 1). Part of the session identity: it survives RoomView remounts during
     * cross-room stepping and is preserved verbatim by {@link SearchSessionStore.updateResults}, so a re-search
     * keeps the chosen order.
     */
    order?: SearchOrderBy;
    promise: Promise<ISearchResults>;
    abortController?: AbortController;
}

/**
 * The results applied to the live session as the backend settles. `matches`/`highlights` are omitted while the
 * search is still in progress.
 */
export interface SearchSessionResults {
    inProgress: boolean;
    matches?: SearchMatch[];
    highlights?: string[];
    count?: number;
    error?: Error;
}

/**
 * A snapshot of the active search session.
 */
export interface SearchSession extends SearchSessionParams {
    /** Ordered (newest-first), cross-room and unfiltered — see {@link extractSearchMatches}. */
    matches: SearchMatch[];
    /** Index into {@link matches} of the focused match, or -1 when no match is focused (viewing the results list). */
    currentMatchIndex: number;
    highlights: string[];
    count?: number;
    inProgress: boolean;
    error?: Error;
}

/**
 * Owns the live message-search session independently of any RoomView instance.
 *
 * RoomView is keyed by room id (see LoggedInView), so it unmounts/remounts on any cross-room navigation. Stepping
 * through search matches in the live timeline crosses rooms — an all-rooms search spans rooms, and even a
 * room-scoped search also searches upgraded predecessor rooms (#32258) — so the session (the ordered cross-room
 * match list, the focused index, the highlight terms and the search promise/abort controller) must outlive the
 * component. This singleton is that owner: {@link RoomView} mirrors it into its render state and re-hydrates from it
 * after a remount, while {@link RoomSearchNavigationViewModel} reads/writes the cursor here.
 */
export class SearchSessionStore extends EventEmitter {
    private static _instance: SearchSessionStore | null = null;

    private session: SearchSession | null = null;
    // Transient (not view state, so never emitted): set immediately before a stepping-driven ViewRoom dispatch so
    // RoomView's "clicked a result" / "edited an event" clear gates can tell a stepping jump apart from a genuine
    // user navigation and not tear the session down. Consumed exactly once by the result-click gate; auto-reset
    // whenever fresh results arrive or the session is cleared.
    private steppingJump = false;

    public constructor() {
        super();
        defaultDispatcher.register(this.onAction);
    }

    public static get instance(): SearchSessionStore {
        if (!SearchSessionStore._instance) {
            SearchSessionStore._instance = new SearchSessionStore();
        }
        return SearchSessionStore._instance;
    }

    private onAction = (payload: ActionPayload): void => {
        if (payload.action === Action.OnLoggedOut) {
            this.clear({ abort: true });
        }
    };

    /**
     * Begin a new search session, replacing and aborting any previous one. Matches/highlights stay empty until
     * {@link updateResults} is called once the backend settles.
     */
    public start(params: SearchSessionParams): void {
        // A new term replaces the previous session; abort its in-flight request so we never adopt stale results.
        this.session?.abortController?.abort();
        this.session = {
            ...params,
            matches: [],
            currentMatchIndex: -1,
            highlights: [],
            inProgress: true,
        };
        this.steppingJump = false;
        this.emit(SearchSessionStoreEvent.Update);
    }

    /**
     * Apply settled (or in-progress) results to the live session. No-op if there is no active session.
     */
    public updateResults(results: SearchSessionResults): void {
        if (!this.session) return;
        this.session = {
            ...this.session,
            inProgress: results.inProgress,
            matches: results.matches ?? this.session.matches,
            highlights: results.highlights ?? this.session.highlights,
            count: results.count,
            error: results.error,
            // A fresh result set invalidates the cursor; RoomView resets its mirror in lockstep.
            currentMatchIndex: -1,
        };
        // Fresh results end any in-flight stepping jump.
        this.steppingJump = false;
        this.emit(SearchSessionStoreEvent.Update);
    }

    /**
     * Move the focused-match cursor. `-1` means "no match focused" (viewing the results list).
     */
    public setCurrentMatchIndex(index: number): void {
        if (!this.session || this.session.currentMatchIndex === index) return;
        this.session = { ...this.session, currentMatchIndex: index };
        this.emit(SearchSessionStoreEvent.Update);
    }

    /** Mark that the next ViewRoom dispatch is a stepping jump, not a user navigation. */
    public beginSteppingJump(): void {
        this.steppingJump = true;
    }

    /** Read and reset the stepping-jump flag. Used by the result-click clear gate (exactly-once). */
    public consumeSteppingJump(): boolean {
        const value = this.steppingJump;
        this.steppingJump = false;
        return value;
    }

    /** Read the stepping-jump flag without resetting it. Used by the edit clear gate. */
    public isSteppingJump(): boolean {
        return this.steppingJump;
    }

    /**
     * End the session. Aborts the in-flight request unless `abort` is false (the session is never cleared on a
     * remount, so the surviving promise is never rejected by a room switch).
     */
    public clear({ abort = true }: { abort?: boolean } = {}): void {
        if (abort) {
            this.session?.abortController?.abort();
        }
        this.session = null;
        this.steppingJump = false;
        this.emit(SearchSessionStoreEvent.Update);
    }

    public hasActiveSession(): boolean {
        return this.session !== null;
    }

    public getSnapshot(): SearchSession | null {
        return this.session;
    }

    public get matches(): SearchMatch[] {
        return this.session?.matches ?? [];
    }

    public get currentMatchIndex(): number {
        return this.session?.currentMatchIndex ?? -1;
    }
}
