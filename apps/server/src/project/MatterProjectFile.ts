import type { ProjectReadFileInput, ProjectReadFileResult } from "@t3tools/contracts";
import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

// Matter names the project file matter.json. A project without one still reads the fork's legacy
// names in order, so repositories shared with T3 Code users (t3.json) keep working unchanged.
const LEGACY_PROJECT_FILE_NAMES = ["mattr.json", "t3.json"];
const PROJECT_FILE_NAMES = [T3_PROJECT_FILE_NAME, ...LEGACY_PROJECT_FILE_NAMES];

/** Reads the project's matter.json, else the first legacy project file it has. */
export const readProjectFileString = (
  fileSystem: FileSystem.FileSystem,
  pathOf: (fileName: string) => string,
) =>
  PROJECT_FILE_NAMES.slice(1).reduce(
    (read, fileName) =>
      read.pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => fileSystem.readFileString(pathOf(fileName)),
        ),
      ),
    fileSystem.readFileString(pathOf(T3_PROJECT_FILE_NAME)),
  );

/** `git show`s matter.json from a ref, else the first legacy project file the ref has. */
export const showProjectFile = <A extends { readonly exitCode: number }, E, R>(
  show: (fileName: string) => Effect.Effect<A, E, R>,
) =>
  PROJECT_FILE_NAMES.slice(1).reduce(
    (shown, fileName) =>
      shown.pipe(
        Effect.filterOrElse(
          (result) => result.exitCode === 0,
          () => show(fileName),
        ),
      ),
    show(T3_PROJECT_FILE_NAME),
  );

/**
 * Clients read the project file with `allowMissing`. When the name they ask for is absent, they
 * get the first other name that exists, so web (matter.json), older web builds and upstream's
 * mobile app (t3.json) all find it.
 */
export const withProjectFileFallback =
  <E, R>(readFile: (input: ProjectReadFileInput) => Effect.Effect<ProjectReadFileResult, E, R>) =>
  (input: ProjectReadFileInput) =>
    readFile(input).pipe(
      Effect.filterOrElse(
        (result) =>
          result.exists !== false ||
          input.allowMissing !== true ||
          !PROJECT_FILE_NAMES.includes(input.relativePath),
        (result) =>
          PROJECT_FILE_NAMES.filter((name) => name !== input.relativePath)
            .reduce<Effect.Effect<ProjectReadFileResult, E, R>>(
              (found, fileName) =>
                found.pipe(
                  Effect.filterOrElse(
                    (current) => current.exists !== false,
                    () => readFile({ ...input, relativePath: fileName }),
                  ),
                ),
              Effect.succeed(result),
            )
            .pipe(Effect.map((fallback) => (fallback.exists === false ? result : fallback))),
      ),
    );
