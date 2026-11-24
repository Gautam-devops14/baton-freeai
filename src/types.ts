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

export interface ExecutionLog {
  step: number;
  event: LogEvent;
  provider: string;
  model: string;
  message: string;
  timestamp: string;
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
}

export interface OrchestrateRequest {
  userPrompt: string;
  taskType?: TaskType;
  keys: ProviderKeys;
}

export interface OrchestrateResponse {
  status: "success" | "partial" | "failed";
  workspaceId: string;
  taskType: TaskType;
  summary: {
    totalTasks: number;
    completedTasks: number;
    artifactsGenerated: string[];
  };
  artifacts: Record<string, string>;
  executionLogs: ExecutionLog[];
  downloadUrl: string;
}

export interface GatedResponse {
  status: "gated";
  kind: "chit_chat" | "command";
  match: string;
  response: string;
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
  baseUrl: string;
  apiKey: string;
}
