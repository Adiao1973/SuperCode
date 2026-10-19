/**
 * 审批中心状态（P1-5）：待决请求 + 裁决留痕。
 * 数据经 Tauri 全局事件到达（permission-request / decision-record，§5.1）；
 * 前端只做登记与清除，应答走 respond_permission。
 */
import { respondPermission } from "./agent";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PermissionOption {
  option_id: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequest {
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  /** 工具类别（ACP ToolKind：edit/execute/read/...） */
  kind?: string | null;
  raw_input: unknown;
  options: PermissionOption[];
}

export interface PendingPermission {
  /** Uuid（Rust 侧字符串序列化） */
  id: string;
  local_session_id?: string;
  agent_id?: string;
  cwd?: string;
  session_title?: string;
  task_title?: string;
  plan_objective?: string;
  commander_run_id?: string;
  commander_task_id?: string;
  request: PermissionRequest;
}

export interface DecisionRecord {
  context?: PendingPermission;
  request_id?: string;
  request: PermissionRequest;
  source:
    | { type: "rule"; pattern: string; effect: "allow" | "deny" | "ask" }
    | { type: "mode"; mode: string }
    | { type: "user" };
  decision: { option_id: string; updated_input: unknown };
}

type Listener<T> = (item: T) => void;

export type ResponseState = { status: "idle" | "submitting" | "accepted" | "error"; error?: string };
const IDLE: ResponseState = { status: "idle" };

export class PermissionCenter {
  private responses = new Map<string, ResponseState>();
  private responseListeners = new Set<() => void>();
  subscribeResponses = (listener: () => void): (() => void) => {
    this.responseListeners.add(listener);
    return () => { this.responseListeners.delete(listener); };
  };
  response(id: string): ResponseState { return this.responses.get(id) ?? IDLE; }
  private notifyResponses() { for (const listener of this.responseListeners) listener(); }
  async respond(pending: PendingPermission, optionId: string): Promise<void> {
    const current = this.response(pending.id);
    if (current.status === "submitting" || current.status === "accepted") return;
    if (!pending.request.options.some((option) => option.option_id === optionId && option.kind.endsWith("_once"))) return;
    const state: ResponseState = { status: "submitting" };
    this.responses.set(pending.id, state);
    this.notifyResponses();
    try {
      await respondPermission(pending.id, optionId);
      if (this.responses.get(pending.id) === state) this.responses.set(pending.id, { status: "accepted" });
    } catch (error) {
      if (this.responses.get(pending.id) === state) this.responses.set(pending.id, { status: "error", error: String(error) });
    } finally { this.notifyResponses(); }
  }

  pending: PendingPermission[] = [];
  decisions: DecisionRecord[] = [];
  private pendingListeners = new Set<Listener<PendingPermission[]>>();
  private decisionListeners = new Set<Listener<DecisionRecord[]>>();
  private pendingAddedListeners = new Set<Listener<PendingPermission>>();
  private decisionArrivedListeners = new Set<Listener<DecisionRecord>>();
  private unlisteners: Array<Promise<UnlistenFn>> = [];

  private setupPromise: Promise<void> | null = null;

  /** 在应用启动时调用一次；幂等；失败清理部分监听，可显式重试 */
  async setup(): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    this.unlisteners.push(
      listen<PendingPermission>("permission-request", (event) => {
        if (this.pending.some((item) => item.id === event.payload.id)) return;
        this.pending = [...this.pending, event.payload];
        this.notifyPending();
        for (const listener of this.pendingAddedListeners) {
          listener(event.payload);
        }
      }),
      listen<{ ids: string[] }>("permission-removed", (event) => {
        for (const id of event.payload.ids) this.removePending(id);
      }),
      listen<DecisionRecord>("decision-record", (event) => {
        // 待决应答/自动裁决后从队列移除对应项
        const matches = (item: PendingPermission) => event.payload.request_id
          ? item.id === event.payload.request_id
          : event.payload.source.type === "user" && item.request.session_id === event.payload.request.session_id && item.request.tool_call_id === event.payload.request.tool_call_id;
        const context = this.pending.find(matches);
        const removed = this.pending.filter(matches);
        for (const item of removed) this.responses.delete(item.id);
        this.pending = this.pending.filter((item) => !removed.includes(item));
        this.notifyResponses();
        this.decisions = [{ ...event.payload, context }, ...this.decisions].slice(0, 50);
        this.notifyPending();
        this.notifyDecisions();
        for (const listener of this.decisionArrivedListeners) {
          listener(event.payload);
        }
      }),
    );
    const pending = this.unlisteners;
    this.setupPromise = Promise.all(pending).then(() => {}).catch(async (error: unknown) => {
      const settled = await Promise.allSettled(pending);
      for (const item of settled) if (item.status === "fulfilled") { try { item.value(); } catch { /* transport may already be closed */ } }
      this.unlisteners = []; this.setupPromise = null;
      throw error;
    });
    return this.setupPromise;
  }

  removePending(id: string): void {
    this.responses.delete(id);
    this.notifyResponses();
    this.pending = this.pending.filter((p) => p.id !== id);
    this.notifyPending();
  }

  onPending(listener: Listener<PendingPermission[]>): () => void {
    this.pendingListeners.add(listener);
    listener(this.pending);
    return () => this.pendingListeners.delete(listener);
  }

  /** 单条钩子：会话内联审批按 ACP session id 路由用（P1-5） */
  onPendingAdded(listener: Listener<PendingPermission>): () => void {
    this.pendingAddedListeners.add(listener);
    return () => this.pendingAddedListeners.delete(listener);
  }

  /** 单条钩子：裁决到达（自动或用户应答）即通知 */
  onDecisionArrived(listener: Listener<DecisionRecord>): () => void {
    this.decisionArrivedListeners.add(listener);
    return () => this.decisionArrivedListeners.delete(listener);
  }

  onDecisions(listener: Listener<DecisionRecord[]>): () => void {
    this.decisionListeners.add(listener);
    listener(this.decisions);
    return () => this.decisionListeners.delete(listener);
  }

  private notifyPending(): void {
    for (const listener of this.pendingListeners) {
      listener(this.pending);
    }
  }

  private notifyDecisions(): void {
    for (const listener of this.decisionListeners) {
      listener(this.decisions);
    }
  }
}

export const permissionCenter = new PermissionCenter();
