import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCommanderConfig, saveCommanderConfig, type CommanderConfig } from "@/lib/commander";

const EMPTY_CONFIG: CommanderConfig = {
  endpoint: "", model: "", api_key_env: "SUPERCODE_LLM_API_KEY", timeout_secs: 60,
};

export function CommanderSettings() {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getCommanderConfig().then((value) => {
      if (active && value) { setConfig(value); setSaved(true); }
    }).catch((e: unknown) => { if (active) setError(String(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  function change<K extends keyof CommanderConfig>(field: K, value: CommanderConfig[K]) {
    setConfig((previous) => ({ ...previous, [field]: value })); setSaved(false); setError(null);
  }
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await saveCommanderConfig(config); setSaved(true); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className="rounded-md border p-4">
      <h2 className="mb-1 text-sm font-medium">指挥官模型</h2>
      <p className="text-muted-foreground mb-4 text-xs">
        将目标拆解为任务计划，独立于执行任务的 Agent。支持兼容 Chat Completions 的接口，可稍后填写 MiMo 连接信息。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">API endpoint（完整对话补全地址）
          <Input aria-label="指挥官 API endpoint" className="mt-1 font-mono text-xs" value={config.endpoint} disabled={busy}
            placeholder="https://api.example.com/v1/chat/completions" onChange={(e) => change("endpoint", e.target.value)} />
        </label>
        <label className="text-xs">模型名
          <Input aria-label="指挥官模型名" className="mt-1 font-mono text-xs" value={config.model} disabled={busy}
            placeholder="填写服务商的模型 ID" onChange={(e) => change("model", e.target.value)} />
        </label>
        <label className="text-xs">Key 环境变量名
          <Input aria-label="指挥官 Key 环境变量名" className="mt-1 font-mono text-xs" value={config.api_key_env} disabled={busy}
            onChange={(e) => change("api_key_env", e.target.value)} />
        </label>
        <label className="text-xs">请求超时（秒）
          <Input aria-label="指挥官请求超时" type="number" min={1} max={300} className="mt-1 text-xs" value={config.timeout_secs} disabled={busy}
            onChange={(e) => change("timeout_secs", Number(e.target.value))} />
        </label>
      </div>
      <p className="text-muted-foreground my-3 text-xs">
        连接设置只保存到本机 SQLite，不上传 GitHub。此处填写环境变量名称，不填写 key 本身；生成计划时从该变量读取 key。
      </p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy || !config.endpoint.trim() || !config.model.trim() || !config.api_key_env.trim()} onClick={() => void save()}>
          {busy ? "处理中…" : "保存指挥官配置"}
        </Button>
        <span role="status" className="text-muted-foreground text-xs">{saved ? "已保存到本机" : "尚未保存"}</span>
      </div>
      {error && <p role="alert" className="text-destructive mt-2 text-xs">{error}</p>}
    </section>
  );
}
