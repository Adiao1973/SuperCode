import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCommanderConfig, saveCommanderConfig, listCommanderModels, saveCommanderKey, commanderCredentialSource, verifyCommanderPlan, cancelCommanderPlan, type CommanderPlan, type CredentialSource, type CommanderConfig } from "@/lib/commander";

const EMPTY_CONFIG: CommanderConfig = {
  endpoint: "", model: "", api_key_env: "SUPERCODE_LLM_API_KEY", timeout_secs: 60,
};

export function CommanderSettings() {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [key, setKey] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [credential, setCredential] = useState<CredentialSource | "loading" | "error">("loading");
  const credentialRevision = useRef(0);
  const locked = useRef(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [verification, setVerification] = useState<"unverified" | "passed" | "failed" | "cancelled">("unverified");
  const cancelled = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [plan, setPlan] = useState<CommanderPlan | null>(null);
  const request = useRef<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState<string | null>(null);
  const [savedModel, setSavedModel] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true); setLoadFailed(false);
    void getCommanderConfig().then((value) => {
      if (active && value) { setConfig(value); setSaved(true); setSavedModel(value.model); }
    }).catch((e: unknown) => { if (active) { setError(String(e)); setLoadFailed(true); } })
      .finally(() => { if (active) setBusy(false); });
      return () => { active = false; };
  }, [loadRevision]);
  useEffect(() => {
    const revision = ++credentialRevision.current;
    setCredential(config.endpoint.trim() ? "loading" : "missing");
    if (config.endpoint.trim()) void commanderCredentialSource(config).then((value) => {
      if (revision === credentialRevision.current) setCredential(value);
    }).catch(() => { if (revision === credentialRevision.current) setCredential("error"); });
    return () => { credentialRevision.current++; };
  }, [config.endpoint, config.api_key_env, loadRevision]);
  useEffect(() => () => { if (request.current) void cancelCommanderPlan(request.current).catch(() => {}); }, []);
  async function saveKey() {
    if (locked.current) return;
    locked.current = true; credentialRevision.current++;
    setKeySaving(true); setError(null);
    try { await saveCommanderKey(config, key); setKey(""); setCredential("sqlite"); setPlan(null); setVerification("unverified"); }
    catch (e) { setError(String(e)); }
    finally { locked.current = false; setKeySaving(false); }
  }
  async function verify() {
    if (locked.current || !saved || !["sqlite", "environment"].includes(credential)) return;
    locked.current = true; cancelled.current = null; setCancelling(false);
    const id = crypto.randomUUID(); request.current = id;
    setVerifying(true); setError(null); setPlan(null); setVerification("unverified");
    try { const result = await verifyCommanderPlan(id); if (request.current === id) { setPlan(result); setVerification("passed"); } }
    catch (e) { if (request.current === id) { setError(String(e)); setVerification(cancelled.current === id ? "cancelled" : "failed"); } }
    finally { if (request.current === id) { request.current = null; locked.current = false; setVerifying(false); setCancelling(false); } }
  }
  function change<K extends keyof CommanderConfig>(field: K, value: CommanderConfig[K]) {
    if (field !== "model") { setModels([]); setCatalogMessage(null); }
    setConfig((previous) => ({ ...previous, [field]: value })); setSaved(false); setError(null); setPlan(null); setVerification("unverified");
  }
  async function save() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setSaved(false); setPlan(null); setVerification("unverified");
    try { await saveCommanderConfig(config); setSaved(true); setSavedModel(config.model); }
    catch (e) { setError(String(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  async function fetchModels() {
    if (locked.current) return;
    locked.current = true; setListing(true); setError(null); setModels([]); setCatalogMessage(null);
    try {
      const values = await listCommanderModels(config);
      setModels(values);
      setCatalogMessage(values.length ? `接口返回 ${values.length} 个模型，请选择后保存。` : "接口未返回模型，可以继续手填。");
    } catch (e) { setError(String(e)); }
    finally { locked.current = false; setListing(false); }
  }
  return (
    <section aria-label="指挥官模型设置" className="space-y-4">
      <div><p className="text-xs font-medium text-primary">初次配置 · 先保存，再验证</p><p className="mt-1 text-xs text-muted-foreground">指挥官负责生成计划；执行任务的 Agent 在另一组单独配置。</p></div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-base font-semibold">指挥官模型</h2>
          <p className="mt-1 text-sm">当前保存的模型：<strong className="font-mono">{savedModel || "尚未配置"}</strong></p>
        </div>
        <span role="status" aria-label="连接保存状态" className={`rounded-full border px-3 py-1 text-xs ${saved ? "border-emerald-500/40 text-success" : "text-muted-foreground"}`}>
          {busy ? "正在读取或保存…" : saved ? "已保存到本机" : savedModel ? "有未保存的修改" : "等待配置"}
        </span>
      </div>
      <ol aria-label="模型配置步骤" className="grid gap-3 border-y py-3 text-xs sm:grid-cols-3">
        <li><span className="text-muted-foreground">1 · 连接</span><p className="mt-1">{saved ? "连接已保存" : "连接未保存"}</p></li>
        <li><span className="text-muted-foreground">2 · 密钥</span><p className="mt-1">{credential === "sqlite" ? "密钥已保存" : credential === "environment" ? "环境变量备用" : credential === "loading" ? "正在读取凭据状态" : credential === "error" ? "凭据状态读取失败" : "尚未保存密钥"}</p></li>
        <li><span className="text-muted-foreground">3 · 模型</span><p role="status" aria-label="模型验证状态" className="mt-1">{verifying ? "正在验证" : verification === "passed" ? "验证通过 · 本次设置期间" : verification === "failed" ? "验证失败 · 可重试" : verification === "cancelled" ? "已取消验证 · 可重试" : "未验证"}</p></li>
      </ol>
      {loadFailed && <Button variant="outline" size="sm" onClick={() => { setError(null); setLoadRevision((n) => n + 1); }}>重新读取模型配置</Button>}
      <p className="text-muted-foreground mb-4 text-xs">
        将目标拆解为任务计划，独立于执行任务的 Agent。支持兼容 Chat Completions 的接口。保存配置后可用于生成计划；保存成功尚不代表模型推理已验收。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">API 地址（Base URL 或完整对话补全地址）
          <Input aria-label="指挥官 API endpoint" className="mt-1 font-mono text-xs" value={config.endpoint} disabled={busy || listing || keySaving || verifying || loadFailed}
            placeholder="https://api.example.com/v1" onChange={(e) => change("endpoint", e.target.value)} />
        </label>
        <label className="text-xs">模型名
          <Input aria-label="指挥官模型名" className="mt-1 font-mono text-xs" value={config.model} disabled={busy || listing || keySaving || verifying || loadFailed}
            placeholder="填写服务商的模型 ID" onChange={(e) => change("model", e.target.value)} />
        </label>
        <div className="text-xs sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={busy || listing || keySaving || verifying || loadFailed || !config.endpoint.trim() || !config.api_key_env.trim()} onClick={() => void fetchModels()}>
            {listing ? "正在获取模型…" : "获取模型列表"}
          </Button>
          {models.length > 0 && <label className="flex items-center gap-2">选择模型
            <select disabled={busy || listing || keySaving || verifying} aria-label="选择指挥官模型" className="bg-background rounded-md border px-3 py-2 text-sm" value={models.includes(config.model) ? config.model : ""}
              onChange={(e) => { if (e.target.value) change("model", e.target.value); }}>
              <option value="" disabled>请选择模型</option>
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
          {catalogMessage && <p role="status" className="text-muted-foreground">{catalogMessage}</p>}
        </div>
        <p className="text-muted-foreground text-xs sm:col-span-2">列表由当前接口返回，可能包含语音等模型；用于指挥官时请选择支持文本对话的模型。列表不保证账号额度或推理权限，接口不支持查询时可手填。</p>
        <div className="sm:col-span-2 rounded-md border p-3">
          <label className="text-xs">API key（只保存到本机）
            <Input aria-label="指挥官 API key" type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy || listing || keySaving || verifying || loadFailed}
              placeholder={credential === "sqlite" ? "已保存，填写可替换" : "粘贴完整 API key"} onChange={(e) => setKey(e.target.value)} className="mt-1 font-mono text-xs" />
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" disabled={!key.trim() || !config.endpoint.trim() || busy || listing || keySaving || verifying || loadFailed || credential === "loading"} onClick={() => void saveKey()}>
              {keySaving ? "正在保存密钥…" : "保存密钥到本机"}
            </Button>
            <span role="status" aria-label="密钥保存状态" className="text-muted-foreground text-xs">{credential === "sqlite" ? "密钥已保存到本机 · 重启可直接使用" : credential === "environment" ? "使用当前进程的环境变量 · 尚未保存到本机" : credential === "loading" ? "正在读取凭据状态…" : credential === "error" ? "凭据状态读取失败，请重新读取" : "尚未保存密钥"}</span>
          </div>
        </div>
        <label className="text-xs">Key 环境变量名（高级备用）
          <Input aria-label="指挥官 Key 环境变量名" className="mt-1 font-mono text-xs" value={config.api_key_env} disabled={busy || listing || keySaving || verifying || loadFailed}
            onChange={(e) => change("api_key_env", e.target.value)} />
        </label>
        <label className="text-xs">请求超时（秒）
          <Input aria-label="指挥官请求超时" type="number" min={1} max={300} className="mt-1 text-xs" value={config.timeout_secs} disabled={busy || listing || keySaving || verifying || loadFailed}
            onChange={(e) => change("timeout_secs", Number(e.target.value))} />
        </label>
      </div>
      <p className="text-muted-foreground my-3 text-xs">
        连接设置和密钥仅保存到本机 SQLite，数据库不上传 GitHub。优先使用本机保存的 key；环境变量是可选备用方式。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy || listing || keySaving || verifying || loadFailed || !config.endpoint.trim() || !config.model.trim() || !config.api_key_env.trim()} onClick={() => void save()}>
          {busy ? "处理中…" : "保存指挥官配置"}
        </Button>
        {saved && <span className="text-muted-foreground text-xs">当前模型已保存，下次启动自动恢复。</span>}
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={!saved || busy || listing || keySaving || verifying || !["sqlite", "environment"].includes(credential)} onClick={() => void verify()}>
            {verifying ? "正在验证模型并生成计划…" : "验证模型并生成示例计划"}
          </Button>
          {verifying && <Button size="sm" variant="outline" disabled={cancelling} onClick={() => { const id = request.current; if (!id || cancelled.current === id) return; cancelled.current = id; setCancelling(true); void cancelCommanderPlan(id).catch((e: unknown) => { if (request.current === id) { cancelled.current = null; setCancelling(false); setError(String(e)); } }); }}>{cancelling ? "正在取消…" : "取消验证"}</Button>}
        </div>
        <p className="text-muted-foreground mt-2 text-xs">向当前保存的模型发送示例目标；会产生一次 API 调用，不执行任务。验证结果仅代表本次请求，重开设置需重新验证。</p>
        {plan && <div role="status" className="mt-3 text-xs">
          <p className="font-medium text-success">模型验证通过 · {plan.plan.tasks.length} 个任务 · {plan.batches.length} 个依赖批次</p>
          <ol className="mt-2 space-y-1">{plan.plan.tasks.map((task) => <li key={task.id}>{task.title} <span className="text-muted-foreground">· {task.agent_id}</span></li>)}</ol>
        </div>}
      </div>
      {credential === "error" && <Button size="sm" variant="outline" onClick={() => setLoadRevision((n) => n + 1)}>重新读取凭据状态</Button>}
      {error && <p role="alert" className="text-destructive mt-2 text-xs">{error}</p>}
    </section>
  );
}
