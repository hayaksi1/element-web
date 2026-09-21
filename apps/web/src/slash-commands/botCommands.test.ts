/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { type MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import SettingsStore from "../settings/SettingsStore";
import {
    getBotCommands,
    isBotCommandText,
    MAX_COMMANDS_PER_BOT,
    MAX_COMMANDS_PER_ROOM,
    UNSTABLE_BOT_COMMANDS_EVENT_TYPE,
} from "./botCommands";

const ROOM_ID = "!room:example.org";
const BOT = "@hermes:example.org";
const OTHER_BOT = "@giphy:example.org";
const ME = "@alice:example.org";

/** Build an MSC4332 `org.matrix.msc4332.commands` state event. */
function mkCommandsEvent(sender: string, content: object, stateKey = sender): MatrixEvent {
    return new MatrixEvent({
        type: UNSTABLE_BOT_COMMANDS_EVENT_TYPE,
        room_id: ROOM_ID,
        sender,
        state_key: stateKey,
        event_id: `$commands-${stateKey}`,
        origin_server_ts: 0,
        content: content as Record<string, unknown>,
    });
}

function mkMemberEvent(userId: string, membership: string, displayName?: string): MatrixEvent {
    return new MatrixEvent({
        type: "m.room.member",
        room_id: ROOM_ID,
        sender: userId,
        state_key: userId,
        event_id: `$member-${userId}-${membership}`,
        origin_server_ts: 0,
        content: { membership, displayname: displayName },
    });
}

describe("botCommands", () => {
    let client: MatrixClient;
    let room: Room;

    beforeEach(() => {
        client = stubClient();
        room = new Room(ROOM_ID, client, ME);
        room.currentState.setStateEvents([mkMemberEvent(ME, KnownMembership.Join, "Alice")]);
        // The feature is behind a labs flag; default it on for these tests and assert the
        // off-case explicitly below.
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            (name: string) => name === "feature_msc4332_bot_commands",
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Join `bot` to the room and have it advertise `commands`. */
    function advertise(bot: string, content: object, displayName?: string): void {
        room.currentState.setStateEvents([
            mkMemberEvent(bot, KnownMembership.Join, displayName),
            mkCommandsEvent(bot, content),
        ]);
    }

    describe("getBotCommands", () => {
        it("parses a well-formed advertisement", () => {
            advertise(
                BOT,
                {
                    sigil: "!",
                    commands: [
                        {
                            syntax: "hermes ban {userId} {reason}",
                            description: { "m.text": [{ body: "Ban a user" }] },
                        },
                    ],
                },
                "Hermes",
            );

            expect(getBotCommands(room)).toEqual([
                {
                    botUserId: BOT,
                    botDisplayName: "Hermes",
                    head: "hermes",
                    stem: "hermes ban",
                    placeholders: "{userId} {reason}",
                    description: "Ban a user",
                    insertion: "!hermes ban ",
                },
            ]);
        });

        it("handles a command with no arguments", () => {
            advertise(BOT, { commands: [{ syntax: "deploy" }] });

            const [command] = getBotCommands(room);
            expect(command.stem).toBe("deploy");
            expect(command.placeholders).toBe("");
            expect(command.description).toBeUndefined();
        });

        it("returns nothing when the labs flag is off", () => {
            advertise(BOT, { commands: [{ syntax: "deploy" }] });
            // Sanity check that this fixture does produce a command when enabled, so that this
            // test cannot pass vacuously.
            expect(getBotCommands(room)).toHaveLength(1);

            vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
            expect(getBotCommands(room)).toEqual([]);
        });

        it("defaults the sigil to `!` when it is absent, over-long or not allow-listed", () => {
            advertise(BOT, { commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].insertion).toBe("!deploy ");

            advertise(BOT, { sigil: "!!", commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].insertion).toBe("!deploy ");

            advertise(BOT, { sigil: "<", commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].insertion).toBe("!deploy ");

            advertise(BOT, { sigil: 42, commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].insertion).toBe("!deploy ");
        });

        it("honours an allow-listed sigil", () => {
            advertise(BOT, { sigil: "/", commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].insertion).toBe("/deploy ");
        });

        it("ignores an advertisement whose state key is not its sender", () => {
            room.currentState.setStateEvents([
                mkMemberEvent(BOT, KnownMembership.Join),
                // Spoofed: alice tries to advertise commands on the bot's behalf.
                mkCommandsEvent(ME, { commands: [{ syntax: "deploy" }] }, BOT),
            ]);

            expect(getBotCommands(room)).toEqual([]);
        });

        it("ignores a bot that is not joined to the room", () => {
            for (const membership of [KnownMembership.Invite, KnownMembership.Leave, KnownMembership.Ban]) {
                room.currentState.setStateEvents([
                    mkMemberEvent(BOT, membership),
                    mkCommandsEvent(BOT, { commands: [{ syntax: "deploy" }] }),
                ]);
                expect(getBotCommands(room)).toEqual([]);
            }
        });

        it("hides a command that collides with a built-in command or alias", () => {
            advertise(BOT, {
                commands: [
                    { syntax: "help" }, // built-in command
                    { syntax: "kick {userId}" }, // built-in alias of /remove
                    { syntax: "status" }, // built-in command from status.ts
                    { syntax: "deploy" }, // not built in
                ],
            });

            expect(getBotCommands(room).map((c) => c.stem)).toEqual(["deploy"]);
        });

        it("rejects a head containing whitespace tricks or non-ASCII lookalikes", () => {
            advertise(BOT, {
                commands: [
                    { syntax: "  " },
                    { syntax: "‮deploy" }, // RTL override
                    { syntax: "ԁeploy" }, // Cyrillic 'ԁ' homoglyph
                    { syntax: "dep loy  extra" }, // double space inside the stem
                    { syntax: "ok_command" },
                ],
            });

            expect(getBotCommands(room).map((c) => c.stem)).toEqual(["ok_command"]);
        });

        it("ignores malformed entries without discarding the good ones", () => {
            advertise(BOT, {
                commands: [null, 42, {}, { syntax: "" }, { syntax: 7 }, { syntax: "good" }],
            });

            expect(getBotCommands(room).map((c) => c.stem)).toEqual(["good"]);
        });

        it("ignores an advertisement whose commands property is not an array", () => {
            advertise(BOT, { commands: { syntax: "deploy" } });
            expect(getBotCommands(room)).toEqual([]);
        });

        it("caps the number of commands accepted from one bot", () => {
            advertise(BOT, {
                commands: Array.from({ length: MAX_COMMANDS_PER_BOT + 10 }, (_, i) => ({ syntax: `cmd${i}` })),
            });

            expect(getBotCommands(room)).toHaveLength(MAX_COMMANDS_PER_BOT);
        });

        it("caps the number of commands accepted from the whole room", () => {
            const botCount = Math.ceil(MAX_COMMANDS_PER_ROOM / MAX_COMMANDS_PER_BOT) + 1;
            for (let b = 0; b < botCount; b++) {
                advertise(`@bot${b}:example.org`, {
                    commands: Array.from({ length: MAX_COMMANDS_PER_BOT }, (_, i) => ({ syntax: `b${b}cmd${i}` })),
                });
            }

            expect(getBotCommands(room)).toHaveLength(MAX_COMMANDS_PER_ROOM);
        });

        it("de-duplicates a stem advertised twice by the same bot", () => {
            advertise(BOT, { commands: [{ syntax: "deploy" }, { syntax: "deploy {verbose}" }] });
            expect(getBotCommands(room)).toHaveLength(1);
        });

        it("keeps the same stem from two different bots and orders results stably", () => {
            advertise(OTHER_BOT, { commands: [{ syntax: "roll {sides}" }] }, "Giphy");
            advertise(BOT, { commands: [{ syntax: "roll" }] }, "Hermes");

            expect(getBotCommands(room).map((c) => c.botUserId)).toEqual([OTHER_BOT, BOT]);
        });

        it("truncates an over-long description", () => {
            advertise(BOT, {
                commands: [{ syntax: "deploy", description: { "m.text": [{ body: "x".repeat(500) }] } }],
            });

            expect(getBotCommands(room)[0].description).toHaveLength(200);
        });

        it("ignores a description that is not extensible-event shaped", () => {
            advertise(BOT, { commands: [{ syntax: "deploy", description: "just a string" }] });
            expect(getBotCommands(room)[0].description).toBeUndefined();
        });

        it("falls back to the user ID when the bot has no display name", () => {
            advertise(BOT, { commands: [{ syntax: "deploy" }] });
            expect(getBotCommands(room)[0].botDisplayName).toBe(BOT);
        });
    });

    describe("isBotCommandText", () => {
        beforeEach(() => {
            advertise(BOT, { sigil: "/", commands: [{ syntax: "deploy" }, { syntax: "hermes ban {userId}" }] });
        });

        it.each([
            ["/deploy", true],
            ["/deploy ", true],
            ["/deploy now", true],
            // The bot asked for `/`, so the `!` form is not something it will act on.
            ["!deploy", false],
            ["/hermes ban @bob:example.org", true],
            ["/deployment", false],
            ["/deploy2", false],
            ["/unknown", false],
            ["/hermes", false],
            ["deploy", false],
            ["", false],
        ])("returns %s -> %s", (text, expected) => {
            expect(isBotCommandText(room, text)).toBe(expected);
        });

        it("returns false when the labs flag is off", () => {
            expect(isBotCommandText(room, "/deploy")).toBe(true);
            vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
            expect(isBotCommandText(room, "/deploy")).toBe(false);
        });
    });
});
