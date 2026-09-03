/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { SDKContextClass } from "../../../contexts/SDKContextClass";
import { SDKContext } from "../../../contexts/SDKContext";

vi.mock("../../../settings/SettingsStore");
vi.mock("../../../contexts/SDKContextClass", () => ({
    SDKContextClass: {
        instance: {
            roomViewStore: {
                getRoomId: vi.fn(),
            },
        },
    },
}));

describe("RoomSearchJumpToDate", () => {
    const roomId = "!room:example.org";

    const withSdkContext = ({ children }: { children?: React.ReactNode }): React.ReactElement => (
        <SDKContext.Provider value={SDKContextClass.instance}>{children}</SDKContext.Provider>
    );
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
        vi.mocked(SDKContextClass.instance.roomViewStore.getRoomId).mockReturnValue(roomId);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the calendar trigger when jump-to-date is enabled", () => {
        render(<RoomSearchJumpToDate roomId={roomId} />, { wrapper: withSdkContext });

        expect(screen.getByTestId("search-jump-to-date-button")).toBeInTheDocument();
    });

    it("renders nothing when jump-to-date is disabled", () => {
        setFeatureEnabled(false);

        const { container } = render(<RoomSearchJumpToDate roomId={roomId} />, { wrapper: withSdkContext });

        expect(container).toBeEmptyDOMElement();
    });

    it("jumps the current room to the picked date via a quick option", async () => {
        mockTimestampToEvent.mockResolvedValue({ event_id: "$event", origin_server_ts: 0 });

        render(<RoomSearchJumpToDate roomId={roomId} />, { wrapper: withSdkContext });
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
        vi.mocked(SDKContextClass.instance.roomViewStore.getRoomId).mockReturnValue(roomB);

        const { rerender } = render(<RoomSearchJumpToDate key={roomId} roomId={roomId} />, {
            wrapper: withSdkContext,
        });
        rerender(withSdkContext({ children: <RoomSearchJumpToDate key={roomB} roomId={roomB} /> }));

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
