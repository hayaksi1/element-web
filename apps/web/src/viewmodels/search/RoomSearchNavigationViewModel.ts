/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    BaseViewModel,
    type SearchMatchNavigationViewActions,
    type SearchMatchNavigationViewSnapshot,
} from "@element-hq/web-shared-components";

import { type SearchMatch } from "../../Searching";

/**
 * Constructor props for {@link RoomSearchNavigationViewModel}.
 */
export interface RoomSearchNavigationProps {
    /**
     * Invoked when a match becomes the focused one (via next/previous). The owner is responsible for driving
     * the live timeline to the match (e.g. dispatching a ViewRoom action) and recording the active index.
     */
    onActivateMatch(this: void, match: SearchMatch, index: number): void;
}

const EMPTY_SNAPSHOT: SearchMatchNavigationViewSnapshot = {
    current: 0,
    total: 0,
    canPrevious: false,
    canNext: false,
};

/**
 * MVVM-v2 view model owning the in-room search match cursor. It tracks the ordered match list and the focused
 * index, and drives the live timeline through the injected {@link RoomSearchNavigationProps.onActivateMatch}
 * callback when the user steps with the up/down arrows.
 */
export class RoomSearchNavigationViewModel
    extends BaseViewModel<SearchMatchNavigationViewSnapshot, RoomSearchNavigationProps>
    implements SearchMatchNavigationViewActions
{
    private matches: SearchMatch[] = [];
    // Index into `matches` of the focused match, or -1 when no match is active yet.
    private index = -1;

    public constructor(props: RoomSearchNavigationProps) {
        super(props, EMPTY_SNAPSHOT);
    }

    private computeSnapshot(): SearchMatchNavigationViewSnapshot {
        const total = this.matches.length;
        return {
            current: this.index < 0 ? 0 : this.index + 1,
            total,
            // Stepping wraps around, so both arrows are available whenever there is at least one match.
            canPrevious: total > 0,
            canNext: total > 0,
        };
    }

    /**
     * Replace the ordered match list and reset the cursor to "no match active". Does not activate a match.
     */
    public setMatches(matches: SearchMatch[]): void {
        this.matches = matches;
        this.index = -1;
        this.snapshot.set(this.computeSnapshot());
    }

    /**
     * Step to the next (older) match. From the empty cursor this activates the first (newest) match; from the
     * last match it wraps around to the first.
     */
    public readonly next = (): void => {
        const total = this.matches.length;
        if (total === 0) return;
        this.index = this.index < 0 ? 0 : (this.index + 1) % total;
        this.snapshot.set(this.computeSnapshot());
        this.props.onActivateMatch(this.matches[this.index], this.index);
    };

    /**
     * Step to the previous (newer) match. From the empty cursor or the first match this wraps around to the
     * last (oldest) match.
     */
    public readonly previous = (): void => {
        const total = this.matches.length;
        if (total === 0) return;
        this.index = this.index <= 0 ? total - 1 : this.index - 1;
        this.snapshot.set(this.computeSnapshot());
        this.props.onActivateMatch(this.matches[this.index], this.index);
    };
}
