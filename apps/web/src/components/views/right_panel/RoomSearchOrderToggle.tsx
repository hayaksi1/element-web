/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useState } from "react";
import { SearchOrderBy } from "matrix-js-sdk/src/matrix";
import { IconButton, Menu, RadioMenuItem } from "@vector-im/compound-web";
import ChevronUpDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-up-down";

import { _t } from "../../../languageHandler";

interface Props {
    /** The active result order, owned upstream by the SearchSessionStore and threaded down as a prop. */
    order: SearchOrderBy;
    /** Re-run the active search with the chosen result order (recent vs relevant). */
    onSearchOrderChange: (order: SearchOrderBy) => void;
}

/**
 * Result-order toggle for the in-room search header (Telegram-style "sort" control), sitting beside the search
 * input, the `from:`/sender filter and the jump-to-date calendar (search Phase 5 slice 1).
 *
 * A Compound {@link Menu} of two mutually-exclusive {@link RadioMenuItem}s — **Most recent** ({@link
 * SearchOrderBy.Recent}, the default) and **Most relevant** ({@link SearchOrderBy.Rank}). Picking one re-runs the
 * active search asking the backend to order results accordingly. The selected order lives in the {@link
 * SearchSessionStore} (passed in via `order`) so it survives RoomView remounts during cross-room match stepping.
 *
 * NB: relevance ordering only takes effect on the single-source search paths (a single room — encrypted via Seshat
 * relevance, or non-encrypted via the homeserver). All-rooms and upgraded-room (chain) searches stay recency-ordered
 * regardless (their client-side merge only preserves order for recency-sorted sources) — see Searching.ts.
 */
export function RoomSearchOrderToggle({ order, onSearchOrderChange }: Props): JSX.Element {
    const [open, setOpen] = useState(false);

    return (
        <Menu
            title={_t("room|search|order_toggle_label")}
            open={open}
            onOpenChange={setOpen}
            trigger={
                <IconButton
                    size="28px"
                    // The visual indicator dot is invisible to screen readers, so fold the active (relevance)
                    // state into the accessible name when the order is non-default (mirrors the sender filter).
                    aria-label={
                        order !== SearchOrderBy.Recent
                            ? _t("room|search|order_toggle_button_active")
                            : _t("room|search|order_toggle_button")
                    }
                    data-testid="search-order-toggle-button"
                    // A dot signals that a non-default (relevance) order is active without opening the menu.
                    indicator={order !== SearchOrderBy.Recent ? "default" : undefined}
                >
                    <ChevronUpDownIcon width="20px" height="20px" />
                </IconButton>
            }
        >
            <RadioMenuItem
                label={_t("room|search|order_recent")}
                checked={order === SearchOrderBy.Recent}
                onSelect={() => onSearchOrderChange(SearchOrderBy.Recent)}
            />
            <RadioMenuItem
                label={_t("room|search|order_relevant")}
                checked={order === SearchOrderBy.Rank}
                onSelect={() => onSearchOrderChange(SearchOrderBy.Rank)}
            />
        </Menu>
    );
}
