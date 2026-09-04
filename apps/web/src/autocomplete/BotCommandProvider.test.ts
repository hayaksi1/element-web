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
import { isBotCommandText, UNSTABLE_BOT_COMMANDS_EVENT_TYPE } from "../slash-commands/botCommands";
import EditorModel from "../editor/model";
import { CommandPartCreator } from "../editor/parts";
import { textSerialize } from "../editor/serialize";
import { isSlashCommand } from "../editor/commands";
import BotCommandProvider from "./BotCommandProvider";

const ROOM_ID = "!room:example.org";
const BOT = "@hermes:example.org";
const OTHER_BOT = "@giphy:example.org";
const ME = "@alice:example.org";

function mkStateEvent(type: string, sender: string, content: object): MatrixEvent {
    return new MatrixEvent({
        type,
        room_id: ROOM_ID,
        sender,
        state_key: sender,
        event_id: `$${type}-${sender}`,
        origin_server_ts: 0,
        content: content as Record<string, unknown>,
    });
}

describe("BotCommandProvider", () => {
    let client: MatrixClient;
    let room: Room;

    /** Join `bot` to the room and have it advertise `commands`. */
    function advertise(bot: string, content: object, displayName?: string): void {
        room.currentState.setStateEvents([
            mkStateEvent("m.room.member", bot, { membership: KnownMembership.Join, displayname: displayName }),
            mkStateEvent(UNSTABLE_BOT_COMMANDS_EVENT_TYPE, bot, content),
        ]);
    }

    /** Ask the provider to complete `query`, with the caret at the end of it. */
    function complete(query: string) {
        return new BotCommandProvider(room).getCompletions(query, {
            beginning: true,
            start: query.length,
            end: query.length,
        });
    }

    beforeEach(() => {
        client = stubClient();
        room = new Room(ROOM_ID, client, ME);
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            (name: string) => name === "feature_msc4332_bot_commands",
        );
        advertise(
            BOT,
            {
                commands: [
                    { syntax: "deploy {env}", description: { "m.text": [{ body: "Deploy a build" }] } },
                    { syntax: "rollback", description: { "m.text": [{ body: "Undo the last deploy" }] } },
                ],
            },
            "Hermes",
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns nothing when the labs flag is off", async () => {
        // Sanity check so that this test cannot pass vacuously.
        expect(await complete("/")).toHaveLength(2);

        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        expect(await complete("/")).toEqual([]);
    });

    it("lists every advertised command for a bare slash", async () => {
        const completions = await complete("/");
        expect(completions.map((c) => c.completion)).toEqual(["!deploy ", "!rollback "]);
    });

    it("inserts the sigil form the bot expects, not the displayed slash form", async () => {
        advertise(OTHER_BOT, { sigil: "/", commands: [{ syntax: "gif {search}" }] }, "Giphy");

        const completions = await complete("/gif");
        expect(completions).toHaveLength(1);
        expect(completions[0].completion).toBe("/gif ");
    });

    it("marks completions as commands so the composer inserts them as a command part", async () => {
        const [completion] = await complete("/deploy");
        expect(completion.type).toBe("command");
    });

    it("matches a partial command name", async () => {
        const completions = await complete("/roll");
        expect(completions.map((c) => c.completion)).toEqual(["!rollback "]);
    });

    it("returns nothing for a query that matches no command", async () => {
        expect(await complete("/nosuchthing")).toEqual([]);
    });

    it("replaces only the typed word, leaving any typed arguments alone", async () => {
        const [completion] = await complete("/deploy");
        expect(completion.range).toEqual({ start: 0, end: 7 });
    });

    it("stops offering completions once the caret moves past the command word", async () => {
        const query = "/deploy prod";
        const completions = await new BotCommandProvider(room).getCompletions(query, {
            beginning: true,
            start: query.length,
            end: query.length,
        });
        expect(completions).toEqual([]);
    });

    it("does not offer completions when the slash is not at the start of the message", async () => {
        expect(await complete("hello /deploy")).toEqual([]);
    });

    it("shows the argument placeholders and description", async () => {
        const [completion] = await complete("/deploy");
        const { title, subtitle, description } = completion.component.props as Record<string, string>;
        expect(title).toBe("/deploy");
        expect(subtitle).toBe("{env}");
        expect(description).toBe("Deploy a build");
    });

    it("disambiguates by bot name when two bots advertise the same command", async () => {
        advertise(OTHER_BOT, { commands: [{ syntax: "deploy {env}" }] }, "Giphy");

        const titles = (await complete("/deploy"))
            .map((c) => (c.component.props as Record<string, string>).title)
            .filter((title) => title.startsWith("/deploy"));
        expect(titles).toEqual(["/deploy (Giphy)", "/deploy (Hermes)"]);
    });

    it("does not disambiguate when a command name is unique", async () => {
        const [completion] = await complete("/rollback");
        expect((completion.component.props as Record<string, string>).title).toBe("/rollback");
    });

    describe("what it emits is safe for the composer to insert", () => {
        /** Insert `completion` the way AutocompleteWrapperModel does for a `command` completion. */
        const insert = (text: string): EditorModel => {
            const partCreator = new CommandPartCreator(room, client);
            return new EditorModel([partCreator.command(text)], partCreator);
        };

        it("serialises the inserted command verbatim", async () => {
            const [completion] = await complete("/deploy");
            expect(textSerialize(insert(completion.completion))).toBe("!deploy ");
        });

        it("is not treated as one of our own slash commands when the bot uses another sigil", async () => {
            const [completion] = await complete("/deploy");
            // `!deploy ` must reach the bot as an ordinary message rather than being intercepted.
            expect(isSlashCommand(insert(completion.completion))).toBe(false);
        });

        it("is still recognised as command-shaped when the bot asks for a slash sigil", async () => {
            advertise(OTHER_BOT, { sigil: "/", commands: [{ syntax: "gif {search}" }] }, "Giphy");

            const [completion] = await complete("/gif");
            const model = insert(completion.completion);
            expect(textSerialize(model)).toBe("/gif ");
            // This is the case that needs isBotCommandText to suppress the unknown-command dialog.
            expect(isSlashCommand(model)).toBe(true);
            expect(isBotCommandText(room, textSerialize(model).trimEnd())).toBe(true);
        });
    });
});
