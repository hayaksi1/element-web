/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useEffect, useRef, useState } from "react";
import { Form, IconButton, Link, Search } from "@vector-im/compound-web";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import ListIcon from "@vector-im/compound-design-tokens/assets/web/icons/list-view";
import { type Room, type SearchOrderBy } from "matrix-js-sdk/src/matrix";
import { Box, Flex } from "@element-hq/web-shared-components";
import { SearchMatchNavigation, type SearchMatchNavigationViewModel } from "@element-hq/web-shared-components";

import { _t } from "../../../languageHandler";
import { Key } from "../../../Keyboard";
import { useDispatcher } from "../../../hooks/useDispatcher";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type SearchMatchStepPayload } from "../../../dispatcher/payloads/SearchMatchStepPayload";
import { type SearchInfo, SearchScope } from "../../../Searching";
import SearchWarning, { WarningKind } from "../elements/SearchWarning";
import InlineSpinner from "../elements/InlineSpinner";
import { PosthogScreenTracker } from "../../../PosthogTrackers";
import { RoomSearchSenderFilter } from "../right_panel/RoomSearchSenderFilter";
import { RoomSearchJumpToDate } from "../right_panel/RoomSearchJumpToDate";
import { RoomSearchOrderToggle } from "../right_panel/RoomSearchOrderToggle";

interface Props {
    /** The room being searched; mounts the member-scoped `from:` filter keyed by its id. */
    room: Room;
    /** The active search term. Controlled — the parent debounces {@link Props.onSearchChange}. */
    term: string;
    /** Report a new term to the parent (RoomView debounces it into a search). */
    onSearchChange: (term: string) => void;
    /** End the search and restore the normal room header. */
    onCancel: () => void;
    isRoomEncrypted: boolean;
    /** Backend result metadata (count / error) for the "N results found" summary. */
    searchInfo?: SearchInfo;
    /** Drives the in-timeline "k of N" match stepper (arrows + counter); hidden when it has no matches. */
    navigationVm?: SearchMatchNavigationViewModel;
    scope: SearchScope;
    onSearchScopeChange: (scope: SearchScope) => void;
    senders: string[];
    onSearchSendersChange: (senders: string[]) => void;
    order: SearchOrderBy;
    onSearchOrderChange: (order: SearchOrderBy) => void;
    /** Return from live-timeline match stepping to the results list (only surfaced while stepping). */
    onBackToResults?: () => void;
    /** Focus the input on mount (Cmd+F entry). */
    autoFocus?: boolean;
}

/**
 * Telegram-style in-room search bar that replaces the room header while a search is active (search Phase 6).
 *
 * A dumb View fed entirely by RoomView's existing search state/callbacks: the search input, the Phase 3–5 filter
 * controls (`from:`/sender, jump-to-date, result order), the backend "N results found" summary, the Phase 2
 * in-timeline match stepper (up/down + "k of N"), the room/all-rooms scope toggle and a cancel affordance — all in
 * one top-of-chat bar instead of the old right-panel "About" card header + aux panel.
 */
const RoomSearchHeader: React.FC<Props> = ({
    room,
    term,
    onSearchChange,
    onCancel,
    isRoomEncrypted,
    searchInfo,
    navigationVm,
    scope,
    onSearchScopeChange,
    senders,
    onSearchSendersChange,
    order,
    onSearchOrderChange,
    onBackToResults,
    autoFocus,
}) => {
    const searchInputRef = useRef<HTMLInputElement>(null);

    // The input is controlled but the parent's onSearchChange is debounced, so we keep the typed value locally and
    // sync it down when the term prop changes (e.g. a session re-hydrated after a cross-room stepping remount).
    const [searchValue, setSearchValue] = useState(term);
    useEffect(() => {
        setSearchValue(term);
    }, [term]);

    // Re-focus the input when Cmd+F is pressed while the bar is already open (autoFocus only acts on mount).
    useDispatcher(defaultDispatcher, (payload) => {
        if (payload.action === Action.FocusMessageSearch) {
            searchInputRef.current?.focus();
        }
    });

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === Key.ESCAPE) {
            e.preventDefault();
            setSearchValue("");
            onCancel();
            return;
        }
        // Step the in-room match cursor without leaving the box: Enter → next (older), Shift+Enter → previous. Ignore
        // the Enter that confirms an in-progress IME composition so CJK input is not hijacked.
        if (e.key === Key.ENTER && !e.nativeEvent?.isComposing) {
            e.preventDefault();
            defaultDispatcher.dispatch<SearchMatchStepPayload>({
                action: Action.SearchMatchStep,
                direction: e.shiftKey ? "previous" : "next",
            });
        }
    };

    // True while a match is focused in the live timeline (stepping) — surfaces the "back to results" affordance.
    const isSteppingMatch = (searchInfo?.currentMatchIndex ?? -1) >= 0;

    return (
        <div className="mx_RoomSearchHeader" data-testid="room-search-header">
            <PosthogScreenTracker screenName="RoomSearch" />
            <Form.Root className="mx_RoomSearchHeader_form" onSubmit={(e) => e.preventDefault()}>
                <Flex align="center" gap="var(--cpd-space-2x)">
                    <Box flex="1" className="mx_RoomSearchHeader_input">
                        <Search
                            placeholder={_t("room|search|placeholder")}
                            name="room_message_search"
                            onChange={(e) => {
                                setSearchValue(e.currentTarget.value);
                                onSearchChange(e.currentTarget.value);
                            }}
                            value={searchValue}
                            className="mx_no_textinput"
                            ref={searchInputRef}
                            autoFocus={autoFocus}
                            onKeyDown={onKeyDown}
                        />
                    </Box>
                    {/* Telegram-style "from:"/sender filter; renders only when the room has other members. */}
                    <RoomSearchSenderFilter
                        key={room.roomId}
                        room={room}
                        senders={senders}
                        onSearchSendersChange={onSearchSendersChange}
                    />
                    {/* Telegram-style "jump to date" calendar; renders only when jump-to-date is enabled (MSC3030). */}
                    <RoomSearchJumpToDate key={`${room.roomId}-date`} roomId={room.roomId} />
                    {/* Recent/Relevant result-order toggle. */}
                    <RoomSearchOrderToggle order={order} onSearchOrderChange={onSearchOrderChange} />
                    <IconButton
                        onClick={onCancel}
                        destructive
                        tooltip={_t("action|cancel")}
                        aria-label={_t("action|cancel")}
                    >
                        <CloseIcon width="20px" height="20px" />
                    </IconButton>
                </Flex>
            </Form.Root>
            <div className="mx_RoomSearchHeader_summary">
                <SearchIcon width="20px" height="20px" />
                <div className="mx_RoomSearchHeader_summary_text">
                    {searchInfo?.count !== undefined ? (
                        _t(
                            "room|search|summary",
                            { count: searchInfo.count },
                            { query: () => <strong>{searchInfo.term}</strong> },
                        )
                    ) : searchInfo?.error !== undefined ? (
                        searchInfo.error.message
                    ) : searchInfo !== undefined ? (
                        <InlineSpinner />
                    ) : null}
                    <SearchWarning kind={WarningKind.Search} isRoomEncrypted={isRoomEncrypted} showLogo={false} />
                </div>
                <div className="mx_RoomSearchHeader_summary_actions">
                    {isSteppingMatch && onBackToResults && (
                        <IconButton
                            onClick={onBackToResults}
                            tooltip={_t("room|search|back_to_results")}
                            aria-label={_t("room|search|back_to_results")}
                        >
                            <ListIcon width="20px" height="20px" />
                        </IconButton>
                    )}
                    {navigationVm && <SearchMatchNavigation vm={navigationVm} />}
                    <Link
                        onClick={() =>
                            onSearchScopeChange(scope === SearchScope.Room ? SearchScope.All : SearchScope.Room)
                        }
                        kind="primary"
                    >
                        {scope === SearchScope.All
                            ? _t("room|search|this_room_button")
                            : _t("room|search|all_rooms_button")}
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default RoomSearchHeader;
