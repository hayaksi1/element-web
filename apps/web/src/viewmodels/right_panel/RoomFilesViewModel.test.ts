/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest";

import { RoomFilesViewModel } from "./RoomFilesViewModel";
import { FileCategory } from "../../utils/FileCategory";

describe("RoomFilesViewModel", () => {
    it("starts with no category filter and an empty search term", () => {
        const vm = new RoomFilesViewModel();
        expect(vm.getSnapshot()).toEqual({ activeCategory: null, searchTerm: "" });
    });

    it("toggleCategory selects the category and notifies subscribers", () => {
        const vm = new RoomFilesViewModel();
        const listener = vi.fn();
        vm.subscribe(listener);

        vm.toggleCategory(FileCategory.Audio);

        expect(vm.getSnapshot().activeCategory).toBe(FileCategory.Audio);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("toggleCategory on the selected category clears the filter", () => {
        const vm = new RoomFilesViewModel();
        vm.toggleCategory(FileCategory.Documents);

        vm.toggleCategory(FileCategory.Documents);

        expect(vm.getSnapshot().activeCategory).toBeNull();
    });

    it("toggleCategory on a different category switches the selection", () => {
        const vm = new RoomFilesViewModel();
        vm.toggleCategory(FileCategory.Documents);

        vm.toggleCategory(FileCategory.Videos);

        expect(vm.getSnapshot().activeCategory).toBe(FileCategory.Videos);
    });

    it("setSearchTerm updates the term and notifies subscribers", () => {
        const vm = new RoomFilesViewModel();
        const listener = vi.fn();
        vm.subscribe(listener);

        vm.setSearchTerm("report");

        expect(vm.getSnapshot().searchTerm).toBe("report");
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("keeps the search term when the category filter is toggled", () => {
        const vm = new RoomFilesViewModel();
        vm.setSearchTerm("report");

        vm.toggleCategory(FileCategory.Documents);

        expect(vm.getSnapshot()).toEqual({ activeCategory: FileCategory.Documents, searchTerm: "report" });
    });
});
