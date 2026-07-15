/*
 * Copyright 2026 hayaksi1
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "jest-matrix-react";
import { mocked } from "jest-mock";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { ChatBackgroundPanel } from "../../../../../src/components/views/settings/ChatBackgroundPanel";
import MatrixClientContext from "../../../../../src/contexts/MatrixClientContext";
import { stubClient } from "../../../../test-utils";
import SettingsStore from "../../../../../src/settings/SettingsStore";
import { SettingLevel } from "../../../../../src/settings/SettingLevel";

describe("<ChatBackgroundPanel />", () => {
    let client: MatrixClient;
    let settings: Record<string, unknown>;
    let setValueSpy: jest.SpyInstance;

    beforeEach(() => {
        client = stubClient();
        settings = {
            "RoomView.backgroundImage": null,
            "RoomView.backgroundOpacity": 1,
        };
        const realGetValue = SettingsStore.getValue.bind(SettingsStore);
        jest.spyOn(SettingsStore, "getValue").mockImplementation(((name: string, ...rest: unknown[]) =>
            name in settings
                ? settings[name]
                : (realGetValue as (...args: unknown[]) => unknown)(name, ...rest)) as typeof SettingsStore.getValue);
        setValueSpy = jest
            .spyOn(SettingsStore, "setValue")
            .mockImplementation(async (name: string, _roomId, _level, value: unknown) => {
                settings[name] = value;
            });
    });

    afterEach(() => jest.restoreAllMocks());

    const renderPanel = (): ReturnType<typeof render> =>
        render(
            <MatrixClientContext.Provider value={client}>
                <ChatBackgroundPanel />
            </MatrixClientContext.Provider>,
        );

    it("renders the preset options", () => {
        renderPanel();
        for (const name of ["None", "Dots", "Grid", "Diagonal", "Soft gradient"]) {
            expect(screen.getByRole("radio", { name })).toBeInTheDocument();
        }
    });

    it("selects None by default", () => {
        renderPanel();
        expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
    });

    it("writes the chosen preset at the account level", async () => {
        renderPanel();
        act(() => screen.getByRole("radio", { name: "Dots" }).click());
        await waitFor(() =>
            expect(setValueSpy).toHaveBeenCalledWith("RoomView.backgroundImage", null, SettingLevel.ACCOUNT, "dots"),
        );
    });

    it("clears the background when None is chosen", async () => {
        settings["RoomView.backgroundImage"] = "dots";
        renderPanel();
        act(() => screen.getByRole("radio", { name: "None" }).click());
        await waitFor(() =>
            expect(setValueSpy).toHaveBeenCalledWith("RoomView.backgroundImage", null, SettingLevel.ACCOUNT, null),
        );
    });

    it("writes the opacity when the slider changes", async () => {
        settings["RoomView.backgroundImage"] = "dots";
        renderPanel();
        fireEvent.change(screen.getByRole("slider"), { target: { value: "0.5" } });
        await waitFor(() =>
            expect(setValueSpy).toHaveBeenCalledWith("RoomView.backgroundOpacity", null, SettingLevel.ACCOUNT, 0.5),
        );
    });

    it("disables the opacity slider when no background is set", () => {
        renderPanel();
        expect(screen.getByRole("slider")).toBeDisabled();
    });

    it("uploads a custom image and stores its mxc uri", async () => {
        mocked(client.uploadContent).mockResolvedValue({ content_uri: "mxc://server/uploaded" });
        renderPanel();
        const file = new File(["x"], "wallpaper.png", { type: "image/png" });
        fireEvent.change(screen.getByTestId("chatBackgroundUpload"), { target: { files: [file] } });

        await waitFor(() => expect(client.uploadContent).toHaveBeenCalledWith(file));
        await waitFor(() =>
            expect(setValueSpy).toHaveBeenCalledWith(
                "RoomView.backgroundImage",
                null,
                SettingLevel.ACCOUNT,
                "mxc://server/uploaded",
            ),
        );
    });

    it("shows an error when the upload fails", async () => {
        mocked(client.uploadContent).mockRejectedValue(new Error("boom"));
        renderPanel();
        const file = new File(["x"], "wallpaper.png", { type: "image/png" });
        fireEvent.change(screen.getByTestId("chatBackgroundUpload"), { target: { files: [file] } });

        expect(await screen.findByText("Couldn't upload image. Please try again.")).toBeInTheDocument();
    });

    it("offers to remove a custom uploaded image", async () => {
        settings["RoomView.backgroundImage"] = "mxc://server/custom";
        renderPanel();
        expect(screen.getByRole("radio", { name: "Custom image" })).toBeInTheDocument();

        act(() => screen.getByRole("button", { name: "Remove" }).click());
        await waitFor(() =>
            expect(setValueSpy).toHaveBeenCalledWith("RoomView.backgroundImage", null, SettingLevel.ACCOUNT, null),
        );
    });
});
