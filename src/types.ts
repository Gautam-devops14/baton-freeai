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
  /** Earlier files this file must match (from the plan). Only these are sent in full; the rest as outlines. */
  uses?: string[];
}

export type LogEvent = "plan" | "execute" | "failover" | "complete";

/** Tokens a provider call consumed. `estimated` when the provider didn't report usage. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
  /** Hidden "thinking" tokens inside completionTokens, when the provider reports them (or estimated from reasoning text). */
  reasoningTokens?: number;
  reasoningEstimated?: boolean;
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

/**
 * Where tokens went, by purpose. Input-side categories (instructions, request,
 * context) split the provider-reported input total by each prompt section's
 * share of the text, so they're estimates; output and thinking are measured.
 */
export interface TokenBreakdown {
  /** Planning calls: reading the request and deciding the files (input + output). */
  understanding: number;
  /** Baton's fixed rules and the assignment text in build prompts. */
  instructions: number;
  /** The user's goal and earlier requests in build prompts. */
  request: number;
  /** Decisions, file list and the full text of files shared from earlier steps. */
  context: number;
  /** The file content the model wrote (what ends up in the project). */
  code: number;
  /** Other reply text: explanations, code fences, chatter around the file. */
  otherText: number;
  /** Hidden reasoning tokens (reported by the provider, or estimated from reasoning text). */
  thinking: number;
  /** Replies Baton couldn't use (e.g. an unusable plan). */
  wasted: number;
}

/** One HTTP call to a provider (debug view). "start" is emitted live; "end" is stored. */
export interface CallTrace {
  /** "start" and "progress" are streamed live; only "end" is stored. */
  phase: "start" | "progress" | "end";
  /** Characters of reply received so far ("progress" events). */
  chars?: number;
  at: string;
  provider: string;
  model: string;
  host: string;
  /** Run and step that made the call, when known. */
  runId?: string;
  step?: number;
  status?: number;
  /** "ok", or the error kind (rate_limit, overloaded, model_unavailable, timeout...). */
  outcome?: string;
  latencyMs?: number;
  tokens?: TokenUsage;
  detail?: string;
  /** The model's raw reply (successful calls; stored on the run, not streamed or listed in /api/debug). */
  reply?: string;
  /** How this call's tokens split by purpose (successful calls). */
  breakdown?: TokenBreakdown;
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
  /** "full": whole file sent; "outline": only names/ids/selectors (to save tokens). */
  mode?: "full" | "outline";
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
  /** Every provider call made for this run (debug view). */
  calls?: CallTrace[];
  /** Chat (conversation thread) this run belongs to. */
  chatId?: string;
  /** Set when the message was a question the planner answered directly (no build). */
  answer?: string;
  /** Live progress sink (not persisted). */
  emit?: (event: ProgressEvent) => void;
  /** Aborted when the user presses Stop or disconnects (not persisted). */
  signal?: AbortSignal;
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
  openrouterApiKey?: string;
}

/** Live progress events streamed to the browser while a run is in flight. */
export type ProgressEvent =
  | { type: "start"; runId: string; chatId?: string; followUpOf?: string }
  | { type: "log"; entry: ExecutionLog }
  | { type: "call"; call: CallTrace }
  /** Live countdown while Baton backs off before retrying every provider. */
  | { type: "wait"; step: number; secondsLeft: number; label: string }
  | { type: "plan"; tasks: Array<{ id: number; targetArtifact: string; title: string }> }
  | { type: "done"; status: string; historyId?: string; message?: string };

export interface OrchestrateRequest {
  userPrompt: string;
  taskType?: TaskType;
  keys: ProviderKeys;
  /** History id of a previous run: change that project instead of starting a new one. */
  continueFrom?: string;
  /** Chat thread to file this run under (UI). Follow-ups inherit their parent's chat. */
  chatId?: string;
  /** Random id chosen by the browser so it can subscribe to live progress before the run starts. */
  clientRunId?: string;
  /** Providers to use, in order (planning and building). Unlisted providers are not used. */
  providerOrder?: string[];
  /** History id of a run that stopped part-way: build its unfinished files with the same plan (no new planning call). */
  resumeFrom?: string;
}

export interface OrchestrateResponse {
  /** "answered": the message was a question; see `answer`. No files were built. */
  /** "stopped": the user pressed Stop; files finished before that are kept. */
  status: "success" | "partial" | "failed" | "answered" | "stopped";
  answer?: string;
  /** Short note, e.g. "Stopped by you." */
  message?: string;
  workspaceId: string;
  /** Id of this run in the history store (same as workspaceId), if history is enabled. */
  historyId?: string;
  /** Set when this run continued an earlier one. */
  parentId?: string;
  /** Files changed vs. added by this run (follow-ups); for new projects everything is "added". */
  changes?: { modified: string[]; added: string[] };
  contexts?: StepContext[];
  artifactOrigins?: Record<string, ArtifactOrigin>;
  chatId?: string;
  calls?: CallTrace[];
  /** Where this run's tokens went, by purpose. */
  breakdown?: TokenBreakdown;
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
  /** False for providers that don't support stream_options.include_usage (tokens are then estimated). */
  streamUsage?: boolean;
  /** False for providers/models that reject `response_format: json_object`. Default true. */
  supportsJsonMode?: boolean;
  /** Preference order used to pick a model from the provider's live list when all configured models are retired. */
  modelHints?: Array<string | RegExp>;
  /** Discovery may only pick model IDs matching this (e.g. OpenRouter ":free" models). */
  modelFilter?: RegExp;
  /** Extra non-secret request headers. */
  extraHeaders?: Record<string, string>;
  /** Filled in at runtime: model discovery already ran for this target in the current request. */
  discoveryTried?: boolean;
  baseUrl: string;
  apiKey: string;
}
