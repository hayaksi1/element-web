/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { Direction, ConnectionError, HTTPError, MatrixError } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { formatFullDateNoDay } from "../DateUtils";
import { MatrixClientPeg } from "../MatrixClientPeg";
import dispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { _t } from "../languageHandler";
import Modal from "../Modal";
import ErrorDialog from "../components/views/dialogs/ErrorDialog";
import BugReportDialog from "../components/views/dialogs/BugReportDialog";
import AccessibleButton from "../components/views/elements/AccessibleButton";
import { SdkContextClass } from "../contexts/SDKContext";

function onJumpToDateBugReport(err?: Error): void {
    Modal.createDialog(BugReportDialog, {
        error: err,
        initialText: "Error occured while using jump to date #jump-to-date",
    });
}

/**
 * Resolve a timestamp/date to the nearest event via MSC3030 `timestamp_to_event` and jump the live timeline to it.
 *
 * Shared by the timeline date separators ({@link DateSeparatorViewModel}) and the in-room search-header jump-to-date
 * control. Dispatches a plain {@link Action.ViewRoom} with the resolved `event_id` (not a search-stepping jump), which
 * RoomView's clear gate treats like a result click: while a search is active it ends the search and shows the live
 * timeline at that event; otherwise it simply teleports the live timeline.
 *
 * Guards against navigating/erroring after the user has already switched rooms during a slow request.
 *
 * @param roomId - The room whose timeline should jump.
 * @param inputTimestamp - A unix ms timestamp, date string, or Date to resolve.
 */
export async function jumpToDateInRoom(roomId: string, inputTimestamp: number | string | Date): Promise<void> {
    const unixTimestamp = new Date(inputTimestamp).getTime();
    const roomIdForJumpRequest = roomId;

    try {
        const cli = MatrixClientPeg.safeGet();
        const { event_id: eventId, origin_server_ts: originServerTs } = await cli.timestampToEvent(
            roomIdForJumpRequest,
            unixTimestamp,
            Direction.Forward,
        );
        logger.log(
            `/timestamp_to_event: ` +
                `found ${eventId} (${originServerTs}) for timestamp=${unixTimestamp} (looking forward)`,
        );

        // Only try to navigate to the room if the user is still viewing the same
        // room. We don't want to jump someone back to a room after a slow request
        // if they've already navigated away to another room.
        const currentRoomId = SdkContextClass.instance.roomViewStore.getRoomId();
        if (currentRoomId === roomIdForJumpRequest) {
            dispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                event_id: eventId,
                highlighted: true,
                room_id: roomIdForJumpRequest,
                metricsTrigger: undefined, // room doesn't change
            });
        } else {
            logger.debug(
                `No longer navigating to date in room (jump to date) because the user already switched ` +
                    `to another room: currentRoomId=${currentRoomId}, roomIdForJumpRequest=${roomIdForJumpRequest}`,
            );
        }
    } catch (err) {
        logger.error(
            `Error occured while trying to find event in ${roomIdForJumpRequest} ` + `at timestamp=${unixTimestamp}:`,
            err,
        );

        // Only display an error if the user is still viewing the same room. We
        // don't want to worry someone about an error in a room they no longer care
        // about after a slow request if they've already navigated away to another
        // room.
        const currentRoomId = SdkContextClass.instance.roomViewStore.getRoomId();
        if (currentRoomId === roomIdForJumpRequest) {
            let friendlyErrorMessage = "An error occured while trying to find and jump to the given date.";
            let submitDebugLogsContent: React.ReactElement = <></>;

            if (err instanceof ConnectionError) {
                friendlyErrorMessage = _t("room|error_jump_to_date_connection");
            } else if (err instanceof MatrixError) {
                if (err?.errcode === "M_NOT_FOUND") {
                    friendlyErrorMessage = _t("room|error_jump_to_date_not_found", {
                        dateString: formatFullDateNoDay(new Date(unixTimestamp)),
                    });
                } else {
                    friendlyErrorMessage = _t("room|error_jump_to_date", {
                        statusCode: err?.httpStatus || _t("room|unknown_status_code_for_timeline_jump"),
                        errorCode: err?.errcode || _t("common|unavailable"),
                    });
                }
            } else if (err instanceof HTTPError) {
                friendlyErrorMessage = err.message;
            } else {
                // We only give the option to submit logs for actual errors, not network problems.
                submitDebugLogsContent = (
                    <p>
                        {_t(
                            "room|error_jump_to_date_send_logs_prompt",
                            {},
                            {
                                debugLogsLink: (sub) => (
                                    // This is by default a `<div>` which we
                                    // can't nest within a `<p>` here so update
                                    // this to a be a inline anchor element.
                                    <AccessibleButton
                                        element="a"
                                        kind="link"
                                        onClick={() => onJumpToDateBugReport(err instanceof Error ? err : undefined)}
                                        data-testid="jump-to-date-error-submit-debug-logs-button"
                                    >
                                        {sub}
                                    </AccessibleButton>
                                ),
                            },
                        )}
                    </p>
                );
            }

            Modal.createDialog(ErrorDialog, {
                title: _t("room|error_jump_to_date_title"),
                description: (
                    <div data-testid="jump-to-date-error-content">
                        <p>{friendlyErrorMessage}</p>
                        {submitDebugLogsContent}
                        <details>
                            <summary>{_t("room|error_jump_to_date_details")}</summary>
                            <p>{String(err)}</p>
                        </details>
                    </div>
                ),
            });
        }
    }
}
