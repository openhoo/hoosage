export interface Project {
  id: string;
  name: string;
  kind: "folder" | "workspace" | "cli" | "jetbrains";
  folderCount: number;
  createdAt: number;
  /** sha256 of each normalized, lowercased workspace folder path.
   * Local-only attribution key for Copilot CLI sessions; never exported. */
  pathHashes?: string[];
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
   * marks the session as created by the JetBrains plugin). Absent = "chat". */
  source?: "chat" | "cli" | "jetbrains";
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  nanoAiu?: number;
  /** Model requests this entry represents. CLI shutdown deltas aggregate many
   * requests into one entry; absent means 1. */
  requests?: number;
  durationMs?: number;
  failed: boolean;
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
