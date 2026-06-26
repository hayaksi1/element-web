/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    formatDateForInput,
    BaseViewModel,
    type DateSeparatorViewSnapshot as DateSeparatorViewSnapshotInterface,
    type DateSeparatorViewModel as DateSeparatorViewModelInterface,
} from "@element-hq/web-shared-components";

import { formatFullDateNoTime, getDaysArray } from "../../../DateUtils";
import { _t } from "../../../languageHandler";
import { getUserLanguage } from "../../../i18n/settings";
import SettingsStore from "../../../settings/SettingsStore";
import { UIFeature } from "../../../settings/UIFeature";
import { jumpToDateInRoom } from "../../../utils/jumpToDate";

export interface DateSeparatorViewModelProps {
    /**
     * Room ID used for jump-to-date navigation and room-switch guards.
     */
    roomId: string;
    /**
     * Timestamp used to compute the date separator label and initial picker value.
     */
    ts: number;
    /**
     * Export mode disables relative date labels and jump-to-date menu UI.
     */
    forExport?: boolean;
}

/**
 * ViewModel for the date separator, providing the current state of the component.
 */
export class DateSeparatorViewModel
    extends BaseViewModel<DateSeparatorViewSnapshotInterface, DateSeparatorViewModelProps>
    implements DateSeparatorViewModelInterface
{
    /**
     * Cached setting for UIFeature.TimelineEnableRelativeDates.
     * Updated via SettingsStore watcher to keep labels in sync at runtime.
     */
    private relativeDatesEnabled: boolean;
    /**
     * Cached setting for feature_jump_to_date.
     * Controls whether the jump-to-date menu is exposed in the snapshot.
     */
    private jumpToDateEnabled: boolean;

    public constructor(props: DateSeparatorViewModelProps) {
        const relativeDatesEnabled = SettingsStore.getValue(UIFeature.TimelineEnableRelativeDates);
        const jumpToDateEnabled = SettingsStore.getValue("feature_jump_to_date");

        super(props, {
            label: DateSeparatorViewModel.computeLabel(props, relativeDatesEnabled),
        });

        this.relativeDatesEnabled = relativeDatesEnabled;
        this.jumpToDateEnabled = jumpToDateEnabled;
        this.updateSnapshot();

        // Keep label behaviour in sync with runtime setting updates.
        const jumpToDateWatcherRef = SettingsStore.watchSetting(
            "feature_jump_to_date",
            null,
            (_settingName, _roomId, _level, _newValAtLevel, newVal) => {
                this.jumpToDateEnabled = !!newVal;
                this.updateSnapshot();
            },
        );
        this.disposables.track(() => SettingsStore.unwatchSetting(jumpToDateWatcherRef));

        const relativeDatesWatcherRef = SettingsStore.watchSetting(
            UIFeature.TimelineEnableRelativeDates,
            null,
            (_settingName, _roomId, _level, _newValAtLevel, newVal) => {
                this.relativeDatesEnabled = !!newVal;
                this.updateSnapshot();
            },
        );
        this.disposables.track(() => SettingsStore.unwatchSetting(relativeDatesWatcherRef));
    }

    private computeSnapshot(): DateSeparatorViewSnapshotInterface {
        const label = DateSeparatorViewModel.computeLabel(this.props, this.relativeDatesEnabled);
        return {
            label,
            jumpToEnabled: this.jumpToDateEnabled && !this.props.forExport,
            jumpFromDate: formatDateForInput(new Date(this.props.ts)),
        };
    }

    private updateSnapshot(): void {
        this.snapshot.set(this.computeSnapshot());
    }

    private static get relativeTimeFormat(): Intl.RelativeTimeFormat {
        return new Intl.RelativeTimeFormat(getUserLanguage(), { style: "long", numeric: "auto" });
    }

    private static computeLabel(props: DateSeparatorViewModelProps, relativeDatesEnabled: boolean): string {
        try {
            const date = new Date(props.ts);

            // During export, relative dates are ambiguous and should not be used.
            if (props.forExport || !relativeDatesEnabled) return formatFullDateNoTime(date);

            const today = new Date();
            const yesterday = new Date();
            const days = getDaysArray("long");
            yesterday.setDate(today.getDate() - 1);

            if (date.toDateString() === today.toDateString()) {
                return this.relativeTimeFormat.format(0, "day");
            } else if (date.toDateString() === yesterday.toDateString()) {
                return this.relativeTimeFormat.format(-1, "day");
            } else if (today.getTime() - date.getTime() < 6 * 24 * 60 * 60 * 1000) {
                return days[date.getDay()];
            } else {
                return formatFullDateNoTime(date);
            }
        } catch {
            return _t("common|message_timestamp_invalid");
        }
    }

    public pickDate = async (inputTimestamp: number | string | Date): Promise<void> => {
        await jumpToDateInRoom(this.props.roomId, inputTimestamp);
    };

    public onLastWeekPicked = (): Promise<void> => {
        const date = new Date();
        date.setDate(date.getDate() - 7);
        void this.pickDate(date);
        return Promise.resolve();
    };

    public onLastMonthPicked = (): Promise<void> => {
        const date = new Date();
        // Month numbers are 0-11 and setMonth handles rollover.
        date.setMonth(date.getMonth() - 1, 1);
        void this.pickDate(date);
        return Promise.resolve();
    };

    public onBeginningPicked = (): Promise<void> => {
        void this.pickDate(new Date(0));
        return Promise.resolve();
    };

    public onDatePicked = (dateString: string): Promise<void> => {
        void this.pickDate(dateString);
        return Promise.resolve();
    };
}
