import { useEffect, useRef, useState } from "react";
import { createWorkspace, listWorkspaces, type Workspace } from "@/lib/agent";
import { pickCommanderDirectory } from "@/lib/commander";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ProjectSettings({ onSaved }: { onSaved?: (rows: Workspace[]) => void }) {
  const [path, setPath] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const read = ++revision.current;
    void listWorkspaces().then((rows) => { if (alive.current && read === revision.current) setWorkspaces(rows); })
      .catch((e) => { if (alive.current && read === revision.current) setError(String(e)); });
    return () => { alive.current = false; revision.current++; };
  }, []);
  const perform = async (action: "save" | "pick" | "refresh") => {
    if (locked.current) return;
    locked.current = true; revision.current++; setBusy(true); setError(""); setNotice("");
    try {
      if (action === "save") {
        const workspace = await createWorkspace(path.trim());
        if (alive.current) setNotice(`已保存项目：${workspace.name}。已有会话目录保持不变。`);
        const rows = await listWorkspaces();
        if (alive.current) { setWorkspaces(rows); onSaved?.(rows); setNotice(`已保存项目：${workspace.name}。已有会话目录保持不变。`); }
      } else if (action === "refresh") {
        const rows = await listWorkspaces();
        if (alive.current) { setWorkspaces(rows); onSaved?.(rows); }
      } else {
        const chosen = await pickCommanderDirectory(path || undefined);
        if (alive.current && chosen != null) setPath(chosen);
      }
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <section aria-label="项目目录设置" className="space-y-3 border-b pb-6">
    <div><h2 className="text-base font-semibold">项目目录</h2><p className="mt-1 text-xs text-muted-foreground">添加已有项目目录。</p></div>
    <label className="block text-xs">项目目录<Input aria-label="项目目录" className="mt-1" value={path} disabled={busy} onChange={(e) => { setPath(e.target.value); setNotice(""); }} placeholder="选择本机项目文件夹" /></label>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform("pick")}>选择项目目录</Button><Button size="sm" disabled={busy || !path.trim()} onClick={() => void perform("save")}>{busy ? "处理中…" : "添加项目空间"}</Button></div>
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    {error && <div className="space-y-2"><p role="alert" className="break-words text-xs text-destructive">{error}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => void perform("refresh")}>重新读取项目列表</Button></div>}
    <ul aria-label="已保存项目" className="space-y-2 text-xs">{workspaces.filter((w) => w.kind === "project").map((w) => <li key={w.id}><span className="font-medium">{w.name}</span><span className="mt-1 block break-all text-muted-foreground">{w.path}</span></li>)}</ul>
  </section>;
}
