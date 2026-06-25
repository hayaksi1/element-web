/*
Copyright 2024 New Vector Ltd.
Copyright 2024 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { render, screen } from "jest-matrix-react";

import RoomSearchAuxPanel from "../../../../../src/components/views/rooms/RoomSearchAuxPanel";
import { type SearchMatch, SearchScope } from "../../../../../src/Searching";
import { RoomSearchNavigationViewModel } from "../../../../../src/viewmodels/search/RoomSearchNavigationViewModel";
import { SearchSessionStore } from "../../../../../src/stores/SearchSessionStore";

describe("RoomSearchAuxPanel", () => {
    const vms: RoomSearchNavigationViewModel[] = [];

    // The match stepper now reads its cursor from the SearchSessionStore, so we seed the store rather than the VM.
    const seedMatches = (matches: SearchMatch[]): void => {
        const store = SearchSessionStore.instance;
        store.start({
            searchId: 1,
            term: "abcd",
            scope: SearchScope.Room,
            promise: new Promise(() => {}),
            abortController: new AbortController(),
        });
        store.updateResults({ inProgress: false, matches });
    };

    const makeVm = (): RoomSearchNavigationViewModel => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        vms.push(vm);
        return vm;
    };

    beforeEach(() => {
        SearchSessionStore.instance.clear({ abort: false });
    });

    afterEach(() => {
        while (vms.length) vms.pop()!.dispose();
        SearchSessionStore.instance.clear({ abort: false });
    });

    it("should render the match navigation counter and arrows when a navigation view model has matches", () => {
        const navigationVm = makeVm();
        seedMatches([
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

        // `exact: false` so this stays robust to the shared-components stepper label ("… loaded").
        expect(screen.getByText("0 of 2", { exact: false })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next match" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Previous match" })).toBeInTheDocument();
    });

    it("should keep the results-count summary visible while stepping a match (keep both, stepper labelled loaded)", () => {
        const navigationVm = makeVm();
        seedMatches([
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

        // We now keep BOTH the backend "N results found" summary and the "k of N loaded" stepper visible while
        // stepping (the stepper's "loaded" label disambiguates the two denominators), instead of hiding the summary.
        expect(screen.getByText("results found", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("1 of 2", { exact: false })).toBeInTheDocument();
    });

    it("shows a back-to-results button while stepping and invokes onBackToResults when clicked", () => {
        const onBackToResults = jest.fn();
        const navigationVm = makeVm();
        seedMatches([{ roomId: "!r:e", eventId: "$a" }]);
        navigationVm.next(); // step to the first match

        render(
            <RoomSearchAuxPanel
                searchInfo={{
                    searchId: 1234,
                    count: 1,
                    term: "abcd",
                    scope: SearchScope.Room,
                    promise: new Promise(() => {}),
                    currentMatchIndex: 0,
                }}
                isRoomEncrypted={false}
                onSearchScopeChange={jest.fn()}
                onCancelClick={jest.fn()}
                onBackToResults={onBackToResults}
                navigationVm={navigationVm}
            />,
        );

        screen.getByRole("button", { name: "Back to results" }).click();
        expect(onBackToResults).toHaveBeenCalled();
    });

    it("does not show the back-to-results button when not stepping", () => {
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
                onBackToResults={jest.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: "Back to results" })).not.toBeInTheDocument();
    });

    it("should not render match navigation when there are no matches", () => {
        const navigationVm = makeVm();

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
