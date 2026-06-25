/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { render, screen } from "jest-matrix-react";
import userEvent from "@testing-library/user-event";

import RoomSearchResults from "../../../../../src/components/views/rooms/RoomSearchResults";
import { type SearchResultPreview } from "../../../../../src/Searching";

const preview = (eventId: string, sender: string, body: string, ts: number): SearchResultPreview => ({
    roomId: "!r:server",
    eventId,
    sender,
    body,
    ts,
});

describe("RoomSearchResults", () => {
    const previews = [
        preview("$a", "@alice:server", "hello gemini world", 1700000000000),
        preview("$b", "@bob:server", "another gemini line", 1690000000000),
    ];
    const getSenderName = (p: SearchResultPreview): string => (p.sender === "@alice:server" ? "Alice" : "Bob");

    it("renders a row per result with sender name and preview, reporting clicks by index", async () => {
        const onResultClick = jest.fn();
        render(
            <RoomSearchResults
                previews={previews}
                inProgress={false}
                onResultClick={onResultClick}
                getSenderName={getSenderName}
            />,
        );

        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("hello gemini world")).toBeInTheDocument();
        expect(screen.getByText("Bob")).toBeInTheDocument();

        await userEvent.click(screen.getByText("another gemini line"));
        expect(onResultClick).toHaveBeenCalledWith(1);
    });

    it("shows an empty state when there are no results and the search has settled", () => {
        render(
            <RoomSearchResults
                previews={[]}
                inProgress={false}
                onResultClick={jest.fn()}
                getSenderName={getSenderName}
            />,
        );
        expect(screen.getByText("No messages found")).toBeInTheDocument();
    });

    it("shows a spinner while the search is in progress with no results yet", () => {
        const { container } = render(
            <RoomSearchResults
                previews={[]}
                inProgress={true}
                onResultClick={jest.fn()}
                getSenderName={getSenderName}
            />,
        );
        expect(container.querySelector(".mx_Spinner")).toBeTruthy();
    });

    it("shows the error message when the search failed", () => {
        render(
            <RoomSearchResults
                previews={[]}
                inProgress={false}
                error={new Error("boom")}
                onResultClick={jest.fn()}
                getSenderName={getSenderName}
            />,
        );
        expect(screen.getByText("boom")).toBeInTheDocument();
    });
});
