// Canonical data contracts (spec §2). Language-agnostic shared state that lets
// heterogeneous model families pick up each other's work mid-project.

export type TaskType = "code" | "document" | "analysis";

export interface BatonTask {
  id: number;
  title: string;
  targetArtifact: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  assignedProvider?: string;
  assignedModel?: string;
}

export type LogEvent = "plan" | "execute" | "failover" | "complete";

/** Tokens a provider call consumed. `estimated` when the provider didn't report usage. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

/** Aggregated usage also counts how many billed calls produced it. */
export interface UsageTotals extends TokenUsage {
  calls: number;
}

export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string;
}

/** Token totals for one run (or many): overall, per provider, and per model. */
export interface RunUsage {
  total: UsageTotals;
  byProvider: Record<string, UsageTotals>;
  /** Sorted by total tokens, largest first. */
  byModel: ModelUsage[];
}

export interface ExecutionLog {
  step: number;
  event: LogEvent;
  provider: string;
  model: string;
  message: string;
  timestamp: string;
  /** Tokens used by the call this entry describes (extension to the spec; omitted when no call was billed). */
  tokens?: TokenUsage;
}

/** Who wrote a file, so later steps (and the UI) can see where shared context came from. */
export interface ArtifactOrigin {
  provider: string;
  model: string;
  /** Run that wrote it (an earlier run, for files carried into a follow-up). */
  runId: string;
  step: number;
}

/** One file whose full text was included in a step's prompt. */
export interface ContextFile {
  path: string;
  /** "previous": carried over from the run being continued; "this-run": written earlier in this run. */
  source: "previous" | "this-run";
  /** "provider/model" that wrote it, when known. */
  by?: string;
  tokens: number;
}

/** Exactly what one planning or build step was given: Baton's shared context, made visible. */
export interface StepContext {
  step: number;
  kind: "plan" | "task";
  /** File this step writes (task steps). */
  target?: string;
  /** The target already existed (a follow-up rewriting a file). */
  targetExisted?: boolean;
  goal: string;
  /** Earlier requests in a follow-up chain, oldest first. */
  conversation: string[];
  decisions: Record<string, string | number | boolean>;
  /** Every file path the step was told about. */
  manifest: string[];
  /** Files whose full text was included. */
  files: ContextFile[];
  /** Estimated size of the whole prompt. */
  promptTokens: number;
  /** The exact messages sent (possibly truncated for storage). */
  messages: ChatMessage[];
}

export interface BatonWorkspace {
  workspaceId: string;
  userPrompt: string;
  taskType: TaskType;
  /** Follow-ups: the run this continues, and the earlier requests in the chain (oldest first). */
  parentId?: string;
  conversation?: string[];
  /** Who wrote each artifact. */
  artifactOrigins?: Record<string, ArtifactOrigin>;
  /** What each step was given (filled by planner and relay). */
  contexts?: StepContext[];
  metadata: {
    primaryLanguage?: string;
    framework?: string;
    tone?: string;
    [key: string]: string | number | boolean | undefined;
  };
  tasks: BatonTask[];
  artifacts: Record<string, string>;
  executionLogs: ExecutionLog[];
}

// ---- API contracts (spec §4) ----

export interface ProviderKeys {
  groqApiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  nvidiaApiKey?: string;
}

export interface OrchestrateRequest {
  userPrompt: string;
  taskType?: TaskType;
  keys: ProviderKeys;
  /** History id of a previous run: change that project instead of starting a new one. */
  continueFrom?: string;
}

export interface OrchestrateResponse {
  status: "success" | "partial" | "failed";
  workspaceId: string;
  /** Id of this run in the history store (same as workspaceId), if history is enabled. */
  historyId?: string;
  /** Set when this run continued an earlier one. */
  parentId?: string;
  /** Files changed vs. added by this run (follow-ups); for new projects everything is "added". */
  changes?: { modified: string[]; added: string[] };
  contexts?: StepContext[];
  artifactOrigins?: Record<string, ArtifactOrigin>;
  taskType: TaskType;
  summary: {
    totalTasks: number;
    completedTasks: number;
    artifactsGenerated: string[];
  };
  artifacts: Record<string, string>;
  executionLogs: ExecutionLog[];
  usage: RunUsage;
  downloadUrl: string;
}

export interface GatedResponse {
  status: "gated";
  kind: "chit_chat" | "command";
  match: string;
  response: string;
  historyId?: string;
}

// ---- Provider layer ----

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A fully-resolved endpoint the relay can dispatch to. */
export interface ProviderTarget {
  provider: string; // e.g. "groq", "google"
  /** Preferred model. */
  model: string;
  /** Tried in order if the provider reports `model` as gone (404 / "no longer available"). */
  fallbackModels?: string[];
  /** Filled in at runtime: models this provider has rejected as unavailable during the current run. */
  unavailableModels?: Set<string>;
  /** False for providers/models that reject a custom temperature (e.g. OpenAI GPT-5). Default true. */
  sendTemperature?: boolean;
  /** False for providers/models that reject `response_format: json_object`. Default true. */
  supportsJsonMode?: boolean;
  /** Preference order used to pick a model from the provider's live list when all configured models are retired. */
  modelHints?: Array<string | RegExp>;
  /** Filled in at runtime: model discovery already ran for this target in the current request. */
  discoveryTried?: boolean;
  baseUrl: string;
  apiKey: string;
}
