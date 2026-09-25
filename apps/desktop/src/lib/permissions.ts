/**
 * 审批中心状态（P1-5）：待决请求 + 裁决留痕。
 * 数据经 Tauri 全局事件到达（permission-request / decision-record，§5.1）；
 * 前端只做登记与清除，应答走 respond_permission。
 */
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
  request: PermissionRequest;
}

export interface DecisionRecord {
  request: PermissionRequest;
  source:
    | { type: "rule"; pattern: string; effect: "allow" | "deny" | "ask" }
    | { type: "mode"; mode: string }
    | { type: "user" };
  decision: { option_id: string; updated_input: unknown };
}

type Listener<T> = (item: T) => void;

class PermissionCenter {
  pending: PendingPermission[] = [];
  decisions: DecisionRecord[] = [];
  private pendingListeners = new Set<Listener<PendingPermission[]>>();
  private decisionListeners = new Set<Listener<DecisionRecord[]>>();
  private pendingAddedListeners = new Set<Listener<PendingPermission>>();
  private decisionArrivedListeners = new Set<Listener<DecisionRecord>>();
  private unlisteners: Array<Promise<UnlistenFn>> = [];

  /** 在应用启动时调用一次；幂等 */
  async setup(): Promise<void> {
    if (this.unlisteners.length > 0) {
      return;
    }
    this.unlisteners.push(
      listen<PendingPermission>("permission-request", (event) => {
        this.pending = [...this.pending, event.payload];
        this.notifyPending();
        for (const listener of this.pendingAddedListeners) {
          listener(event.payload);
        }
      }),
      listen<DecisionRecord>("decision-record", (event) => {
        // 待决应答/自动裁决后从队列移除对应项
        this.pending = this.pending.filter(
          (p) => p.request.tool_call_id !== event.payload.request.tool_call_id,
        );
        this.decisions = [event.payload, ...this.decisions].slice(0, 50);
        this.notifyPending();
        this.notifyDecisions();
        for (const listener of this.decisionArrivedListeners) {
          listener(event.payload);
        }
      }),
    );
    await Promise.all(this.unlisteners);
  }

  removePending(id: string): void {
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
