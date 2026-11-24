// Workspace repository: in-memory by default, with a Redis adapter hook.

import type { BatonWorkspace } from "../types.js";

export const WORKSPACE_TTL_SECONDS = Number(process.env.BATON_WORKSPACE_TTL_SECONDS ?? 3600);

export interface WorkspaceStore {
  get(id: string): Promise<BatonWorkspace | undefined>;
  set(ws: BatonWorkspace): Promise<void>;
  delete(id: string): Promise<void>;
}

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly items = new Map<string, { ws: BatonWorkspace; expiresAt: number }>();

  constructor(
    private readonly ttlMs = WORKSPACE_TTL_SECONDS * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(id: string) {
    const hit = this.items.get(id);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.items.delete(id);
      return undefined;
    }
    return hit.ws;
  }

  async set(ws: BatonWorkspace) {
    this.sweep();
    this.items.set(ws.workspaceId, { ws, expiresAt: this.now() + this.ttlMs });
  }

  async delete(id: string) {
    this.items.delete(id);
  }

  private sweep() {
    const t = this.now();
    for (const [id, v] of this.items) if (v.expiresAt <= t) this.items.delete(id);
  }
}

/** Minimal subset of an ioredis / node-redis v4 client. Bring your own client. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisWorkspaceStore implements WorkspaceStore {
  constructor(
    private readonly client: RedisLike,
    private readonly ttlSeconds = WORKSPACE_TTL_SECONDS,
    private readonly prefix = "baton:ws:",
  ) {}

  async get(id: string) {
    const raw = await this.client.get(this.prefix + id);
    return raw ? (JSON.parse(raw) as BatonWorkspace) : undefined;
  }

  async set(ws: BatonWorkspace) {
    await this.client.set(this.prefix + ws.workspaceId, JSON.stringify(ws), "EX", this.ttlSeconds);
  }

  async delete(id: string) {
    await this.client.del(this.prefix + id);
  }
}
