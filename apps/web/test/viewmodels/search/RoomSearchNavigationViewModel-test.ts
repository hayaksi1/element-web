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

    it("exposes the total and enables both arrows once matches are set", () => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        vm.setMatches([matchA, matchB, matchC]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 3, canPrevious: true, canNext: true });
    });

    it("activates the first (newest) match on next() from the empty cursor", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: true, canNext: true });
    });

    it("steps forward through every match", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        vm.next();
        expect(onActivateMatch).toHaveBeenNthCalledWith(3, matchC, 2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: true });
    });

    it("wraps from the last match back to the first on next()", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next(); // A (0)
        vm.next(); // B (1)
        vm.next(); // C (2)
        onActivateMatch.mockClear();
        vm.next(); // wraps to A (0)
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: true, canNext: true });
    });

    it("re-activates the only match when wrapping with a single result", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA]);
        vm.next(); // -> index 0
        vm.next(); // wraps, still index 0
        expect(onActivateMatch).toHaveBeenCalledTimes(2);
        expect(onActivateMatch).toHaveBeenNthCalledWith(2, matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 1, canPrevious: true, canNext: true });
    });

    it("re-activates the only match when wrapping backward with a single result", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA]);
        vm.next(); // -> index 0
        onActivateMatch.mockClear();
        vm.previous(); // wraps, still index 0
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 1, canPrevious: true, canNext: true });
    });

    it("steps backward with previous()", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next(); // index 1 (B)
        onActivateMatch.mockClear();
        vm.previous(); // index 0 (A)
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: true, canNext: true });
    });

    it("wraps to the last (oldest) match on previous() from the empty cursor", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB]);
        vm.previous(); // wraps to last (index 1)
        expect(onActivateMatch).toHaveBeenCalledWith(matchB, 1);
        expect(vm.getSnapshot()).toEqual({ current: 2, total: 2, canPrevious: true, canNext: true });
    });

    it("wraps from the first match to the last on previous()", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next(); // index 0 (A)
        onActivateMatch.mockClear();
        vm.previous(); // wraps to last (index 2, C)
        expect(onActivateMatch).toHaveBeenCalledWith(matchC, 2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: true });
    });

    it("resets the cursor when matches change", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        vm.setMatches([matchA]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 1, canPrevious: true, canNext: true });
    });

    it("does nothing when stepping with no matches", () => {
        const onActivateMatch = jest.fn();
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch });
        vm.next();
        vm.previous();
        expect(onActivateMatch).not.toHaveBeenCalled();
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 0, canPrevious: false, canNext: false });
    });

    it("notifies subscribers when the snapshot changes", () => {
        const vm = new RoomSearchNavigationViewModel({ onActivateMatch: jest.fn() });
        const listener = jest.fn();
        vm.subscribe(listener);
        vm.setMatches([matchA, matchB]);
        expect(listener).toHaveBeenCalled();
    });
});
