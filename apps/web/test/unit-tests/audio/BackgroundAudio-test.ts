/*
Copyright 2026 hayaksi1

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { BackgroundAudio } from "../../../src/audio/BackgroundAudio";
import { createAudioContext } from "../../../src/audio/compat";

jest.mock("../../../src/audio/compat", () => ({
    createAudioContext: jest.fn(),
}));

describe("BackgroundAudio", () => {
    let audioContext: {
        createBufferSource: jest.Mock;
        decodeAudioData: jest.Mock;
        resume: jest.Mock;
        suspend: jest.Mock;
        destination: object;
    };

    /** The sources handed out by the mocked context, in the order they were created. */
    let sources: Array<{ start: jest.Mock; disconnect: jest.Mock; onended?: () => void }>;

    beforeEach(() => {
        sources = [];
        audioContext = {
            createBufferSource: jest.fn().mockImplementation(() => {
                const source = { start: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
                sources.push(source);
                return source;
            }),
            decodeAudioData: jest.fn().mockResolvedValue({}),
            resume: jest.fn().mockResolvedValue(undefined),
            suspend: jest.fn().mockResolvedValue(undefined),
            destination: {},
        };
        jest.mocked(createAudioContext).mockReturnValue(audioContext as unknown as AudioContext);

        // Every sound is fetched before it is decoded, and the decoding is mocked out above.
        global.fetch = jest.fn().mockResolvedValue({
            status: 200,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }) as unknown as typeof global.fetch;
    });

    it("suspends the context once the sound has finished", async () => {
        const audio = new BackgroundAudio();

        await audio.play("sound.mp3");
        expect(audioContext.suspend).not.toHaveBeenCalled();

        sources[0].onended!();

        expect(audioContext.suspend).toHaveBeenCalled();
    });

    it("keeps playing a sound that outlasts one started before it", async () => {
        const audio = new BackgroundAudio();

        await audio.play("first.mp3");
        await audio.play("second.mp3");

        // The first sound finishes while the second is still going.
        sources[0].onended!();

        expect(audioContext.suspend).not.toHaveBeenCalled();

        sources[1].onended!();

        expect(audioContext.suspend).toHaveBeenCalledTimes(1);
    });
});
