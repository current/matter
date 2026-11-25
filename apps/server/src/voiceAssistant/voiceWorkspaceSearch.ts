import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { VoiceWorkspaceProjectSummary } from "../../../../antimatter/voice-assistant/types.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "coverage",
  ".t3",
  "target",
  "Pods",
  ".gradle",
  ".expo",
  ".repos",
  "out",
  ".output",
]);

const SEARCHABLE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".py",
  ".rs",
  ".go",
  ".swift",
  ".kt",
  ".java",
  ".rb",
  ".sh",
  ".css",
  ".html",
  ".sql",
]);

const SENSITIVE_SEGMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\.|$)/i,
  /secret/i,
  /credential/i,
  /private[_-]?key/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /^\.(npmrc|netrc|pypirc|pgpass|dockerconfigjson)$/i,
  /^(auth|tokens?)\.json$/i,
  /service[_-]?account.*\.json$/i,
];

const MAX_SCAN_FILE_BYTES = 256 * 1024;
const DEFAULT_READ_MAX_CHARS = 4000;
const MIN_READ_MAX_CHARS = 200;
const MAX_READ_MAX_CHARS = 8000;
const MAX_WALK_DEPTH = 6;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "does",
  "what",
  "where",
  "when",
  "why",
  "this",
  "that",
  "from",
  "into",
  "about",
  "our",
  "your",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "can",
  "could",
  "would",
  "should",
  "work",
  "works",
]);

export interface WorkspaceSearchThreadHit {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly updatedAt: string;
  readonly excerpts: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}

export interface WorkspaceSearchFileHit {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly relativePath: string;
  readonly snippet: string;
}

export interface WorkspaceSearchResult {
  readonly query: string;
  readonly depth: "quick" | "deep";
  readonly threadHits: ReadonlyArray<WorkspaceSearchThreadHit>;
  readonly fileHits: ReadonlyArray<WorkspaceSearchFileHit>;
}

export interface SafeProjectFileResult {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly relativePath: string;
  readonly content: string;
  readonly truncated: boolean;
}

function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) =>
    SENSITIVE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)),
  );
}

function tokenizeQuery(query: string): ReadonlyArray<string> {
  const rawTokens = query
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const meaningful = rawTokens.filter((token) => !STOP_WORDS.has(token));
  return [...new Set(meaningful.length > 0 ? meaningful : rawTokens)];
}

function scoreTextMatch(
  text: string,
  queryLower: string,
  tokens: ReadonlyArray<string>,
): { readonly score: number; readonly firstOffset: number } {
  if (tokens.length === 0) return { score: 0, firstOffset: -1 };
  const lower = text.toLowerCase();
  const exactIdx = queryLower.length >= 3 ? lower.indexOf(queryLower) : -1;
  let score = exactIdx >= 0 ? 40 : 0;
  let firstOffset = exactIdx;
  let matchedTokens = 0;

  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0) {
      matchedTokens++;
      score += 12;
      if (firstOffset === -1 || idx < firstOffset) {
        firstOffset = idx;
      }
    }
  }
  if (matchedTokens === 0) return { score: 0, firstOffset: -1 };
  if (matchedTokens === tokens.length) score += 20;
  return { score, firstOffset };
}

function extractBoundedExcerpt(content: string, offset: number, maxChars: number): string {
  const clean = content.replace(/\r\n/g, "\n");
  if (clean.length <= maxChars) return clean.trim();
  const lead = Math.floor(maxChars * 0.25);
  const start = offset > 0 ? Math.max(0, offset - lead) : 0;
  const sliced = clean.slice(start, start + maxChars).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = start + maxChars < clean.length ? "…" : "";
  return `${prefix}${sliced}${suffix}`;
}

function pathPriorityBonus(relativePath: string): number {
  const lower = relativePath.toLowerCase().replaceAll("\\", "/");
  if (lower.startsWith("antimatter/research/") || lower.startsWith("docs/")) return 18;
  if (lower.startsWith("antimatter/")) return 12;
  if (lower.endsWith("readme.md") || lower.endsWith("context.md")) return 15;
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return 8;
  return 0;
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Validates that `relativePath` stays strictly inside `workspaceRoot` and is not a secret file. */
const resolveSafeProjectFilePath = Effect.fn("voiceWorkspaceSearch.resolveSafeProjectFilePath")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }): Effect.fn.Return<
    | { readonly ok: true; readonly absolutePath: string; readonly normalizedRelativePath: string }
    | { readonly ok: false; readonly reason: string }
  > {
    const { path } = input;
    const raw = input.relativePath.trim();
    if (raw.length === 0 || raw.includes("\0")) {
      return { ok: false, reason: "Invalid file path." };
    }
    if (path.isAbsolute(raw) || raw.startsWith("\\") || raw.startsWith("~")) {
      return { ok: false, reason: "Only paths relative to the project root are allowed." };
    }
    const normalizedSlash = raw.replaceAll("\\", "/");
    const segments = normalizedSlash.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "..")) {
      return { ok: false, reason: "Path traversal outside the project root is not allowed." };
    }
    if (isSensitivePath(normalizedSlash)) {
      return { ok: false, reason: "Reading secret or credential files is not allowed." };
    }

    const resolvedRoot = path.resolve(input.workspaceRoot);
    const resolvedCandidate = path.resolve(resolvedRoot, raw);
    if (!isInsideRoot(path, resolvedRoot, resolvedCandidate)) {
      return { ok: false, reason: "Path resolves outside the registered project root." };
    }

    const realRoot = yield* input.fileSystem
      .realPath(resolvedRoot)
      .pipe(Effect.orElseSucceed(() => resolvedRoot));
    const realCandidate = yield* input.fileSystem
      .realPath(resolvedCandidate)
      .pipe(Effect.orElseSucceed(() => null));
    if (realCandidate === null) {
      return { ok: false, reason: `File "${raw}" was not found.` };
    }
    if (!isInsideRoot(path, realRoot, realCandidate)) {
      return { ok: false, reason: "Symlink resolves outside the registered project root." };
    }
    if (isSensitivePath(path.relative(realRoot, realCandidate))) {
      return { ok: false, reason: "Reading secret or credential files is not allowed." };
    }

    return {
      ok: true,
      absolutePath: realCandidate,
      normalizedRelativePath: path.relative(realRoot, realCandidate).replaceAll("\\", "/"),
    };
  },
);

export const readSafeProjectFile = Effect.fn("voiceWorkspaceSearch.readSafeProjectFile")(
  function* (input: {
    readonly project: VoiceWorkspaceProjectSummary;
    readonly relativePath: string;
    readonly maxChars?: number | undefined;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }): Effect.fn.Return<
    | { readonly ok: true; readonly result: SafeProjectFileResult }
    | { readonly ok: false; readonly error: string }
  > {
    const resolved = yield* resolveSafeProjectFilePath({
      workspaceRoot: input.project.workspaceRoot,
      relativePath: input.relativePath,
      fileSystem: input.fileSystem,
      path: input.path,
    });
    if (!resolved.ok) {
      return { ok: false, error: resolved.reason };
    }

    const stat = yield* input.fileSystem
      .stat(resolved.absolutePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (stat === null || stat.type !== "File") {
      return { ok: false, error: `"${input.relativePath}" is not a readable file.` };
    }
    if (Number(stat.size) > MAX_SCAN_FILE_BYTES * 2) {
      return { ok: false, error: `"${input.relativePath}" is too large to read directly.` };
    }

    const rawText = yield* input.fileSystem
      .readFileString(resolved.absolutePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (rawText === null) {
      return { ok: false, error: `Could not read "${input.relativePath}".` };
    }

    const maxChars = Math.min(
      MAX_READ_MAX_CHARS,
      Math.max(MIN_READ_MAX_CHARS, Math.round(input.maxChars ?? DEFAULT_READ_MAX_CHARS)),
    );
    const truncated = rawText.length > maxChars;
    return {
      ok: true,
      result: {
        projectId: input.project.id,
        projectTitle: input.project.title,
        relativePath: resolved.normalizedRelativePath,
        content: truncated ? `${rawText.slice(0, maxChars)}…` : rawText,
        truncated,
      },
    };
  },
);

const collectSearchableFiles = Effect.fn("voiceWorkspaceSearch.collectSearchableFiles")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly maxFiles: number;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }): Effect.fn.Return<
    ReadonlyArray<{ readonly absolutePath: string; readonly relativePath: string }>
  > {
    const { path } = input;
    const resolvedRoot = path.resolve(input.workspaceRoot);
    const realRoot = yield* input.fileSystem
      .realPath(resolvedRoot)
      .pipe(Effect.orElseSucceed(() => resolvedRoot));
    const files: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [];

    const queue: Array<{ readonly dir: string; readonly depth: number }> = [
      { dir: realRoot, depth: 0 },
    ];

    // Prefer documentation and fork-specific folders first so quick searches hit them early.
    const preferredDirs = ["antimatter/research", "antimatter", "docs"];
    for (const rel of preferredDirs) {
      const candidate = path.join(realRoot, rel);
      const exists = yield* input.fileSystem
        .exists(candidate)
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        queue.unshift({ dir: candidate, depth: 1 });
      }
    }

    const visitedDirs = new Set<string>();

    while (queue.length > 0 && files.length < input.maxFiles) {
      const next = queue.shift();
      if (!next || next.depth > MAX_WALK_DEPTH) continue;
      const canonicalDir = yield* input.fileSystem
        .realPath(next.dir)
        .pipe(Effect.orElseSucceed(() => next.dir));
      if (visitedDirs.has(canonicalDir)) continue;
      if (canonicalDir !== realRoot && !isInsideRoot(path, realRoot, canonicalDir)) continue;
      visitedDirs.add(canonicalDir);

      const entries = yield* input.fileSystem
        .readDirectory(canonicalDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

      for (const name of entries) {
        if (files.length >= input.maxFiles) break;
        if (SKIPPED_DIRECTORY_NAMES.has(name)) continue;
        if (isSensitivePath(name)) continue;

        const fullPath = path.join(canonicalDir, name);
        const relPath = path.relative(realRoot, fullPath).replaceAll("\\", "/");
        if (isSensitivePath(relPath)) continue;

        const stat = yield* input.fileSystem.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
        if (stat === null) continue;

        if (stat.type === "Directory") {
          if (next.depth + 1 <= MAX_WALK_DEPTH) {
            queue.push({ dir: fullPath, depth: next.depth + 1 });
          }
          continue;
        }
        if (stat.type !== "File") continue;
        if (Number(stat.size) === 0 || Number(stat.size) > MAX_SCAN_FILE_BYTES) continue;

        const ext = path.extname(name).toLowerCase();
        if (!SEARCHABLE_EXTENSIONS.has(ext) && name.toLowerCase() !== "readme") continue;

        files.push({ absolutePath: fullPath, relativePath: relPath });
      }
    }

    return files;
  },
);

export const searchWorkspace = Effect.fn("voiceWorkspaceSearch.searchWorkspace")(function* (input: {
  readonly query: string;
  readonly depth: "quick" | "deep";
  readonly projects: ReadonlyArray<VoiceWorkspaceProjectSummary>;
  readonly projectTitleById: ReadonlyMap<string, string>;
  readonly threadManagement: Partial<
    Pick<
      ThreadManagementService.ThreadManagementService["Service"],
      "listProjectThreads" | "getThreadRecords" | "getThreadProjection"
    >
  >;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): Effect.fn.Return<WorkspaceSearchResult> {
  const queryLower = input.query.trim().toLowerCase();
  const tokens = tokenizeQuery(input.query);
  const maxThreadHits = input.depth === "deep" ? 8 : 4;
  const maxFileHits = input.depth === "deep" ? 10 : 5;
  const fileSnippetChars = input.depth === "deep" ? 1100 : 480;
  const maxFilesPerProject = input.depth === "deep" ? 600 : 250;
  const maxThreadsToInspect = input.depth === "deep" ? 30 : 15;

  const scoredThreadHits: Array<{
    readonly score: number;
    readonly hit: WorkspaceSearchThreadHit;
  }> = [];

  if (tokens.length > 0 && typeof input.threadManagement.listProjectThreads === "function") {
    const allowedProjectIds = new Set(input.projects.map((project) => project.id));
    const listed = yield* input.threadManagement
      .listProjectThreads({ includeSubagents: true })
      .pipe(Effect.orElseSucceed(() => []));
    const filtered = listed
      .filter((entry) => allowedProjectIds.size === 0 || allowedProjectIds.has(entry.projectId))
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      );

    // Prioritize title matches first, then most recent threads for message body scanning.
    const rankedCandidates = filtered
      .map((entry) => ({
        entry,
        titleScore: scoreTextMatch(entry.title, queryLower, tokens).score,
      }))
      .toSorted((left, right) => {
        if (left.titleScore !== right.titleScore) return right.titleScore - left.titleScore;
        return (
          DateTime.toEpochMillis(right.entry.updatedAt) -
          DateTime.toEpochMillis(left.entry.updatedAt)
        );
      })
      .slice(0, maxThreadsToInspect);

    const inspected = yield* Effect.forEach(
      rankedCandidates,
      ({ entry, titleScore }) =>
        Effect.gen(function* () {
          let messages: ReadonlyArray<{ readonly role: string; readonly text: string }> = [];
          if (typeof input.threadManagement.getThreadRecords === "function") {
            const records = yield* input.threadManagement
              .getThreadRecords(entry.id, ["messages"])
              .pipe(Effect.orElseSucceed(() => null));
            messages = records?.messages ?? [];
          } else if (typeof input.threadManagement.getThreadProjection === "function") {
            const proj = yield* input.threadManagement
              .getThreadProjection(entry.id)
              .pipe(Effect.orElseSucceed(() => null));
            messages = proj?.messages ?? [];
          }

          const matchedExcerpts: Array<{
            readonly score: number;
            readonly role: string;
            readonly text: string;
          }> = [];
          let bestMessageScore = 0;

          for (const message of messages.slice(-24)) {
            const match = scoreTextMatch(message.text, queryLower, tokens);
            if (match.score > 0) {
              bestMessageScore = Math.max(bestMessageScore, match.score);
              matchedExcerpts.push({
                score: match.score,
                role: message.role,
                text: extractBoundedExcerpt(
                  message.text,
                  match.firstOffset,
                  input.depth === "deep" ? 500 : 280,
                ),
              });
            }
          }

          const totalScore = titleScore * 2 + bestMessageScore;
          if (totalScore <= 0) return null;

          const excerpts =
            matchedExcerpts.length > 0
              ? matchedExcerpts
                  .toSorted((left, right) => right.score - left.score)
                  .slice(0, input.depth === "deep" ? 3 : 2)
                  .map(({ role, text }) => ({ role, text }))
              : messages.slice(-2).map((message) => ({
                  role: message.role,
                  text: extractBoundedExcerpt(message.text, 0, 260),
                }));

          return {
            score: totalScore,
            hit: {
              threadId: entry.id,
              title: entry.title,
              projectTitle: input.projectTitleById.get(entry.projectId) ?? null,
              updatedAt: DateTime.formatIso(entry.updatedAt),
              excerpts,
            } satisfies WorkspaceSearchThreadHit,
          };
        }),
      { concurrency: 6 },
    );

    for (const item of inspected) {
      if (item !== null) scoredThreadHits.push(item);
    }
  }

  const scoredFileHits: Array<{ readonly score: number; readonly hit: WorkspaceSearchFileHit }> =
    [];
  const projectsToSearch = input.projects.filter((project) => !project.archived).slice(0, 4);

  if (tokens.length > 0) {
    for (const project of projectsToSearch) {
      const files = yield* collectSearchableFiles({
        workspaceRoot: project.workspaceRoot,
        maxFiles: maxFilesPerProject,
        fileSystem: input.fileSystem,
        path: input.path,
      });

      const fileMatches = yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            const pathMatch = scoreTextMatch(file.relativePath, queryLower, tokens);
            const rawContent = yield* input.fileSystem
              .readFileString(file.absolutePath)
              .pipe(Effect.orElseSucceed(() => null));
            if (rawContent === null) return null;
            const bodyMatch = scoreTextMatch(rawContent, queryLower, tokens);
            const totalScore =
              pathMatch.score * 2 +
              bodyMatch.score +
              (pathMatch.score > 0 || bodyMatch.score > 0
                ? pathPriorityBonus(file.relativePath)
                : 0);
            if (totalScore <= 0) return null;
            return {
              score: totalScore,
              hit: {
                projectId: project.id,
                projectTitle: project.title,
                relativePath: file.relativePath,
                snippet: extractBoundedExcerpt(rawContent, bodyMatch.firstOffset, fileSnippetChars),
              } satisfies WorkspaceSearchFileHit,
            };
          }),
        { concurrency: 8 },
      );

      for (const match of fileMatches) {
        if (match !== null) scoredFileHits.push(match);
      }
    }
  }

  return {
    query: input.query,
    depth: input.depth,
    threadHits: scoredThreadHits
      .toSorted((left, right) => right.score - left.score)
      .slice(0, maxThreadHits)
      .map((entry) => entry.hit),
    fileHits: scoredFileHits
      .toSorted((left, right) => right.score - left.score)
      .slice(0, maxFileHits)
      .map((entry) => entry.hit),
  };
});
