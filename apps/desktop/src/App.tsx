import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  LayoutGrid,
  MessageSquare,
  Settings,
  ShieldCheck,
  Terminal,
} from "lucide-react";

/** 导航项：id 对应 Phase 1 各视图，hint 标注接入任务号（P1-1 仅静态布局） */
const NAV_ITEMS = [
  { id: "sessions", label: "会话", icon: MessageSquare, hint: "P1-3" },
  { id: "kanban", label: "任务看板", icon: LayoutGrid, hint: "P1-8" },
  { id: "approvals", label: "审批中心", icon: ShieldCheck, hint: "P1-5" },
  { id: "settings", label: "设置", icon: Settings, hint: "P1-7" },
] as const;

/** Phase 1 接入清单：验收标准见 docs/roadmap.md */
const PHASE1_PLAN = [
  { id: "P1-2", title: "事件管道", detail: "Rust 合帧 → Tauri Channel → 前端流式渲染" },
  { id: "P1-3", title: "多会话管理", detail: "会话列表 / 新建 / 切换 / 取消" },
  { id: "P1-4", title: "会话视图", detail: "虚拟列表消息流 + 工具调用时间线 + diff 审查" },
  { id: "P1-5", title: "审批中心", detail: "待决队列 + once/always/reject + 预授权规则" },
  { id: "P1-6", title: "持久化与恢复", detail: "SQLite 会话历史，重启后可恢复上下文" },
  { id: "P1-7", title: "安装探测", detail: "opencode 检测与安装引导" },
  { id: "P1-8", title: "任务看板", detail: "任务 → 绑定会话 → 状态流转" },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

function App() {
  const [active, setActive] = useState<NavId>("sessions");
  const activeLabel = NAV_ITEMS.find((item) => item.id === active)?.label ?? "";

  return (
    <div className="bg-background text-foreground flex h-dvh">
      {/* 侧栏：品牌 + 模块导航 + agent 状态（多 agent 注册表为 Phase 2） */}
      <aside className="bg-sidebar flex w-56 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <Terminal className="size-5 text-primary" />
          <span className="font-heading text-base font-semibold tracking-tight">
            SuperCode
          </span>
          <Badge variant="secondary" className="ml-auto text-[10px]">
            v0.2 dev
          </Badge>
        </div>
        <Separator />
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
          <Separator className="mb-3" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="bg-emerald-500 size-2 rounded-full" />
            opencode · 待接入（P1-7）
          </div>
        </div>
      </aside>

      {/* 主区：视图标题栏 + 内容 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="text-sm font-semibold">{activeLabel}</h1>
          <Badge variant="outline" className="text-[10px]">
            脚手架 · P1-1
          </Badge>
          <div className="ml-auto">
            <Button size="sm" variant="outline" disabled title="P1-3 多会话管理接入后可用">
              新建会话
            </Button>
          </div>
        </header>
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-2xl p-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-xl">SuperCode 桌面壳已就绪</CardTitle>
                <CardDescription>
                  多 Agent 桌面总控客户端 · Tauri v2 + React 19 + shadcn/ui
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {PHASE1_PLAN.map(({ id, title, detail }) => (
                  <div
                    key={id}
                    className="hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-2 text-sm"
                  >
                    <Badge variant="secondary" className="w-11 justify-center tabular-nums">
                      {id}
                    </Badge>
                    <span className="font-medium">{title}</span>
                    <span className="text-muted-foreground min-w-0 truncate">{detail}</span>
                    <ChevronRight className="text-muted-foreground/50 ml-auto size-4 shrink-0" />
                  </div>
                ))}
              </CardContent>
            </Card>
            <p className="text-muted-foreground mt-4 px-1 text-xs">
              事件与命令自 P1-2 起经 Tauri Channel 接入 supercode-core；当前视图为静态脚手架。
            </p>
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}

export default App;
