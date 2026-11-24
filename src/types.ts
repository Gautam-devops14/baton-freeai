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

/** Token totals for one run: overall and per provider. */
export interface RunUsage {
  total: TokenUsage;
  byProvider: Record<string, TokenUsage>;
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

export interface BatonWorkspace {
  workspaceId: string;
  userPrompt: string;
  taskType: TaskType;
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
}

export interface OrchestrateResponse {
  status: "success" | "partial" | "failed";
  workspaceId: string;
  /** Id of this run in the history store (same as workspaceId), if history is enabled. */
  historyId?: string;
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
