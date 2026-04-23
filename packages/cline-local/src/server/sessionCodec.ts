import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const taskId =
      readNonEmptyString(record.taskId) ??
      readNonEmptyString(record.task_id) ??
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id);
    if (!taskId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    const branchName = readNonEmptyString(record.branchName) ?? readNonEmptyString(record.branch_name);
    const worktreePath = readNonEmptyString(record.worktreePath) ?? readNonEmptyString(record.worktree_path);
    const workspaceStrategy = readNonEmptyString(record.workspaceStrategy) ?? readNonEmptyString(record.workspace_strategy);
    return {
      taskId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(branchName ? { branchName } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(workspaceStrategy ? { workspaceStrategy } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const taskId =
      readNonEmptyString(params.taskId) ??
      readNonEmptyString(params.task_id) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id);
    if (!taskId) return null;
    const cwd = readNonEmptyString(params.cwd);
    const workspaceId = readNonEmptyString(params.workspaceId);
    const repoUrl = readNonEmptyString(params.repoUrl);
    const repoRef = readNonEmptyString(params.repoRef);
    const branchName = readNonEmptyString(params.branchName);
    const worktreePath = readNonEmptyString(params.worktreePath);
    const workspaceStrategy = readNonEmptyString(params.workspaceStrategy);
    return {
      taskId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
      ...(branchName ? { branchName } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(workspaceStrategy ? { workspaceStrategy } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return (
      readNonEmptyString(params.taskId) ??
      readNonEmptyString(params.task_id) ??
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.session_id)
    );
  },
};
