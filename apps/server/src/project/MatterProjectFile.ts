import type { ProjectReadFileInput, ProjectReadFileResult } from "@t3tools/contracts";
import { T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

// Matter renames the project file to matter.json. A project without one still reads upstream's
// t3.json, so repositories shared with T3 Code users keep working unchanged.
const LEGACY_PROJECT_FILE_NAME = "t3.json";

const otherProjectFileName = (relativePath: string) =>
  relativePath === T3_PROJECT_FILE_NAME
    ? LEGACY_PROJECT_FILE_NAME
    : relativePath === LEGACY_PROJECT_FILE_NAME
      ? T3_PROJECT_FILE_NAME
      : null;

/** Reads the project's matter.json, or its t3.json when there is no matter.json. */
export const readProjectFileString = (
  fileSystem: FileSystem.FileSystem,
  pathOf: (fileName: string) => string,
) =>
  fileSystem.readFileString(pathOf(T3_PROJECT_FILE_NAME)).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => fileSystem.readFileString(pathOf(LEGACY_PROJECT_FILE_NAME)),
    ),
  );

/** `git show`s matter.json from a ref, or t3.json when the ref has no matter.json. */
export const showProjectFile = <A extends { readonly exitCode: number }, E, R>(
  show: (fileName: string) => Effect.Effect<A, E, R>,
) =>
  show(T3_PROJECT_FILE_NAME).pipe(
    Effect.filterOrElse(
      (result) => result.exitCode === 0,
      () => show(LEGACY_PROJECT_FILE_NAME),
    ),
  );

/**
 * Clients read the project file with `allowMissing`. When the name they ask for is absent, they
 * get the other one, so web (matter.json) and upstream's mobile app (t3.json) both find it.
 */
export const withProjectFileFallback =
  <E, R>(readFile: (input: ProjectReadFileInput) => Effect.Effect<ProjectReadFileResult, E, R>) =>
  (input: ProjectReadFileInput) =>
    readFile(input).pipe(
      Effect.flatMap((result) => {
        const other = otherProjectFileName(input.relativePath);
        if (result.exists !== false || input.allowMissing !== true || other === null) {
          return Effect.succeed(result);
        }
        return readFile({ ...input, relativePath: other }).pipe(
          Effect.map((fallback) => (fallback.exists === false ? result : fallback)),
        );
      }),
    );
