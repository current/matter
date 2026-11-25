import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNdjsonReader,
  createPlaybackQueue,
  type ClipPlayback,
  type PreparedClip,
  type VoiceTurnStreamEvent,
} from "./voiceTurnStream";

describe("createNdjsonReader", () => {
  it("emits events whole even when a line is split across reads", () => {
    const events: VoiceTurnStreamEvent[] = [];
    const reader = createNdjsonReader((event) => events.push(event));
    reader.push('{"type":"text_delta","te');
    expect(events).toEqual([]);
    reader.push('xt":"Hi"}\n{"type":"bogus"}\nnot json\n{"type":"done","reply":"Hi",');
    reader.push('"displayReply":"Hi","route":"assistant","expectFollowUp":false,');
    reader.push('"actions":[],"toolCalls":[]}');
    reader.end();
    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
  });
});

function fakeClips() {
  const prepared: string[] = [];
  const clips: Array<{
    label: string;
    finish: () => void;
    playback: ClipPlayback & {
      stop: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const discarded: string[] = [];
  const prepare = vi.fn(async (audio: { readonly bytes: Uint8Array }): Promise<PreparedClip> => {
    const label = new TextDecoder().decode(audio.bytes);
    prepared.push(label);
    return {
      start: async () => {
        let finish!: () => void;
        let stopNow!: () => void;
        const done = new Promise<"finished" | "stopped">((resolve) => {
          finish = () => resolve("finished");
          stopNow = () => resolve("stopped");
        });
        const playback = {
          done,
          stop: vi.fn(() => stopNow()),
          pause: vi.fn(),
          resume: vi.fn(),
        };
        clips.push({ label, finish, playback });
        return playback;
      },
      discard: () => discarded.push(label),
    };
  });
  const audio = (label: string) => ({
    bytes: new TextEncoder().encode(label),
    contentType: "audio/mpeg",
  });
  return { prepare, prepared, clips, discarded, audio };
}

describe("createPlaybackQueue", () => {
  it("plays the first clip at once and preloads the next for a gapless handoff", async () => {
    const { prepare, prepared, clips, audio } = fakeClips();
    const queue = createPlaybackQueue(prepare);
    queue.enqueue(audio("one"));
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    queue.enqueue(audio("two"));
    queue.end();
    // Sentence two is loaded while sentence one still plays.
    await vi.waitFor(() => expect(prepared).toEqual(["one", "two"]));
    expect(clips).toHaveLength(1);

    clips[0]!.finish();
    await vi.waitFor(() => expect(clips.map((clip) => clip.label)).toEqual(["one", "two"]));
    clips[1]!.finish();
    await expect(queue.done).resolves.toBe("finished");
    expect(queue.played).toBe(2);
  });

  it("pauses the current clip, holds the next one, and resumes in place", async () => {
    const { prepare, clips, audio } = fakeClips();
    const queue = createPlaybackQueue(prepare);
    queue.enqueue(audio("one"));
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    queue.pause();
    expect(clips[0]!.playback.pause).toHaveBeenCalled();
    queue.enqueue(audio("two"));
    clips[0]!.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(clips).toHaveLength(1);

    queue.resume();
    await vi.waitFor(() => expect(clips).toHaveLength(2));
    queue.end();
    clips[1]!.finish();
    await expect(queue.done).resolves.toBe("finished");
  });

  it("stop ends the current clip and discards everything queued", async () => {
    const { prepare, clips, discarded, audio } = fakeClips();
    const queue = createPlaybackQueue(prepare);
    queue.enqueue(audio("one"));
    queue.enqueue(audio("two"));
    queue.enqueue(audio("three"));
    await vi.waitFor(() => expect(clips).toHaveLength(1));
    queue.stop();
    expect(clips[0]!.playback.stop).toHaveBeenCalled();
    await expect(queue.done).resolves.toBe("stopped");
    await vi.waitFor(() => expect(discarded).toEqual(["two", "three"]));
    // Late chunks after a barge-in are ignored.
    queue.enqueue(audio("four"));
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("skips a clip that fails to load", async () => {
    const { prepare, clips, audio } = fakeClips();
    prepare.mockRejectedValueOnce(new Error("bad mp3"));
    const queue = createPlaybackQueue(prepare);
    queue.enqueue(audio("broken"));
    queue.enqueue(audio("fine"));
    queue.end();
    await vi.waitFor(() => expect(clips.map((clip) => clip.label)).toEqual(["fine"]));
    clips[0]!.finish();
    await expect(queue.done).resolves.toBe("finished");
  });

  it("an empty reply finishes as soon as it ends", async () => {
    const queue = createPlaybackQueue(fakeClips().prepare);
    queue.end();
    await expect(queue.done).resolves.toBe("finished");
  });
});
