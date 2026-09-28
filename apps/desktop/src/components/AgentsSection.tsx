/**
 * 设置页「Agent 管理」区块（P2-2）：注册表合并视图 + 安装徽标 + 自定义 CRUD + 安装引导。
 * 用户自定义写入 ~/.supercode/agents.json（覆盖内置同 id = 用户覆盖语义，删除即恢复出厂）。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyableBlock } from "@/components/CopyableBlock";
import {
  addAgent,
  deleteAgent,
  listAgents,
  type AgentInput,
  type AgentRow,
} from "@/lib/agent";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

/** 内置 agent 的可复制安装命令（自定义条目兜底提示 PATH） */
const INSTALL_COMMANDS: Record<string, string> = {
  opencode: "curl -fsSL https://opencode.ai/install | bash",
  "claude-code": "npm i -g @agentclientprotocol/claude-agent-acp   # 需 Node/npx",
  codex: "npm i -g @agentclientprotocol/codex-acp   # 需 Node/npx",
  mimo: "# 见 MiMo Code 官方安装说明（需本机 mimo 可执行文件）",
  // ZCode 桌面版自带 CLI（zcode.cjs）但不注册 PATH 命令——软链后探测与 spawn 才可见
  zcode: `# ZCode.app 已装但 CLI 未进 PATH，执行以下命令后点「刷新」：
mkdir -p ~/.local/bin && \\
  ln -sf "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" ~/.local/bin/zcode
# （若无 ZCode.app：见 ZCode 官方安装说明）`,
};

const DRIVER_LABEL: Record<AgentRow["driver_kind"], string> = {
  acp: "ACP",
  stream_json: "StreamJson",
  native: "Native",
};

function installHint(agent: AgentRow): string {
  return (
    INSTALL_COMMANDS[agent.id] ??
    `# 确保 PATH 中存在 \`{agent.command.split(/\s+/)[0]}\``
  );
}

const emptyForm: AgentInput = {
  id: "",
  displayName: "",
  driverKind: "acp",
  command: "",
  versionArgs: [],
  supportsLoadSession: true,
  supportsDiff: true,
  supportsPermission: true,
};

export function AgentsSection() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<AgentInput>(emptyForm);
  const [versionArgsText, setVersionArgsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setAgents(await listAgents());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(async () => {
    const id = form.id.trim();
    if (!/^[a-z0-9-]+$/.test(id) || !form.command.trim()) {
      setError(
        !form.command.trim()
          ? "command 不能为空"
          : "id 须为 [a-z0-9-]+（小写字母、数字、连字符）",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const versionArgs = versionArgsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await addAgent({
        ...form,
        id,
        displayName: form.displayName.trim() || id,
        command: form.command.trim(),
        versionArgs,
      });
      setForm(emptyForm);
      setVersionArgsText("");
      setShowForm(false);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [form, versionArgsText, refresh]);

  const remove = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteAgent(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">Agent 管理</h2>
        <Badge variant="outline" className="text-muted-foreground text-[10px]">
          {agents.length}
        </Badge>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground h-6 px-2"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          刷新
        </Button>
        <Button size="sm" variant="outline" className="h-6 gap-1 px-2" onClick={() => setShowForm((v) => !v)}>
          <Plus className="size-3" />
          新增
        </Button>
      </div>

      {showForm && (
        <div className="mb-3 flex flex-col gap-2 rounded-md border p-3">
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="id（[a-z0-9-]+，如 my-agent）"
              className="font-mono text-xs"
            />
            <Input
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="显示名（缺省用 id）"
              className="text-xs"
            />
          </div>
          <Input
            value={form.command}
            onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
            placeholder="spawn 命令，如 my-agent --acp"
            className="font-mono text-xs"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={versionArgsText}
              onChange={(e) => setVersionArgsText(e.target.value)}
              placeholder="version_args 逗号分隔（缺省 --version）"
              className="font-mono text-xs"
            />
            <select
              value={form.driverKind}
              onChange={(e) =>
                setForm((f) => ({ ...f, driverKind: e.target.value as AgentInput["driverKind"] }))
              }
              className="h-9 rounded-md border px-2 font-mono text-xs"
            >
              <option value="acp">ACP</option>
              <option value="stream_json">StreamJson</option>
              <option value="native">Native</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-3 text-[11px]">
            {(
              [
                ["supportsLoadSession", "支持续聊"],
                ["supportsDiff", "支持 diff"],
                ["supportsPermission", "可外部审批"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={
                submitting ||
                !/^[a-z0-9-]+$/.test(form.id.trim()) ||
                !form.command.trim()
              }
            >
              {submitting && <Loader2 className="size-3 animate-spin" />}
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {agents.map((agent) => (
          <div key={agent.id} className="rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{agent.display_name}</span>
              <code className="text-muted-foreground font-mono text-[11px]">{agent.id}</code>
              <Badge variant="outline" className="text-muted-foreground text-[10px]">
                {DRIVER_LABEL[agent.driver_kind]}
              </Badge>
              {agent.installed_version ? (
                <Badge variant="outline" className="border-emerald-500/50 text-emerald-500 text-[10px]">
                  ✓ {agent.installed_version}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-amber-500/50 text-amber-500 text-[10px]">
                  — 未安装
                </Badge>
              )}
              {agent.is_user_defined && (
                <Badge variant="outline" className="border-indigo-500/50 text-indigo-500 text-[10px]">
                  自定义
                </Badge>
              )}
              <div className="flex-1" />
              {agent.is_user_defined && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive h-6 px-2"
                  onClick={() => void remove(agent.id)}
                >
                  <Trash2 className="size-3" />
                  删除
                </Button>
              )}
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">{agent.command}</p>
            {!agent.installed_version && (
              <div className="mt-2">
                <CopyableBlock text={installHint(agent)} label="安装指引（可复制）" />
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="text-muted-foreground mt-2 text-[11px]">
        内置条目只读；自定义写入 ~/.supercode/agents.json（重启保留）。同 id 覆盖内置，删除后恢复出厂。
        {error && <span className="text-destructive"> · {error}</span>}
      </p>
    </section>
  );
}
