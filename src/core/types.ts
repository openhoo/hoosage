export interface Project {
  id: string;
  name: string;
  kind: "folder" | "workspace" | "cli" | "jetbrains" | "chat";
  folderCount: number;
  createdAt: number;
  /** sha256 of each normalized, lowercased workspace folder path.
   * Local-only attribution key for Copilot CLI sessions; never exported. */
  pathHashes?: string[];
  /** Case-preserving local folder hashes. Required for workspace-group
   * attribution on POSIX; never exported. Legacy pathHashes stay for migration. */
  exactPathHashes?: string[];
}

// This allowlist is the entire persisted/exported usage model. No prompts or code.
export interface UsageCall {
  id: string;
  projectId: string;
  timestamp: number;
  model: string;
  sessionId?: string;
  /** "chat" spans arrive via the OTLP collector; "cli"/"jetbrains" entries are
   * read from Copilot session-state files ("jetbrains" when workspace.yaml
   * marks the session as created by the JetBrains plugin); "chat-history"
   * entries are recovered from VS Code's own stored Chat transcripts and
   * summarize one Chat request (possibly several model calls). Absent = "chat". */
  source?: "chat" | "cli" | "jetbrains" | "chat-history";
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  nanoAiu?: number;
  /** This unpriced CLI interval is covered by another reported session-total
   * entry. Its individual cost remains unknown and is not estimated again. */
  costIncludedInSessionTotal?: true;
  /** Model requests this entry represents. CLI shutdown deltas aggregate many
   * requests into one entry; absent means 1. */
  requests?: number;
  durationMs?: number;
  failed: boolean;
}

/** Cache tokens are input subsets. Contradictory measurements stay unknown. */
export function validateCacheSubsets(
  value: Pick<UsageCall, "input" | "cacheRead" | "cacheWrite">,
): void {
  if (value.input === undefined) return;
  if (value.cacheRead !== undefined && value.cacheRead > value.input)
    value.cacheRead = undefined;
  if (value.cacheWrite !== undefined && value.cacheWrite > value.input)
    value.cacheWrite = undefined;
  if (
    value.cacheRead !== undefined &&
    value.cacheWrite !== undefined &&
    value.cacheWrite > value.input - value.cacheRead
  ) {
    value.cacheRead = undefined;
    value.cacheWrite = undefined;
  }
}

export type TrackingStatus =
  "off" | "waiting" | "active" | "blocked" | "reload";
export interface Snapshot {
  projects: Project[];
  calls: UsageCall[];
  currentProjectId?: string;
  status: TrackingStatus;
  statusDetail: string;
  canStopTracking?: boolean;
  updatedAt: number;
  skippedLines: number;
  errors: string[];
  /** True while stored usage is still being read; totals are not final yet. */
  indexing?: boolean;
  demo?: boolean;
}

export interface Totals {
  calls: number;
  missingRequests: number;
  input: number;
  output: number;
  tokens: number;
  cacheRead: number;
  sessions: number;
  missingUsage: number;
  failed: number;
  avgDurationMs: number;
}
