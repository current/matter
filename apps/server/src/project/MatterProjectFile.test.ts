import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ProjectReadFileInput, ProjectReadFileResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readProjectFileString, withProjectFileFallback } from "./MatterProjectFile.ts";

const projectDir = Effect.fn("projectDir")(function* (files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "matter-project-file-" });
  for (const [name, contents] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(dir, name), contents);
  }
  return { fileSystem, at: (name: string) => path.join(dir, name) };
});

it.layer(NodeServices.layer)("MatterProjectFile", (it) => {
  describe("readProjectFileString", () => {
    it.effect("prefers matter.json over t3.json", () =>
      Effect.gen(function* () {
        const { fileSystem, at } = yield* projectDir({ "matter.json": "new", "t3.json": "old" });
        expect(yield* readProjectFileString(fileSystem, at)).toBe("new");
      }),
    );

    it.effect("reads t3.json when the project has no matter.json", () =>
      Effect.gen(function* () {
        const { fileSystem, at } = yield* projectDir({ "t3.json": "old" });
        expect(yield* readProjectFileString(fileSystem, at)).toBe("old");
      }),
    );

    it.effect("fails as not found when neither exists", () =>
      Effect.gen(function* () {
        const { fileSystem, at } = yield* projectDir({});
        const error = yield* Effect.flip(readProjectFileString(fileSystem, at));
        expect(error.reason._tag).toBe("NotFound");
      }),
    );
  });

  describe("withProjectFileFallback", () => {
    const readFrom = (files: Record<string, string>) =>
      withProjectFileFallback((input: ProjectReadFileInput) => {
        const contents = files[input.relativePath];
        return Effect.succeed<ProjectReadFileResult>({
          relativePath: input.relativePath,
          contents: contents ?? "",
          byteLength: contents?.length ?? 0,
          truncated: false,
          ...(contents === undefined ? { exists: false } : {}),
        });
      });

    it.effect("answers a matter.json read from t3.json", () =>
      Effect.gen(function* () {
        const result = yield* readFrom({ "t3.json": "old" })({
          cwd: "/repo",
          relativePath: "matter.json",
          allowMissing: true,
        });
        expect(result).toMatchObject({ relativePath: "t3.json", contents: "old" });
      }),
    );

    it.effect("answers a t3.json read from matter.json", () =>
      Effect.gen(function* () {
        const result = yield* readFrom({ "matter.json": "new" })({
          cwd: "/repo",
          relativePath: "t3.json",
          allowMissing: true,
        });
        expect(result).toMatchObject({ relativePath: "matter.json", contents: "new" });
      }),
    );

    it.effect("keeps the requested file when both exist, and the absence when neither does", () =>
      Effect.gen(function* () {
        const both = readFrom({ "matter.json": "new", "t3.json": "old" });
        expect(
          yield* both({ cwd: "/repo", relativePath: "t3.json", allowMissing: true }),
        ).toMatchObject({ contents: "old" });
        const none = yield* readFrom({})({
          cwd: "/repo",
          relativePath: "matter.json",
          allowMissing: true,
        });
        expect(none).toMatchObject({ relativePath: "matter.json", exists: false });
      }),
    );
  });
});
