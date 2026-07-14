/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { mocked } from "jest-mock";
import { render, screen, waitFor } from "jest-matrix-react";
import userEvent from "@testing-library/user-event";
import { Direction } from "matrix-js-sdk/src/matrix";

import { RoomSearchJumpToDate } from "../../../../../src/components/views/right_panel/RoomSearchJumpToDate";
import SettingsStore from "../../../../../src/settings/SettingsStore";
import { UIFeature } from "../../../../../src/settings/UIFeature";
import dispatcher from "../../../../../src/dispatcher/dispatcher";
import { Action } from "../../../../../src/dispatcher/actions";
import { MatrixClientPeg } from "../../../../../src/MatrixClientPeg";
import { SDKContext } from "../../../../../src/contexts/SDKContext";
import { type SDKContextClass } from "../../../../../src/contexts/SDKContextClass";

jest.mock("../../../../../src/settings/SettingsStore");

describe("RoomSearchJumpToDate", () => {
    const roomId = "!room:example.org";
    const mockTimestampToEvent = jest.fn();
    const mockGetRoomId = jest.fn();
    // The component reads the store off SDKContext, so provide a stub context rather than mocking the module.
    const sdkContext = { roomViewStore: { getRoomId: mockGetRoomId } } as unknown as SDKContextClass;

    const renderControl = (ui: React.ReactElement) =>
        render(ui, {
            wrapper: ({ children }) => <SDKContext.Provider value={sdkContext}>{children}</SDKContext.Provider>,
        });

    const setFeatureEnabled = (enabled: boolean): void => {
        mocked(SettingsStore).getValue.mockImplementation((key): any => {
            if (key === "feature_jump_to_date") return enabled;
            if (String(key) === UIFeature.TimelineEnableRelativeDates) return true;
            return undefined;
        });
    };

    beforeEach(() => {
        setFeatureEnabled(true);
        mocked(SettingsStore).watchSetting.mockReturnValue("watch-ref" as any);
        mocked(SettingsStore).unwatchSetting.mockImplementation(() => {});

        mockTimestampToEvent.mockReset();
        jest.spyOn(MatrixClientPeg, "safeGet").mockReturnValue({
            timestampToEvent: mockTimestampToEvent,
        } as any);
        jest.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
        mockGetRoomId.mockReset();
        mockGetRoomId.mockReturnValue(roomId);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("renders the calendar trigger when jump-to-date is enabled", () => {
        renderControl(<RoomSearchJumpToDate roomId={roomId} />);

        expect(screen.getByTestId("search-jump-to-date-button")).toBeInTheDocument();
    });

    it("renders nothing when jump-to-date is disabled", () => {
        setFeatureEnabled(false);

        const { container } = renderControl(<RoomSearchJumpToDate roomId={roomId} />);

        expect(container).toBeEmptyDOMElement();
    });

    it("jumps the current room to the picked date via a quick option", async () => {
        mockTimestampToEvent.mockResolvedValue({ event_id: "$event", origin_server_ts: 0 });

        renderControl(<RoomSearchJumpToDate roomId={roomId} />);
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
        mockGetRoomId.mockReturnValue(roomB);

        const { rerender } = renderControl(<RoomSearchJumpToDate key={roomId} roomId={roomId} />);
        rerender(<RoomSearchJumpToDate key={roomB} roomId={roomB} />);

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
