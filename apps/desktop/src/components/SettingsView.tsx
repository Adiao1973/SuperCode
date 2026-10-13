/**
 * 设置（P1-5）：规则库管理——全局持久的预授权规则（SQLite permission_rules 表）。
 * 规则三形：`*`、`tool`、`tool(args)`（glob）；效果 allow / deny / ask。
 */
import { useCallback, useEffect, useState, useRef } from "react";
import { ProjectSettings } from "@/components/ProjectSettings";
import { MotionSettings } from "@/components/MotionSettings";
import { AppearanceSettings } from "@/components/AppearanceSettings";
import { CommanderSettings } from "@/components/CommanderSettings";
import { AgentsSection } from "@/components/AgentsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OpencodeEnvSection } from "@/components/OpencodeEnvSection";
import { addRule, deleteRule, listRules, type RuleEntry, type Workspace } from "@/lib/agent";
import { Plus, Trash2 } from "lucide-react";

const EFFECT_LABEL: Record<RuleEntry["effect"], { label: string; className: string }> = {
  allow: { label: "放行", className: "border-emerald-500/50 text-success" },
  deny: { label: "拒绝", className: "border-destructive/50 text-destructive" },
  ask: { label: "询问", className: "border-amber-500/50 text-warning" },
};

export function SettingsView({ onWorkspacesChanged }: { onWorkspacesChanged?: (rows: Workspace[]) => void }) {
  const [group, setGroup] = useState("model");
  const content = useRef<HTMLDivElement>(null);
  const [rules, setRules] = useState<RuleEntry[]>([]);
  const [pattern, setPattern] = useState("");
  const [effect, setEffect] = useState<RuleEntry["effect"]>("allow");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRules(await listRules());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(async () => {
    if (!pattern.trim()) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await addRule(pattern.trim(), effect);
      setPattern("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [pattern, effect, refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteRule(id);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  return (
    <div className="min-h-0 flex flex-1 flex-col">
      <div className="shrink-0 border-b px-5 py-3"><nav aria-label="设置分组" className="mx-auto flex max-w-3xl flex-wrap gap-1">
          {[["model", "模型"], ["agents", "Agent 与项目"], ["rules", "规则"], ["appearance", "外观"]].map(([id, label]) => <Button key={id} variant={group === id ? "secondary" : "ghost"} aria-current={group === id ? "page" : undefined} onClick={() => { setGroup(id); if (content.current) content.current.scrollTop = 0; }}>{label}</Button>)}
        </nav></div>
      <div ref={content} className="min-h-0 flex-1 overflow-y-auto px-5 py-5"><div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div role="region" aria-label="模型设置" hidden={group !== "model"}><CommanderSettings /></div>
        <div role="region" aria-label="Agent 与项目设置" hidden={group !== "agents"} className="space-y-6"><ProjectSettings onSaved={onWorkspacesChanged} /><AgentsSection /><OpencodeEnvSection /></div>
        <div role="region" aria-label="外观设置" hidden={group !== "appearance"} className="space-y-6"><AppearanceSettings /><MotionSettings /></div>
        {group === "rules" && <div role="region" aria-label="规则设置" className="space-y-6">
        <div><h2 className="text-base font-semibold">审批规则</h2><p className="mt-1 text-xs text-muted-foreground">规则影响所有会话，仅裁决 Agent 主动询问的操作。</p></div>

        <section>
          <h2 className="mb-2 text-sm font-medium">新增规则</h2>
          <div className="flex gap-2">
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              aria-label="规则匹配式"
              placeholder="规则：* / write / bash(git *)（三形，通配 * 与 ?）"
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <select
              aria-label="规则效果"
              value={effect}
              onChange={(e) => setEffect(e.target.value as RuleEntry["effect"])}
              className="h-9 shrink-0 rounded-md border px-2 font-mono text-xs"
            >
              <option value="allow">放行</option>
              <option value="deny">拒绝</option>
              <option value="ask">询问</option>
            </select>
            <Button size="sm" onClick={() => void submit()} disabled={loading || !pattern.trim()}>
              <Plus className="size-4" />
              添加
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-[11px]">
            求值顺序 deny &gt; ask &gt; allow；规则对所有会话生效，随 SQLite 持久化（重启保留）。
            {error && <span className="text-destructive"> · {error}</span>}
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium">规则库（{rules.length}）</h2>
          {rules.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-sm">
              规则库为空——所有未匹配请求按会话权限模式兜底
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  <Badge
                    variant="outline"
                    className={`w-14 justify-center text-[10px] ${EFFECT_LABEL[rule.effect].className}`}
                  >
                    {EFFECT_LABEL[rule.effect].label}
                  </Badge>
                  <code className="min-w-0 flex-1 truncate text-xs">{rule.pattern}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive h-7 px-2"
                    onClick={() => void remove(rule.id)}
                    title="删除规则"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
        </div>}
      </div></div>
    </div>
  );
}
