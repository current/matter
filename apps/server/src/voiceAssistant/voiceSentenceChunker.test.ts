import { describe, expect, it } from "vite-plus/test";

import { createJsonStringFieldReader, createSentenceChunker } from "./voiceSentenceChunker.ts";

function feed(chunker: ReturnType<typeof createSentenceChunker>, deltas: ReadonlyArray<string>) {
  const emitted: Array<{ readonly afterDelta: number; readonly chunk: string }> = [];
  deltas.forEach((delta, index) => {
    for (const chunk of chunker.push(delta)) emitted.push({ afterDelta: index, chunk });
  });
  for (const chunk of chunker.flush()) emitted.push({ afterDelta: deltas.length, chunk });
  return emitted;
}

describe("createSentenceChunker", () => {
  it("releases the first sentence as soon as the next word starts", () => {
    const emitted = feed(createSentenceChunker(), ["Sure", " thing.", " The build", " passed!"]);
    expect(emitted).toEqual([
      { afterDelta: 2, chunk: "Sure thing." },
      { afterDelta: 4, chunk: "The build passed!" },
    ]);
  });

  it("keeps version numbers and abbreviations inside one sentence", () => {
    const chunker = createSentenceChunker();
    const emitted = feed(chunker, [
      "Upgraded to v2",
      ".5 today, e.g. the auth",
      " flow, i.e. login. Next",
      " up is Dr. Smith's review.",
    ]);
    expect(emitted.map((entry) => entry.chunk)).toEqual([
      "Upgraded to v2.5 today, e.g. the auth flow, i.e. login.",
      "Next up is Dr. Smith's review.",
    ]);
  });

  it("splits on a clause only after enough text", () => {
    const short = feed(createSentenceChunker(), ["Hey, two threads are running"]);
    expect(short.map((entry) => entry.chunk)).toEqual(["Hey, two threads are running"]);

    const long = feed(createSentenceChunker({ minClauseChars: 20 }), [
      "The auth refactor is nearly finished, and the iOS build waits",
    ]);
    expect(long.map((entry) => entry.chunk)).toEqual([
      "The auth refactor is nearly finished,",
      "and the iOS build waits",
    ]);
  });

  it("splits on newlines and question marks, and flushes the tail at end of stream", () => {
    const emitted = feed(createSentenceChunker(), ["Done\nWant me to approve it? Or", " wait"]);
    expect(emitted).toEqual([
      { afterDelta: 0, chunk: "Done" },
      { afterDelta: 0, chunk: "Want me to approve it?" },
      { afterDelta: 2, chunk: "Or wait" },
    ]);
  });

  it("keeps closing quotes and ellipses with their sentence", () => {
    const emitted = feed(createSentenceChunker(), ['It said "all green." Then... ', "it stopped"]);
    expect(emitted.map((entry) => entry.chunk)).toEqual([
      'It said "all green."',
      "Then...",
      "it stopped",
    ]);
  });

  it("cuts a run-on reply at a space once it gets too long", () => {
    const emitted = feed(createSentenceChunker({ maxChars: 30 }), [
      "one two three four five six seven eight nine ten",
    ]);
    expect(emitted.map((entry) => entry.chunk)).toEqual([
      "one two three four five six",
      "seven eight nine ten",
    ]);
  });
});

describe("createJsonStringFieldReader", () => {
  it("decodes a field split across deltas, escapes included", () => {
    const reader = createJsonStringFieldReader("spokenReply");
    const parts = [
      '{"route":"assistant","actions":[],"spoken',
      'Reply":"Hi \\"there\\"',
      ". Line\\nnext \\u00",
      'e9t\\u00e9.","displayReply":"x"}',
    ].map((delta) => reader.push(delta));
    expect(parts.join("")).toBe('Hi "there". Line\nnext été.');
    expect(reader.done).toBe(true);
    expect(reader.prefix).toBe('{"route":"assistant","actions":[],');
    expect(reader.push("more")).toBe("");
  });

  it("returns nothing until the field starts", () => {
    const reader = createJsonStringFieldReader("spokenReply");
    expect(reader.push('{"route":"assistant","displayReply":"Hello"')).toBe("");
    expect(reader.started).toBe(false);
  });
});
