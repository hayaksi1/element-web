/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import SettingsStore from "../settings/SettingsStore";
import { CommandMap } from "./SlashCommands";

/**
 * Support for bots advertising their own commands to clients, per MSC4332.
 * https://github.com/matrix-org/matrix-spec-proposals/pull/4332
 *
 * A bot maintains one state event in each room it joins, listing the commands it understands.
 * We surface those in the composer autocomplete so the commands are discoverable without the
 * user having to know them up front.
 */

/** Unstable event type from MSC4332. Becomes `m.bot.commands` once the proposal stabilises. */
export const UNSTABLE_BOT_COMMANDS_EVENT_TYPE = "org.matrix.msc4332.commands";

/** The `sigil` a bot expects, when it does not ask for a specific one. */
const DEFAULT_SIGIL = "!";

/**
 * Sigils we are willing to put in front of a command on the bot's behalf.
 * Deliberately narrow: the sigil is attacker-controlled and ends up verbatim in the composer,
 * so we do not want a bot able to prepend markup, whitespace or a bidirectional control.
 */
const ALLOWED_SIGILS = new Set(["!", "/", ".", "$", "%", "^", "&", "*", "-", "_", "+", "=", "~", "?"]);

/**
 * A command stem must be ASCII words separated by single spaces.
 *
 * This blocks homoglyph and bidirectional-override tricks, which matter because the stem is
 * rendered as a `/command` that the user is invited to trust. It matches the convention bot
 * commands already follow in practice.
 */
const VALID_STEM = /^[\w-]+(?: [\w-]+)*$/;

/** Descriptions come from a remote user, so cap what we are willing to render. */
const MAX_DESCRIPTION_LENGTH = 200;

/** Guards against a single bot flooding the autocomplete. */
export const MAX_COMMANDS_PER_BOT = 50;

/** Guards against many bots collectively flooding the autocomplete. */
export const MAX_COMMANDS_PER_ROOM = 200;

/** A single command advertised by a bot in a room. */
export interface BotCommand {
    /** The advertising bot's user ID. */
    botUserId: string;
    /** The bot's display name in this room, falling back to its user ID. */
    botDisplayName: string;
    /** First word of the stem, e.g. `hermes`. What a typed `/word` is matched against. */
    head: string;
    /** The literal part of the syntax, e.g. `hermes ban`. */
    stem: string;
    /** The `{argument}` tail of the syntax, e.g. `{userId} {reason}`. */
    placeholders: string;
    /** Human-readable summary, if the bot gave one. */
    description?: string;
    /** Exactly what is inserted into the composer, e.g. `!hermes ban `. */
    insertion: string;
}

function isEnabled(): boolean {
    return SettingsStore.getValue("feature_msc4332_bot_commands");
}

/**
 * Pull the description out of an MSC1767 extensible-events text block, ignoring anything
 * that is not shaped the way the proposal describes.
 */
function parseDescription(description: unknown): string | undefined {
    if (typeof description !== "object" || description === null) return undefined;
    const text = (description as Record<string, unknown>)["m.text"];
    if (!Array.isArray(text)) return undefined;
    const body = (text[0] as Record<string, unknown> | undefined)?.body;
    if (typeof body !== "string" || !body) return undefined;
    return body.slice(0, MAX_DESCRIPTION_LENGTH);
}

function parseSigil(sigil: unknown): string {
    return typeof sigil === "string" && ALLOWED_SIGILS.has(sigil) ? sigil : DEFAULT_SIGIL;
}

/**
 * Split an MSC4332 `syntax` template into its literal stem and its `{argument}` tail.
 * Returns undefined if the stem is not something we are prepared to render as a command.
 */
function parseSyntax(syntax: unknown): { stem: string; head: string; placeholders: string } | undefined {
    if (typeof syntax !== "string") return undefined;

    const firstPlaceholder = syntax.indexOf("{");
    const stem = (firstPlaceholder === -1 ? syntax : syntax.slice(0, firstPlaceholder)).trim();
    const placeholders = firstPlaceholder === -1 ? "" : syntax.slice(firstPlaceholder).trim();

    if (!VALID_STEM.test(stem)) return undefined;

    return { stem, head: stem.split(" ")[0], placeholders };
}

/**
 * The commands advertised by bots in this room, ready to show in the autocomplete.
 *
 * Returns an empty list when the labs flag is off.
 */
export function getBotCommands(room: Room): BotCommand[] {
    if (!isEnabled()) return [];

    const events = room.currentState.getStateEvents(UNSTABLE_BOT_COMMANDS_EVENT_TYPE);
    const commands: BotCommand[] = [];

    for (const event of events) {
        const botUserId = event.getStateKey();

        // Room version 11 authorization rule 8 already rejects a state event whose `@`-prefixed
        // state key does not match its sender, but check anyway rather than trust the server.
        if (!botUserId || botUserId !== event.getSender()) continue;

        // MSC4332: hide a bot's commands unless it is actually in the room to receive them.
        const member = room.getMember(botUserId);
        if (member?.membership !== KnownMembership.Join) continue;

        const content = event.getContent();
        if (!Array.isArray(content.commands)) continue;

        const sigil = parseSigil(content.sigil);
        const seenStems = new Set<string>();

        for (const entry of content.commands) {
            if (commands.length >= MAX_COMMANDS_PER_ROOM) return sortCommands(commands);
            if (seenStems.size >= MAX_COMMANDS_PER_BOT) break;
            if (typeof entry !== "object" || entry === null) continue;

            const parsed = parseSyntax((entry as Record<string, unknown>).syntax);
            if (!parsed) continue;

            // MSC4332: a bot must not be able to shadow one of our own commands.
            if (CommandMap.has(parsed.head)) continue;
            if (seenStems.has(parsed.stem)) continue;
            seenStems.add(parsed.stem);

            commands.push({
                botUserId,
                botDisplayName: member.rawDisplayName || botUserId,
                head: parsed.head,
                stem: parsed.stem,
                placeholders: parsed.placeholders,
                description: parseDescription((entry as Record<string, unknown>).description),
                insertion: `${sigil}${parsed.stem} `,
            });
        }
    }

    return sortCommands(commands);
}

/** Keep the order stable across syncs so the list does not reshuffle under the user. */
function sortCommands(commands: BotCommand[]): BotCommand[] {
    return commands.sort((a, b) => a.stem.localeCompare(b.stem) || a.botUserId.localeCompare(b.botUserId));
}

/**
 * Whether `text` invokes a command a bot in this room has advertised.
 *
 * Used to stop the "Unrecognised command" dialog from interrupting a command that was never
 * meant for us: a bot may advertise `/` as its sigil, which makes its commands look exactly
 * like ours to `isSlashCommand`.
 */
export function isBotCommandText(room: Room, text: string): boolean {
    if (!text) return false;

    // Match only the sigil the bot actually asked for. Suppressing the warning for any other
    // prefix would silently send a message the bot is going to ignore.
    return getBotCommands(room).some(
        (command) => text === command.insertion.trimEnd() || text.startsWith(command.insertion),
    );
}
