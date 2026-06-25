/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { RoomSearchNavigationViewModel } from "../../../src/viewmodels/search/RoomSearchNavigationViewModel";
import { type SearchMatch } from "../../../src/Searching";

describe("RoomSearchNavigationViewModel", () => {
    const matchA: SearchMatch = { roomId: "!r:e", eventId: "$a" };
    const matchB: SearchMatch = { roomId: "!r:e", eventId: "$b" };
    const matchC: SearchMatch = { roomId: "!r:e", eventId: "$c" };

    it("starts empty with both arrows disabled", () => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 0, canPrevious: false, canNext: false });
    });

    it("exposes the total and enables next once matches are set", () => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        vm.setMatches([matchA, matchB, matchC]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 3, canPrevious: false, canNext: true });
    });

    it("activates the first match on next() from the empty cursor", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: false, canNext: true });
    });

    it("steps forward and disables next at the last match", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        vm.next();
        expect(onActivateMatch).toHaveBeenNthCalledWith(3, matchC, 2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: false });
    });

    it("does not activate or move past the last match", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA]);
        vm.next(); // -> index 0
        vm.next(); // clamped, no-op
        expect(onActivateMatch).toHaveBeenCalledTimes(1);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 1, canPrevious: false, canNext: false });
    });

    it("steps backward with previous()", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next(); // index 1
        onActivateMatch.mockClear();
        vm.previous(); // index 0
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: false, canNext: true });
    });

    it("does not activate or move before the first match", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB]);
        vm.previous(); // index -1, no-op
        expect(onActivateMatch).not.toHaveBeenCalled();
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 2, canPrevious: false, canNext: true });
    });

    it("resets the cursor when matches change", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        vm.setMatches([matchA]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 1, canPrevious: false, canNext: true });
    });

    it("notifies subscribers when the snapshot changes", () => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        const listener = jest.fn();
        vm.subscribe(listener);
        vm.setMatches([matchA, matchB]);
        expect(listener).toHaveBeenCalled();
    });
});
