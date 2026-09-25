import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { RunConsole } from "@/components/RunConsole";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  MessageSquare,
  Settings,
  ShieldCheck,
  Terminal,
} from "lucide-react";

/** 导航项：id 对应 Phase 1 各视图，hint 标注接入任务号 */
const NAV_ITEMS = [
  { id: "sessions", label: "会话", icon: MessageSquare, hint: "P1-3" },
  { id: "kanban", label: "任务看板", icon: LayoutGrid, hint: "P1-8" },
  { id: "approvals", label: "审批中心", icon: ShieldCheck, hint: "P1-5" },
  { id: "settings", label: "设置", icon: Settings, hint: "P1-7" },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

function App() {
  const [active, setActive] = useState<NavId>("sessions");
  const activeItem =
    NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0];

  return (
    <div className="bg-background text-foreground flex h-dvh">
      {/* 侧栏：品牌 + 模块导航 + agent 状态（多 agent 注册表为 Phase 2） */}
      <aside className="bg-sidebar flex w-56 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <Terminal className="text-primary size-5" />
          <span className="font-heading text-base font-semibold tracking-tight">
            SuperCode
          </span>
          <Badge variant="secondary" className="ml-auto text-[10px]">
            v0.2 dev
          </Badge>
        </div>
        <div className="border-t" />
        <nav className="flex flex-col gap-1 p-2">
          {NAV_ITEMS.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              className={cn(
                "hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                active === id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground/80",
              )}
            >
              <Icon className="size-4" />
              {label}
              <Badge variant="outline" className="ml-auto text-[10px] tabular-nums">
                {hint}
              </Badge>
            </button>
          ))}
        </nav>
        <div className="mt-auto p-4">
          <div className="border-t py-3" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500" />
            opencode · 待接入（P1-7）
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="text-sm font-semibold">{activeItem.label}</h1>
          <Badge variant="outline" className="text-[10px]">
            {active === "sessions" ? "事件管道 · P1-2" : `待接入 · ${activeItem.hint}`}
          </Badge>
        </header>
        {active === "sessions" ? (
          <RunConsole />
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-sm">
            <activeItem.icon className="size-8 opacity-40" />
            {activeItem.label}视图将在 {activeItem.hint} 接入
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
