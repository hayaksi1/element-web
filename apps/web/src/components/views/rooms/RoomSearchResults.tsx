/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";

import { _t } from "../../../languageHandler";
import { type SearchResultPreview } from "../../../Searching";
import { formatFullDateNoTime } from "../../../DateUtils";
import BaseAvatar from "../avatars/BaseAvatar";
import AccessibleButton from "../elements/AccessibleButton";
import Spinner from "../elements/Spinner";

interface Props {
    /** Ordered (newest-first) result preview rows; parallel to the live-stepping match list. */
    previews: SearchResultPreview[];
    /** Whether the backend search is still settling (drives the loading spinner). */
    inProgress: boolean;
    /** The search error, if the request failed. */
    error?: Error;
    /** Jump the live timeline to result row `index` (reuses the {@link SearchMatch} stepping path). */
    onResultClick: (index: number) => void;
    /** Resolve a sender's display name for a row (RoomView resolves it against the matched room's members). */
    getSenderName: (preview: SearchResultPreview) => string;
}

/**
 * Telegram-style dropdown list of in-room search results, rendered below the search bar over the live timeline
 * (search Phase 6). Each row shows the sender (avatar + name), the matched message preview and its date; clicking a
 * row jumps the live timeline to that message via the existing match-stepping path.
 */
const RoomSearchResults: React.FC<Props> = ({ previews, inProgress, error, onResultClick, getSenderName }) => {
    let body: JSX.Element;
    if (error) {
        body = (
            <div className="mx_RoomSearchResults_status" role="status">
                {error.message}
            </div>
        );
    } else if (previews.length === 0) {
        body = inProgress ? (
            <div className="mx_RoomSearchResults_status">
                <Spinner />
            </div>
        ) : (
            <div className="mx_RoomSearchResults_status" role="status">
                {_t("room|search|no_results")}
            </div>
        );
    } else {
        body = (
            <div className="mx_RoomSearchResults_list" role="listbox" aria-label={_t("room|search|results_label")}>
                {previews.map((preview, index) => {
                    const senderName = getSenderName(preview);
                    return (
                        <AccessibleButton
                            key={preview.eventId}
                            className="mx_RoomSearchResults_row"
                            role="option"
                            aria-selected={false}
                            onClick={() => onResultClick(index)}
                        >
                            <BaseAvatar name={senderName} idName={preview.sender} size="32px" />
                            <div className="mx_RoomSearchResults_row_text">
                                <span className="mx_RoomSearchResults_row_sender">{senderName}</span>
                                <span className="mx_RoomSearchResults_row_body">{preview.body}</span>
                            </div>
                            <time className="mx_RoomSearchResults_row_date">
                                {formatFullDateNoTime(new Date(preview.ts))}
                            </time>
                        </AccessibleButton>
                    );
                })}
            </div>
        );
    }

    return <div className="mx_RoomSearchResults">{body}</div>;
};

export default RoomSearchResults;
