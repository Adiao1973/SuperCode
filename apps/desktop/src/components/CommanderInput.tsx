import { InlineError, LoadingState } from "./FeedbackState";
import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  listAgentDefinitions,
  type AgentRow,
  type Workspace,
} from "@/lib/agent";
import {
  commanderCredentialSource,
  getCommanderConfig,
  pickCommanderDirectory,
  validateCommanderDirectory,
} from "@/lib/commander";

export function CommanderInput({
  active,
  currentCwd,
  currentAgent,
  workspaces,
  blocked,
  onSettings,
  onGenerate,
}: {
  active: boolean;
  currentCwd: string;
  currentAgent: string;
  workspaces: Workspace[];
  blocked: boolean;
  onSettings: () => void;
  onGenerate: (
    objective: string,
    cwd: string,
    agents: string[],
  ) => Promise<void>;
}) {
  const [objective, setObjective] = useState("");
  const [cwd, setCwd] = useState(currentCwd);
  const [edited, setEdited] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const initialized = useRef(false);
  const [model, setModel] = useState("正在读取模型配置…");
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const locked = useRef(false);
  const pickRevision = useRef(0);
  const mounted = useRef(true);
  const preferredAgent = useRef(currentAgent);
  preferredAgent.current = currentAgent;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pickRevision.current++;
    };
  }, []);
  useEffect(() => {
    if (!edited) setCwd(currentCwd);
  }, [currentCwd, edited]);
  useEffect(() => {
    if (!active) {
      pickRevision.current++;
      setPicking(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setReady(false);
    setError("");
    setModel("正在读取模型配置…");
    const configQuery = async () => {
      try {
        const config = await getCommanderConfig();
        const source = config
          ? await commanderCredentialSource(config)
          : "missing";
        if (!alive) return;
        setReady(!!config && source !== "missing");
        setModel(
          !config
            ? "尚未配置指挥官模型"
            : source === "missing"
              ? `${config.model} · 尚未保存密钥`
              : `${config.model} · 配置可用`,
        );
      } catch (e) {
        if (alive) {
          setModel("模型配置读取失败");
          setError(String(e));
        }
      }
    };
    const agentQuery = async () => {
      try {
        const rows = await listAgentDefinitions();
        if (!alive) return;
        setAgents(rows);
        const eligible = rows.filter((row) => row.driver_kind === "acp");
        if (!initialized.current) {
          initialized.current = true;
          const first =
            eligible.find((row) => row.id === preferredAgent.current) ??
            eligible[0];
          setSelected(first ? [first.id] : []);
        } else {
          setSelected((previous) =>
            previous.filter((id) => eligible.some((row) => row.id === id)),
          );
        }
      } catch (e) {
        if (alive) {
          setAgents([]);
          setSelected([]);
          setError((previous) =>
            [previous, `Agent 列表读取失败：${String(e)}`]
              .filter(Boolean)
              .join("；"),
          );
        }
      }
    };
    void Promise.all([configQuery(), agentQuery()]).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [active, refresh]);
  const changeCwd = (value: string) => {
    pickRevision.current++;
    setCwd(value);
    setEdited(true);
    setError("");
  };
  const choose = async () => {
    if (picking || submitting || blocked) return;
    const revision = ++pickRevision.current;
    setPicking(true);
    setError("");
    try {
      const path = await pickCommanderDirectory(cwd || undefined);
      if (
        mounted.current &&
        revision === pickRevision.current &&
        path != null
      ) {
        setCwd(path);
        setEdited(true);
      }
    } catch (e) {
      if (mounted.current && revision === pickRevision.current)
        setError(String(e));
    } finally {
      if (mounted.current && revision === pickRevision.current)
        setPicking(false);
    }
  };
  const allowed = agents
    .filter((row) => row.driver_kind === "acp" && selected.includes(row.id))
    .map((row) => row.id);
  const canSubmit =
    active &&
    ready &&
    !loading &&
    !blocked &&
    !submitting &&
    !picking &&
    !!objective.trim() &&
    !!cwd.trim() &&
    allowed.length > 0;
  const submit = async () => {
    if (!canSubmit || locked.current) return;
    locked.current = true;
    setSubmitting(true);
    setError("");
    try {
      await validateCommanderDirectory(cwd.trim());
      await onGenerate(objective.trim(), cwd.trim(), allowed);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      locked.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  const disabled = blocked || submitting || picking;
  return (
    <section aria-label="规划目标" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold">规划目标</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            描述目标，选择项目和 Agent，再生成计划供审阅。
          </p>
        </div>
        <Button variant="outline" onClick={onSettings}>
          模型设置
        </Button>
      </div>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        role="status"
      >
        <span className={ready ? "text-foreground" : "text-muted-foreground"}>
          {model}
        </span>
        <span className="text-muted-foreground">配置可用不代表推理已验证</span>
        <button
          type="button"
          className="text-primary hover:underline disabled:opacity-50"
          disabled={loading || disabled}
          onClick={() => setRefresh((n) => n + 1)}
        >
          刷新配置与 Agent
        </button>
      </div>
      {loading && <LoadingState label="正在读取模型与 Agent…" />}
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm font-medium">
          任务目标
          <textarea
            aria-label="任务目标"
            className="mt-2 min-h-32 w-full resize-y rounded-md border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            disabled={disabled}
            placeholder="说明要实现什么，以及必须遵守的约束"
          />
        </label>
        <fieldset disabled={disabled} className="min-w-0 space-y-2">
          <legend className="mb-2 text-sm font-medium">工作项目</legend>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="项目空间"
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              value={
                workspaces.find((w) => w.path === cwd && w.kind === "project")
                  ?.id ?? ""
              }
              onChange={(e) => {
                const path = workspaces.find(
                  (w) => w.id === e.target.value,
                )?.path;
                if (path) changeCwd(path);
              }}
            >
              <option value="">当前目录 / 自选目录</option>
              {workspaces
                .filter((w) => w.kind === "project" && w.path)
                .map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.name} · {w.path}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              variant="outline"
              disabled={!currentCwd}
              onClick={() => {
                pickRevision.current++;
                setEdited(false);
                setCwd(currentCwd);
                setError("");
              }}
            >
              使用当前项目
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <Input
              aria-label="工作目录"
              value={cwd}
              onChange={(e) => changeCwd(e.target.value)}
              placeholder="选择已存在的项目目录"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void choose()}
            >
              <FolderOpen className="size-4" />
              {picking ? "正在选择…" : "选择目录"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            使用已存在的绝对目录；选择项目仅用于本次规划。
          </p>
        </fieldset>
        <fieldset disabled={disabled || loading} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">参与规划的 Agent</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-6 gap-y-2">
            {agents.map((row) => (
              <label
                key={row.id}
                className={`flex items-start gap-2 py-1 text-sm ${row.driver_kind !== "acp" ? "text-muted-foreground" : ""}`}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  aria-label={`${row.display_name} (${row.id})`}
                  disabled={row.driver_kind !== "acp"}
                  checked={selected.includes(row.id)}
                  onChange={(e) =>
                    setSelected((previous) =>
                      e.target.checked
                        ? [...previous, row.id]
                        : previous.filter((id) => id !== row.id),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {row.display_name}
                  <span className="block break-all text-xs text-muted-foreground">
                    {row.id} ·{" "}
                    {row.driver_kind === "acp"
                      ? "ACP 已接入"
                      : "驱动尚未接入，暂不可选"}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {!loading && allowed.length === 0 && (
            <p className="text-sm text-muted-foreground">
              至少选择一个已接入的 Agent；可在设置管理注册条目。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            已接入不代表已安装或已登录；执行前仍会检查。此处不会启动 Agent
            或探测版本。
          </p>
        </fieldset>
        {error && <InlineError title="规划输入未就绪" message={error} onRetry={() => setRefresh((n) => n + 1)} retrying={loading || disabled} />}
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "正在生成…" : "生成计划"}
          </Button>
          <p className="text-xs text-muted-foreground">
            将调用指挥官模型；生成后先审阅，确认前不执行任务。
          </p>
        </div>
      </form>
    </section>
  );
}
