/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import { type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../languageHandler";
import AutocompleteProvider from "./AutocompleteProvider";
import QueryMatcher from "./QueryMatcher";
import { TextualCompletion } from "./Components";
import { type ICompletion, type ISelectionRange } from "./Autocompleter";
import { type TimelineRenderingType } from "../contexts/RoomContext";
import { type BotCommand, getBotCommands } from "../slash-commands/botCommands";

/**
 * Only the command word itself, anchored to the start of the composer.
 *
 * Deliberately narrower than CommandProvider's regex, which also swallows the arguments: we have
 * nothing useful to say about arguments yet, so the suggestions get out of the way as soon as the
 * user starts typing them.
 */
const BOT_COMMAND_RE = /^\/\w*/g;

/**
 * Suggests commands that bots in the room have advertised via MSC4332, so they can be
 * discovered the same way as the commands built in to Element.
 * https://github.com/matrix-org/matrix-spec-proposals/pull/4332
 */
export default class BotCommandProvider extends AutocompleteProvider {
    private readonly room: Room;

    public constructor(room: Room, renderingType?: TimelineRenderingType) {
        super({ commandRegex: BOT_COMMAND_RE, renderingType });
        this.room = room;
    }

    public async getCompletions(
        query: string,
        selection: ISelectionRange,
        force?: boolean,
        limit = -1,
    ): Promise<ICompletion[]> {
        const { command, range } = this.getCurrentCommand(query, selection);
        if (!command) return [];

        // getBotCommands is a no-op when the labs flag is off, which disables this provider.
        const commands = getBotCommands(this.room);
        if (!commands.length) return [];

        // A bare `/` shows everything; anything more filters, as the built-in commands do.
        const typed = command[0].slice(1);
        const matches = typed
            ? new QueryMatcher(commands, { keys: ["head", "stem", "description"] }).match(typed, limit)
            : commands;

        // MSC4332 asks us to name the bot when its command would otherwise be ambiguous.
        const stems = commands.map((c) => c.stem);
        const ambiguous = new Set(stems.filter((stem, i) => stems.indexOf(stem) !== i));

        return matches.map((botCommand) => ({
            completion: botCommand.insertion,
            type: "command",
            component: (
                <TextualCompletion
                    title={this.getTitle(botCommand, ambiguous.has(botCommand.stem))}
                    subtitle={botCommand.placeholders}
                    description={botCommand.description}
                />
            ),
            range: range!,
        }));
    }

    /**
     * Bot commands are shown in the `/command` form users already know, whatever sigil the bot
     * actually wants. The sigil only appears once the completion is inserted.
     */
    private getTitle(botCommand: BotCommand, ambiguous: boolean): string {
        const title = `/${botCommand.stem}`;
        return ambiguous ? `${title} (${botCommand.botDisplayName})` : title;
    }

    public getName(): string {
        return "🤖 " + _t("composer|autocomplete|bot_command_description");
    }

    public renderCompletions(completions: React.ReactNode[]): React.ReactNode {
        return (
            <div
                className="mx_Autocomplete_Completion_container_pill"
                aria-label={_t("composer|autocomplete|bot_command_a11y")}
            >
                {completions}
            </div>
        );
    }
}
