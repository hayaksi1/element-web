/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { render, screen } from "jest-matrix-react";

import RoomSearchAuxPanel from "../../../../../src/components/views/rooms/RoomSearchAuxPanel";
import { SearchScope } from "../../../../../src/Searching";
import { RoomSearchNavigationViewModel } from "../../../../../src/viewmodels/search/RoomSearchNavigationViewModel";

describe("RoomSearchAuxPanel", () => {
    it("should render the match navigation counter and arrows when a navigation view model has matches", () => {
        const navigationVm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        navigationVm.setMatches([
            { roomId: "!r:e", eventId: "$a" },
            { roomId: "!r:e", eventId: "$b" },
        ]);

        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 2,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={jest.fn()}
                navigationVm={navigationVm}
            />,
        );

        expect(screen.getByText("0 of 2")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next match" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Previous match" })).toBeInTheDocument();
    });

    it("should hide the results-count summary while stepping a match (counter is the source of truth)", () => {
        const navigationVm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        navigationVm.setMatches([
            { roomId: "!r:e", eventId: "$a" },
            { roomId: "!r:e", eventId: "$b" },
        ]);
        navigationVm.next(); // step to the first match

        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 2,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                    currentMatchIndex: 0,
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={jest.fn()}
                navigationVm={navigationVm}
            />,
        );

        expect(screen.queryByText("results found", { exact: false })).not.toBeInTheDocument();
        expect(screen.getByText("1 of 2")).toBeInTheDocument();
    });

    it("should not render match navigation when there are no matches", () => {
        const navigationVm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });

        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 0,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={jest.fn()}
                navigationVm={navigationVm}
            />,
        );

        expect(screen.queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
    });

    it("should render the count of results", () => {
        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 5,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={jest.fn()}
            />,
        );

        expect(screen.getByText("5 results found for", { exact: false })).toHaveTextContent(
            "5 results found for “abcd”",
        );
    });

    it("should allow the user to toggle to all rooms search", async () => {
        const onSearchScopeChange = jest.fn();

        render(
            <RoomSearchAuxPanel
                isRoomEncrypted={false}
                onSearchScopeChange={onSearchScopeChange}
                onCancelClick={jest.fn()}
            />,
        );

        screen.getByText("Search all rooms").click();
        expect(onSearchScopeChange).toHaveBeenCalledWith(SearchScope.All);
    });

    it("should allow the user to toggle back to room-specific search", async () => {
        const onSearchScopeChange = jest.fn();

        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    term: "abcd",
                    scope: SearchScope.All,
                    promise: new Promise(() => {}),
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={onSearchScopeChange}
                onCancelClick={jest.fn()}
            />,
        );

        screen.getByText("Search this room").click();
        expect(onSearchScopeChange).toHaveBeenCalledWith(SearchScope.Room);
    });

    it("should allow the user to cancel a search", async () => {
        const onCancelClick = jest.fn();

        render(
            <RoomSearchAuxPanel
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={onCancelClick}
            />,
        );

        screen.getByRole("button", { name: "Cancel" }).click();
        expect(onCancelClick).toHaveBeenCalled();
    });
});
