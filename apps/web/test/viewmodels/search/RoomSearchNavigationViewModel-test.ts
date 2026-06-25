/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { type ISearchResults } from "matrix-js-sdk/src/matrix";

import {
    RoomSearchNavigationViewModel,
    type RoomSearchNavigationProps,
} from "../../../src/viewmodels/search/RoomSearchNavigationViewModel";
import { type SearchMatch, SearchScope } from "../../../src/Searching";
import { SearchSessionStore } from "../../../src/stores/SearchSessionStore";

describe("RoomSearchNavigationViewModel", () => {
    const matchA: SearchMatch = { roomId: "!r:e", eventId: "$a" };
    const matchB: SearchMatch = { roomId: "!r:e", eventId: "$b" };
    const matchC: SearchMatch = { roomId: "!r:e", eventId: "$c" };
    const promise = Promise.resolve({ results: [], highlights: [], count: 0 } as unknown as ISearchResults);

    let store: SearchSessionStore;
    let vms: RoomSearchNavigationViewModel[];

    // The VM now reads/writes its cursor through the SearchSessionStore, so we seed the store rather than the VM.
    const setMatches = (matches: SearchMatch[]): void => {
        store.start({
            searchId: 1,
            term: "x",
            scope: SearchScope.Room,
            promise,
            abortController: new AbortController(),
        });
        store.updateResults({ inProgress: false, matches });
    };

    // Build a VM and register it for disposal so its store listener is removed between tests (the store singleton
    // outlives the file, so undisposed VMs would otherwise leak listeners onto it).
    const makeVm = (props: RoomSearchNavigationProps): RoomSearchNavigationViewModel => {
        const vm = new RoomSearchNavigationViewModel(props);
        vms.push(vm);
        return vm;
    };

    beforeEach(() => {
        store = SearchSessionStore.instance;
        store.clear({ abort: false });
        vms = [];
    });

    afterEach(() => {
        vms.forEach((vm) => {
            if (!vm.isDisposed) vm.dispose();
        });
        store.clear({ abort: false });
    });

    it("starts empty with both arrows disabled", () => {
        const vm = makeVm({ onActivateMatch: jest.fn() });
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 0, canPrevious: false, canNext: false });
    });

    it("reflects the store's total and enables both arrows once matches are set", () => {
        const vm = makeVm({ onActivateMatch: jest.fn() });
        setMatches([matchA, matchB, matchC]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 3, canPrevious: true, canNext: true });
    });

    it("hydrates its snapshot from an already-populated store on construction (remount)", () => {
        setMatches([matchA, matchB, matchC]);
        store.setCurrentMatchIndex(1);
        const vm = makeVm({ onActivateMatch: jest.fn() });
        expect(vm.getSnapshot()).toEqual({ current: 2, total: 3, canPrevious: true, canNext: true });
    });

    it("activates the first (newest) match on next() from the empty cursor and marks a stepping jump", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
        vm.next();
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(store.currentMatchIndex).toBe(0);
        expect(store.isSteppingJump()).toBe(true);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: true, canNext: true });
    });

    it("steps forward through every match", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        vm.next();
        expect(onActivateMatch).toHaveBeenNthCalledWith(3, matchC, 2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: true });
    });

    it("wraps from the last match back to the first on next()", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
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
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA]);
        vm.next(); // -> index 0
        vm.next(); // wraps, still index 0
        expect(onActivateMatch).toHaveBeenCalledTimes(2);
        expect(onActivateMatch).toHaveBeenNthCalledWith(2, matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 1, canPrevious: true, canNext: true });
    });

    it("re-activates the only match when wrapping backward with a single result", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA]);
        vm.next(); // -> index 0
        onActivateMatch.mockClear();
        vm.previous(); // wraps, still index 0
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 1, canPrevious: true, canNext: true });
    });

    it("steps backward with previous()", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next(); // index 1 (B)
        onActivateMatch.mockClear();
        vm.previous(); // index 0 (A)
        expect(onActivateMatch).toHaveBeenCalledWith(matchA, 0);
        expect(vm.getSnapshot()).toEqual({ current: 1, total: 3, canPrevious: true, canNext: true });
    });

    it("wraps to the last (oldest) match on previous() from the empty cursor", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB]);
        vm.previous(); // wraps to last (index 1)
        expect(onActivateMatch).toHaveBeenCalledWith(matchB, 1);
        expect(vm.getSnapshot()).toEqual({ current: 2, total: 2, canPrevious: true, canNext: true });
    });

    it("wraps from the first match to the last on previous()", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
        vm.next(); // index 0 (A)
        onActivateMatch.mockClear();
        vm.previous(); // wraps to last (index 2, C)
        expect(onActivateMatch).toHaveBeenCalledWith(matchC, 2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: true });
    });

    it("resets the cursor when the store gets a fresh result set", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        setMatches([matchA, matchB, matchC]);
        vm.next();
        vm.next();
        setMatches([matchA]);
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 1, canPrevious: true, canNext: true });
    });

    it("does nothing when stepping with no matches", () => {
        const onActivateMatch = jest.fn();
        const vm = makeVm({ onActivateMatch });
        vm.next();
        vm.previous();
        expect(onActivateMatch).not.toHaveBeenCalled();
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 0, canPrevious: false, canNext: false });
    });

    it("reacts to an external store cursor change (e.g. RoomView clicking a result)", () => {
        const vm = makeVm({ onActivateMatch: jest.fn() });
        setMatches([matchA, matchB, matchC]);
        store.setCurrentMatchIndex(2);
        expect(vm.getSnapshot()).toEqual({ current: 3, total: 3, canPrevious: true, canNext: true });
    });

    it("notifies subscribers when the snapshot changes", () => {
        const vm = makeVm({ onActivateMatch: jest.fn() });
        const listener = jest.fn();
        vm.subscribe(listener);
        setMatches([matchA, matchB]);
        expect(listener).toHaveBeenCalled();
    });

    it("stops reacting to the store once disposed", () => {
        const vm = makeVm({ onActivateMatch: jest.fn() });
        setMatches([matchA, matchB]);
        vm.dispose();
        store.setCurrentMatchIndex(1);
        // The snapshot is frozen at its pre-dispose value (listener removed).
        expect(vm.getSnapshot()).toEqual({ current: 0, total: 2, canPrevious: true, canNext: true });
    });
});
