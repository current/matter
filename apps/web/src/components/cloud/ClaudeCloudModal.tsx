import {
  CLAUDE_CLOUD_ADDON_ID,
  type ClaudeCloudEligibility,
  type ProjectId,
  parseClaudeCloudSessionRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { CloudIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  type ClaudeCloudDialogMode,
  type ClaudeCloudDialogState,
  checkClaudeCloudEligibility,
  closeClaudeCloudDialog,
  settle,
  launchClaudeCloudSession,
  sendClaudeCloudFollowUp,
  teleportClaudeCloudSession,
  useClaudeCloudDialog,
} from "../../addons/claudeCloudApi";
import { useMatterApiConfig } from "../../addons/matterApi";
import { useIsAddonEnabled } from "../../addons/useAddonRegistry";
import { refreshClaudeCloudSessions } from "./claudeCloudStore";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Mounted once in the chat layout; renders nothing unless the add-on is on and the dialog open. */
export function ClaudeCloudModalHost() {
  const enabled = useIsAddonEnabled(CLAUDE_CLOUD_ADDON_ID);
  const dialog = useClaudeCloudDialog();
  if (!enabled || dialog === null) return null;
  // A new key per opening resets the form.
  return <ClaudeCloudModal key={`${dialog.mode}:${dialog.sessionId}`} dialog={dialog} />;
}

type Outcome =
  | { readonly kind: "replied"; readonly reply: string | null }
  | { readonly kind: "teleported"; readonly worktreePath: string };

function ClaudeCloudModal({ dialog }: { dialog: ClaudeCloudDialogState }) {
  const gt = useGT();
  const navigate = useNavigate();
  const config = useMatterApiConfig();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === primaryEnvironmentId &&
      project.isScratch !== true &&
      project.archivedAt == null,
  );
  const mode: ClaudeCloudDialogMode = dialog.mode;
  const [projectId, setProjectId] = useState<ProjectId | null>(
    dialog.projectId ?? projects[0]?.id ?? null,
  );
  const [sessionRef, setSessionRef] = useState(dialog.sessionId);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [pushFirst, setPushFirst] = useState(false);
  const [eligibility, setEligibility] = useState<ClaudeCloudEligibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server whether the chosen project can launch a cloud session
  useEffect(() => {
    if (mode !== "launch" || config === null || projectId === null) return;
    let cancelled = false;
    void checkClaudeCloudEligibility(config, { projectId })
      .then((next) => {
        if (!cancelled) setEligibility(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [config, mode, projectId]);

  const sessionId = parseClaudeCloudSessionRef(sessionRef);
  const unpushed = eligibility?.blockers.includes("unpushed_commits") === true;
  const hardBlockers = eligibility?.blockers.filter((blocker) => blocker !== "unpushed_commits");
  const canSubmit =
    config !== null &&
    !busy &&
    outcome === null &&
    (mode === "launch"
      ? projectId !== null && prompt.trim() !== "" && (hardBlockers?.length ?? 0) === 0
      : mode === "teleport"
        ? sessionId !== null && projectId !== null
        : sessionId !== null && prompt.trim() !== "");

  const submit = async () => {
    if (config === null || !canSubmit) return;
    setBusy(true);
    setError(null);
    const next = await settle(runSubmit());
    if (!next.ok) setError(next.error);
    else if (next.value !== null) setOutcome(next.value);
    setBusy(false);
  };

  const runSubmit = async (): Promise<Outcome | null> => {
    if (config === null) return null;
    if (mode === "launch" && projectId !== null) {
      const result = await launchClaudeCloudSession(config, {
        prompt: prompt.trim(),
        projectId,
        ...(title.trim() === "" ? {} : { title: title.trim() }),
        ...(pushFirst ? { pushFirst } : {}),
      });
      closeClaudeCloudDialog();
      refreshClaudeCloudSessions();
      await navigate({
        to: "/cloud/$sessionId",
        params: { sessionId: result.session.id },
        search: { instanceId: result.session.instanceId },
      });
      return null;
    }
    if (mode === "followup" && sessionId !== null) {
      const result = await sendClaudeCloudFollowUp(config, { sessionId, prompt: prompt.trim() });
      return { kind: "replied", reply: result.reply };
    }
    if (mode === "teleport" && sessionId !== null && projectId !== null) {
      const result = await teleportClaudeCloudSession(config, {
        sessionId,
        projectId,
        ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
      });
      if (result.threadId !== null && primaryEnvironmentId !== null) {
        closeClaudeCloudDialog();
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, result.threadId)),
        });
        return null;
      }
      return { kind: "teleported", worktreePath: result.worktreePath };
    }
    return null;
  };

  const titles: Record<ClaudeCloudDialogMode, string> = {
    launch: gt("Send to Claude Cloud"),
    teleport: gt("Teleport Claude Cloud session"),
    followup: gt("Send a follow-up to Claude Cloud"),
  };
  const descriptions: Record<ClaudeCloudDialogMode, string> = {
    launch: gt(
      "Runs the task in a Claude Cloud VM on your Claude plan, starting from the pushed branch.",
    ),
    teleport: gt(
      "Checks the session's branch out in a fresh worktree and opens it here as a thread.",
    ),
    followup: gt("Sends a message to a running Claude Cloud session."),
  };
  const selectedProject = projects.find((project) => project.id === projectId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeClaudeCloudDialog();
      }}
    >
      <DialogPopup className="max-w-xl" data-claude-cloud-dialog={mode}>
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <CloudIcon className="me-2 size-4" />
            {titles[mode]}
          </DialogTitle>
          <DialogDescription>{descriptions[mode]}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {mode === "launch" || mode === "teleport" ? (
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">
                  <T>Project</T>
                </span>
                <Select
                  value={projectId ?? ""}
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    setEligibility(null);
                    setProjectId(value as ProjectId);
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("Project")}>
                    <SelectValue>{selectedProject?.title ?? gt("Choose a project")}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            ) : null}

            {mode === "teleport" || mode === "followup" ? (
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">
                  <T>Session</T>
                </span>
                <Input
                  value={sessionRef}
                  placeholder="https://claude.ai/code/cse_…"
                  aria-invalid={sessionRef.trim() !== "" && sessionId === null}
                  onChange={(event) => setSessionRef(event.target.value)}
                />
              </label>
            ) : null}

            {mode === "launch" ? (
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">
                  <T>Title</T>
                </span>
                <Input
                  value={title}
                  placeholder={gt("Optional")}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            ) : null}

            <label className="grid gap-1.5">
              <span className="text-xs font-medium">
                {mode === "teleport" ? <T>First message (optional)</T> : <T>Message</T>}
              </span>
              <Textarea
                value={prompt}
                placeholder={
                  mode === "launch"
                    ? gt("Run the full test suite and fix any failures.")
                    : mode === "followup"
                      ? gt("How is it going?")
                      : gt("Summarize where this session left off.")
                }
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>

            {mode === "launch" && eligibility !== null ? (
              <EligibilityNotes
                eligibility={eligibility}
                pushFirst={pushFirst}
                onPushFirstChange={setPushFirst}
                unpushed={unpushed}
              />
            ) : null}

            {busy ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Spinner size="sm" />
                {mode === "launch" ? (
                  <T>Starting the cloud session…</T>
                ) : mode === "teleport" ? (
                  <T>Creating a worktree and teleporting…</T>
                ) : (
                  <T>Waiting for the cloud session to reply…</T>
                )}
              </div>
            ) : null}

            {outcome?.kind === "replied" ? (
              <div className="flex flex-col items-start gap-2" role="status">
                <p className="text-sm whitespace-pre-wrap">
                  {outcome.reply ?? gt("Sent. The session didn't reply yet.")}
                </p>
                {sessionId !== null ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      closeClaudeCloudDialog();
                      void navigate({ to: "/cloud/$sessionId", params: { sessionId } });
                    }}
                  >
                    <T>Open session</T>
                  </Button>
                ) : null}
              </div>
            ) : outcome?.kind === "teleported" ? (
              <p className="text-sm" role="status">
                {gt("Teleported into {path}. Its thread will appear once the session imports.", {
                  path: outcome.worktreePath,
                })}
              </p>
            ) : null}

            {error ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={closeClaudeCloudDialog}
          >
            {outcome === null ? gt("Cancel") : gt("Close")}
          </Button>
          {outcome === null ? (
            <Button type="button" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
              {mode === "launch"
                ? unpushed && pushFirst
                  ? gt("Push and launch")
                  : gt("Launch")
                : mode === "teleport"
                  ? gt("Teleport")
                  : gt("Send")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EligibilityNotes({
  eligibility,
  unpushed,
  pushFirst,
  onPushFirstChange,
}: {
  eligibility: ClaudeCloudEligibility;
  unpushed: boolean;
  pushFirst: boolean;
  onPushFirstChange: (next: boolean) => void;
}) {
  const gt = useGT();
  const repository = eligibility.repository;
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-claude-cloud-eligibility="">
      {eligibility.blockers.includes("account_not_ready") ? (
        <p className="text-destructive-foreground">
          {gt("{account} can't run cloud sessions: {detail}", {
            account: eligibility.account.displayName,
            detail: eligibility.account.detail ?? eligibility.account.problem ?? "",
          })}
        </p>
      ) : null}
      {eligibility.blockers.includes("no_github_remote") ? (
        <p className="text-destructive-foreground">
          <T>This repository has no GitHub origin remote, which Claude Cloud clones from.</T>
        </p>
      ) : null}
      {eligibility.blockers.includes("detached_head") ? (
        <p className="text-destructive-foreground">
          <T>Check out a branch first.</T>
        </p>
      ) : null}
      {unpushed ? (
        <label className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {repository?.hasUpstream
              ? gt(
                  "{count, plural, =1 {{branch} has 1 unpushed commit.} other {{branch} has {count} unpushed commits.}}",
                  { count: repository.aheadCount, branch: repository.branch ?? "" },
                )
              : gt("{branch} hasn't been pushed yet.", { branch: repository?.branch ?? "" })}
          </span>
          <span className="flex items-center gap-2">
            <T>Push first</T>
            <Switch
              size="sm"
              checked={pushFirst}
              onCheckedChange={(checked) => onPushFirstChange(Boolean(checked))}
              aria-label={gt("Push first")}
            />
          </span>
        </label>
      ) : null}
      {eligibility.warnings.length > 0 ? (
        <p className="text-muted-foreground">
          <T>
            Uncommitted changes stay on this Mac; the cloud session starts from the pushed branch.
          </T>
        </p>
      ) : null}
    </div>
  );
}
