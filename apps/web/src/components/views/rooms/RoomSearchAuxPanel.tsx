/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import { IconButton, Link } from "@vector-im/compound-web";
import { SearchMatchNavigation, type SearchMatchNavigationViewModel } from "@element-hq/web-shared-components";

import { _t } from "../../../languageHandler";
import { PosthogScreenTracker } from "../../../PosthogTrackers";
import SearchWarning, { WarningKind } from "../elements/SearchWarning";
import { type SearchInfo, SearchScope } from "../../../Searching";
import InlineSpinner from "../elements/InlineSpinner";

interface Props {
    searchInfo?: SearchInfo;
    isRoomEncrypted: boolean;
    /**
     * View model driving the in-timeline "k of N" match stepper. When provided and it has matches, the
     * counter and up/down arrows are shown in the header.
     */
    navigationVm?: SearchMatchNavigationViewModel;
    onSearchScopeChange(this: void, scope: SearchScope): void;
    onCancelClick(this: void): void;
}

const RoomSearchAuxPanel: React.FC<Props> = ({
    searchInfo,
    isRoomEncrypted,
    navigationVm,
    onSearchScopeChange,
    onCancelClick,
}) => {
    const scope = searchInfo?.scope ?? SearchScope.Room;
    // While stepping matches in the live timeline, the "k of N" stepper is the source of truth for position,
    // so we hide the (differently-counted) "N results found" summary to avoid showing two conflicting totals.
    const isSteppingMatch = (searchInfo?.currentMatchIndex ?? -1) >= 0;

    return (
        <>
            <PosthogScreenTracker screenName="RoomSearch" />
            <div className="mx_RoomSearchAuxPanel">
                <div className="mx_RoomSearchAuxPanel_summary">
                    <SearchIcon width="24px" height="24px" />
                    <div className="mx_RoomSearchAuxPanel_summary_text">
                        {isSteppingMatch ? null : searchInfo?.count !== undefined ? (
                            _t(
                                "room|search|summary",
                                { count: searchInfo.count },
                                { query: () => <strong>{searchInfo.term}</strong> },
                            )
                        ) : searchInfo?.error !== undefined ? (
                            searchInfo?.error.message
                        ) : (
                            <InlineSpinner />
                        )}
                        <SearchWarning kind={WarningKind.Search} isRoomEncrypted={isRoomEncrypted} showLogo={false} />
                    </div>
                </div>
                <div className="mx_RoomSearchAuxPanel_buttons">
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
                    <IconButton
                        onClick={onCancelClick}
                        destructive
                        tooltip={_t("action|cancel")}
                        aria-label={_t("action|cancel")}
                    >
                        <CloseIcon width="20px" height="20px" />
                    </IconButton>
                </div>
            </div>
        </>
    );
};

export default RoomSearchAuxPanel;
