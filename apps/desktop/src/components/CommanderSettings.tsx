import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCommanderConfig, saveCommanderConfig, listCommanderModels, type CommanderConfig } from "@/lib/commander";

const EMPTY_CONFIG: CommanderConfig = {
  endpoint: "", model: "", api_key_env: "SUPERCODE_LLM_API_KEY", timeout_secs: 60,
};

export function CommanderSettings() {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [busy, setBusy] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const [savedModel, setSavedModel] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getCommanderConfig().then((value) => {
      if (active && value) { setConfig(value); setSaved(true); setSavedModel(value.model); }
    }).catch((e: unknown) => { if (active) setError(String(e)); })
      .finally(() => { if (active) setBusy(false); });
      return () => { active = false; };
  }, []);
  function change<K extends keyof CommanderConfig>(field: K, value: CommanderConfig[K]) {
    if (field !== "model") { setModels([]); setCatalogMessage(null); }
    setConfig((previous) => ({ ...previous, [field]: value })); setSaved(false); setError(null);
  }
  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try { await saveCommanderConfig(config); setSaved(true); setSavedModel(config.model); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function fetchModels() {
    setListing(true); setError(null); setModels([]); setCatalogMessage(null);
    try {
      const values = await listCommanderModels(config);
      setModels(values);
      setCatalogMessage(values.length ? `接口返回 ${values.length} 个模型，请选择后保存。` : "接口未返回模型，可以继续手填。");
    } catch (e) { setError(String(e)); }
    finally { setListing(false); }
  }
  return (
    <section className="rounded-md border p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold">指挥官模型</h2>
          <p className="mt-1 text-sm">当前保存的模型：<strong className="font-mono">{savedModel || "尚未配置"}</strong></p>
        </div>
        <span role="status" className={`rounded-full border px-3 py-1 text-xs ${saved ? "border-emerald-500/40 text-emerald-600" : "text-muted-foreground"}`}>
          {busy ? "正在读取或保存…" : saved ? "已保存到本机" : savedModel ? "有未保存的修改" : "等待配置"}
        </span>
      </div>
      <p className="text-muted-foreground mb-4 text-xs">
        将目标拆解为任务计划，独立于执行任务的 Agent。支持兼容 Chat Completions 的接口。保存配置后可用于生成计划；保存成功尚不代表模型推理已验收。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">API 地址（Base URL 或完整对话补全地址）
          <Input aria-label="指挥官 API endpoint" className="mt-1 font-mono text-xs" value={config.endpoint} disabled={busy || listing}
            placeholder="https://api.example.com/v1" onChange={(e) => change("endpoint", e.target.value)} />
        </label>
        <label className="text-xs">模型名
          <Input aria-label="指挥官模型名" className="mt-1 font-mono text-xs" value={config.model} disabled={busy || listing}
            placeholder="填写服务商的模型 ID" onChange={(e) => change("model", e.target.value)} />
        </label>
        <div className="text-xs sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={busy || listing || !config.endpoint.trim() || !config.api_key_env.trim()} onClick={() => void fetchModels()}>
            {listing ? "正在获取模型…" : "获取模型列表"}
          </Button>
          {models.length > 0 && <label className="flex items-center gap-2">选择模型
            <select aria-label="选择指挥官模型" className="bg-background rounded-md border px-3 py-2 text-sm" value={models.includes(config.model) ? config.model : ""}
              onChange={(e) => { if (e.target.value) change("model", e.target.value); }}>
              <option value="" disabled>请选择模型</option>
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
          {catalogMessage && <p role="status" className="text-muted-foreground">{catalogMessage}</p>}
        </div>
        <p className="text-muted-foreground text-xs sm:col-span-2">列表由当前接口返回，可能包含语音等模型；用于指挥官时请选择支持文本对话的模型。列表不保证账号额度或推理权限，接口不支持查询时可手填。</p>
        <label className="text-xs">Key 环境变量名
          <Input aria-label="指挥官 Key 环境变量名" className="mt-1 font-mono text-xs" value={config.api_key_env} disabled={busy || listing}
            onChange={(e) => change("api_key_env", e.target.value)} />
        </label>
        <label className="text-xs">请求超时（秒）
          <Input aria-label="指挥官请求超时" type="number" min={1} max={300} className="mt-1 text-xs" value={config.timeout_secs} disabled={busy || listing}
            onChange={(e) => change("timeout_secs", Number(e.target.value))} />
        </label>
      </div>
      <p className="text-muted-foreground my-3 text-xs">
        连接设置只保存到本机 SQLite，不上传 GitHub。此处填写环境变量名称，不填写 key 本身；生成计划时从该变量读取 key。
      </p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy || listing || !config.endpoint.trim() || !config.model.trim() || !config.api_key_env.trim()} onClick={() => void save()}>
          {busy ? "处理中…" : "保存指挥官配置"}
        </Button>
        {saved && <span className="text-muted-foreground text-xs">当前模型已保存，下次启动自动恢复。</span>}
      </div>
      {error && <p role="alert" className="text-destructive mt-2 text-xs">{error}</p>}
    </section>
  );
}
