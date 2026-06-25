/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { mocked } from "jest-mock";
import { ConnectionError, Direction, HTTPError, MatrixError } from "matrix-js-sdk/src/matrix";

import dispatcher from "../../../src/dispatcher/dispatcher";
import { Action } from "../../../src/dispatcher/actions";
import Modal from "../../../src/Modal";
import { MatrixClientPeg } from "../../../src/MatrixClientPeg";
import { SdkContextClass } from "../../../src/contexts/SDKContext";
import { jumpToDateInRoom } from "../../../src/utils/jumpToDate";

jest.mock("../../../src/contexts/SDKContext", () => ({
    SdkContextClass: {
        instance: {
            roomViewStore: {
                getRoomId: jest.fn(),
            },
        },
    },
}));

describe("jumpToDateInRoom", () => {
    const roomId = "!room:example.org";
    const mockTimestampToEvent = jest.fn();

    const hasTestId = (node: React.ReactNode, testId: string): boolean => {
        if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return false;
        const props = node.props as { "children"?: React.ReactNode; "data-testid"?: string };
        if (props["data-testid"] === testId) return true;
        const children = React.Children.toArray(props.children);
        return children.some((child) => hasTestId(child, testId));
    };

    beforeEach(() => {
        mockTimestampToEvent.mockReset();
        jest.spyOn(MatrixClientPeg, "safeGet").mockReturnValue({
            timestampToEvent: mockTimestampToEvent,
        } as any);
        jest.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
        jest.spyOn(Modal, "createDialog").mockImplementation(() => ({ close: jest.fn() }) as any);
        mocked(SdkContextClass.instance.roomViewStore.getRoomId).mockReturnValue(roomId);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("resolves the timestamp forward and dispatches ViewRoom in the active room", async () => {
        const eventId = "$event";
        const ts = 1_600_000_000_000;
        mockTimestampToEvent.mockResolvedValue({ event_id: eventId, origin_server_ts: ts });

        await jumpToDateInRoom(roomId, ts);

        expect(mockTimestampToEvent).toHaveBeenCalledWith(roomId, ts, Direction.Forward);
        expect(dispatcher.dispatch).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            event_id: eventId,
            highlighted: true,
            room_id: roomId,
            metricsTrigger: undefined,
        });
    });

    it("accepts a date string and resolves it to a unix timestamp", async () => {
        mockTimestampToEvent.mockResolvedValue({ event_id: "$e", origin_server_ts: 0 });

        await jumpToDateInRoom(roomId, "2021-12-17");

        expect(mockTimestampToEvent).toHaveBeenCalledWith(roomId, new Date("2021-12-17").getTime(), Direction.Forward);
    });

    it("does not dispatch when the user switched rooms before it resolves", async () => {
        mockTimestampToEvent.mockResolvedValue({ event_id: "$e", origin_server_ts: 0 });
        mocked(SdkContextClass.instance.roomViewStore.getRoomId).mockReturnValue("!other:example.org");

        await jumpToDateInRoom(roomId, 123);

        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("shows an error dialog with submit-debug-logs for generic errors", async () => {
        mockTimestampToEvent.mockRejectedValue(new Error("Boom"));

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).toHaveBeenCalled();
        const [, params] = mocked(Modal.createDialog).mock.calls.at(-1)!;
        expect(hasTestId((params as any).description, "jump-to-date-error-submit-debug-logs-button")).toBe(true);
    });

    it("omits the submit-debug-logs option for connection errors", async () => {
        mockTimestampToEvent.mockRejectedValue(new ConnectionError("offline"));

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).toHaveBeenCalled();
        const [, params] = mocked(Modal.createDialog).mock.calls.at(-1)!;
        expect(hasTestId((params as any).description, "jump-to-date-error-submit-debug-logs-button")).toBe(false);
    });

    it("omits the submit-debug-logs option for a not-found MatrixError", async () => {
        mockTimestampToEvent.mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }));

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).toHaveBeenCalled();
        const [, params] = mocked(Modal.createDialog).mock.calls.at(-1)!;
        expect(hasTestId((params as any).description, "jump-to-date-error-submit-debug-logs-button")).toBe(false);
    });

    it("omits the submit-debug-logs option for a non-not-found MatrixError", async () => {
        mockTimestampToEvent.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }, 403));

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).toHaveBeenCalled();
        const [, params] = mocked(Modal.createDialog).mock.calls.at(-1)!;
        expect(hasTestId((params as any).description, "jump-to-date-error-submit-debug-logs-button")).toBe(false);
    });

    it("omits the submit-debug-logs option for a plain HTTPError", async () => {
        mockTimestampToEvent.mockRejectedValue(new HTTPError("boom", 502));

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).toHaveBeenCalled();
        const [, params] = mocked(Modal.createDialog).mock.calls.at(-1)!;
        expect(hasTestId((params as any).description, "jump-to-date-error-submit-debug-logs-button")).toBe(false);
    });

    it("does not show an error dialog if the user switched rooms before it rejects", async () => {
        mockTimestampToEvent.mockRejectedValue(new Error("Boom"));
        mocked(SdkContextClass.instance.roomViewStore.getRoomId).mockReturnValue("!other:example.org");

        await jumpToDateInRoom(roomId, 123);

        expect(Modal.createDialog).not.toHaveBeenCalled();
    });
});
