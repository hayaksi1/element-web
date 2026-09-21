/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import React from "react";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { Direction } from "matrix-js-sdk/src/matrix";

import { RoomSearchJumpToDate } from "./RoomSearchJumpToDate";
import SettingsStore from "../../../settings/SettingsStore";
import { UIFeature } from "../../../settings/UIFeature";
import dispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import { SDKContext } from "../../../contexts/SDKContext";

vi.mock("../../../settings/SettingsStore");

const roomViewStore = { getRoomId: vi.fn() };

const renderJump = (ui: React.ReactElement): ReturnType<typeof render> =>
    render(<SDKContext.Provider value={{ roomViewStore } as never}>{ui}</SDKContext.Provider>);

describe("RoomSearchJumpToDate", () => {
    const roomId = "!room:example.org";
    const mockTimestampToEvent = vi.fn();

    const setFeatureEnabled = (enabled: boolean): void => {
        vi.mocked(SettingsStore).getValue.mockImplementation((key): any => {
            if (key === "feature_jump_to_date") return enabled;
            if (String(key) === UIFeature.TimelineEnableRelativeDates) return true;
            return undefined;
        });
    };

    beforeEach(() => {
        setFeatureEnabled(true);
        vi.mocked(SettingsStore).watchSetting.mockReturnValue("watch-ref" as any);
        vi.mocked(SettingsStore).unwatchSetting.mockImplementation(() => {});

        mockTimestampToEvent.mockReset();
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue({
            timestampToEvent: mockTimestampToEvent,
        } as any);
        vi.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
        roomViewStore.getRoomId.mockReturnValue(roomId);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the calendar trigger when jump-to-date is enabled", () => {
        renderJump(<RoomSearchJumpToDate roomId={roomId} />);

        expect(screen.getByTestId("search-jump-to-date-button")).toBeInTheDocument();
    });

    it("renders nothing when jump-to-date is disabled", () => {
        setFeatureEnabled(false);

        const { container } = renderJump(<RoomSearchJumpToDate roomId={roomId} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("jumps the current room to the picked date via a quick option", async () => {
        mockTimestampToEvent.mockResolvedValue({ event_id: "$event", origin_server_ts: 0 });

        renderJump(<RoomSearchJumpToDate roomId={roomId} />);
        await userEvent.click(screen.getByTestId("search-jump-to-date-button"));
        await userEvent.click(await screen.findByTestId("jump-to-date-last-week"));

        await waitFor(() =>
            expect(mockTimestampToEvent).toHaveBeenCalledWith(roomId, expect.any(Number), Direction.Forward),
        );
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, event_id: "$event", room_id: roomId }),
        );
    });

    it("rebinds to the new room when remounted with a new key on room switch", async () => {
        // The underlying ViewModel only reads roomId at construction, so the parent (RoomSummaryCardView) keys this
        // control by room id to force a fresh VM on room switch. Prove that keyed remount targets the new room.
        const roomB = "!roomB:example.org";
        mockTimestampToEvent.mockResolvedValue({ event_id: "$eventB", origin_server_ts: 0 });
        roomViewStore.getRoomId.mockReturnValue(roomB);

        const { rerender } = renderJump(<RoomSearchJumpToDate key={roomId} roomId={roomId} />);
        rerender(
            <SDKContext.Provider value={{ roomViewStore } as never}>
                <RoomSearchJumpToDate key={roomB} roomId={roomB} />
            </SDKContext.Provider>,
        );

        await userEvent.click(screen.getByTestId("search-jump-to-date-button"));
        await userEvent.click(await screen.findByTestId("jump-to-date-last-week"));

        await waitFor(() =>
            expect(mockTimestampToEvent).toHaveBeenCalledWith(roomB, expect.any(Number), Direction.Forward),
        );
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, event_id: "$eventB", room_id: roomB }),
        );
    });
});
