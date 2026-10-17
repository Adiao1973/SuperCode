import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import {
  Folder,
  Search,
  LayoutGrid,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
export const NAV_ITEMS = [
  { id: "commander", label: "指挥官", icon: LayoutGrid },
  { id: "sessions", label: "会话", icon: MessageSquare },
  { id: "kanban", label: "任务看板", icon: LayoutGrid },
  { id: "approvals", label: "审批中心", icon: ShieldCheck },
  { id: "settings", label: "设置", icon: Settings },
] as const;
export type NavId = (typeof NAV_ITEMS)[number]["id"];
export function AppShell({
  nav,
  onNavigate,
  onSearch,
  pendingCount,
  project,
  version,
  children,
}: {
  nav: NavId;
  onNavigate: (nav: NavId) => void;
  onSearch?: () => void;
  pendingCount: number;
  project: { name: string; cwd: string; agent: string };
  version: string | null;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousNav = useRef(nav);
  const navAtOpen = useRef(nav);
  useEffect(() => {
    if (previousNav.current === nav) return;
    previousNav.current = nav;
    setProjectOpen(false);
    heading.current?.focus();
  }, [nav]);
  const navigation = useMemo(() => (
        <aside
          className={cn(
            "bg-sidebar flex shrink-0 flex-col border-r",
            collapsed ? "w-16" : "w-56",
          )}
          aria-label="应用导航"
        >
          <div
            className={cn(
              "flex h-14 shrink-0 items-center gap-2 px-4",
              collapsed && "justify-center px-0",
            )}
          >
            <Terminal
              className="text-primary size-5 shrink-0"
              aria-hidden="true"
            />
            {!collapsed && (
              <>
                <span className="font-heading text-base font-semibold tracking-tight">
                  SuperCode
                </span>
                <span className="text-muted-foreground ml-auto text-[10px]">
                  {version ? `v${version}` : ""}
                </span>
              </>
            )}
          </div>
          <nav
            id="app-navigation"
            aria-label="模块"
            className="flex flex-col gap-1 border-t p-2"
          >
            {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
              const button = (
                  <button
                    key={id}
                    type="button"
                    aria-label={
                      id === "approvals" && pendingCount
                        ? `${label}，${pendingCount} 项待审批`
                        : label
                    }
                    aria-current={nav === id ? "page" : undefined}
                    onClick={() => onNavigate(id)}
                    className={cn(
                      "hover:bg-sidebar-accent relative flex h-10 items-center gap-2.5 rounded-md px-3 text-sm transition-colors",
                      collapsed && "justify-center px-0",
                      nav === id
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : "text-sidebar-foreground/80",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {!collapsed && <span>{label}</span>}
                    {id === "approvals" && pendingCount > 0 && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "bg-primary text-primary-foreground rounded-full px-1.5 text-[10px]",
                          collapsed ? "absolute top-0 right-0" : "ml-auto",
                        )}
                      >
                        {pendingCount > 99 ? "99+" : pendingCount}
                      </span>
                    )}
                  </button>
              );
              return collapsed ? (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right">
                    {label}
                    {id === "approvals" && pendingCount > 0 ? ` · ${pendingCount} 项待审批` : ""}
                  </TooltipContent>
                </Tooltip>
              ) : button;
            })}
          </nav>
          {onSearch && <div className="px-2 pt-2"><Button variant="ghost" className="w-full justify-start gap-2" aria-label="搜索与快捷键（⌘K / Ctrl K）" title="搜索与快捷键（⌘K / Ctrl K）" onClick={onSearch}><Search className="size-4 shrink-0" />{!collapsed && <><span>搜索与快捷键</span><kbd className="ml-auto text-[10px] text-muted-foreground">⌘K</kbd></>}</Button></div>}
          <div className="mt-auto border-t p-2">
            <Button
              variant="ghost"
              className="w-full justify-center"
              aria-controls="app-navigation"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "展开导航" : "折叠导航"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <>
                  <PanelLeftClose className="size-4" />
                  <span>折叠导航</span>
                </>
              )}
            </Button>
          </div>
        </aside>
  ), [collapsed, nav, onNavigate, pendingCount, version, onSearch]);
  const active = NAV_ITEMS.find((item) => item.id === nav)!;
  return (
    <TooltipProvider delayDuration={300}>
      <div className="bg-background text-foreground flex h-dvh">
        {navigation}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-4 border-b px-5">
            <h1
              ref={heading}
              data-app-heading
              tabIndex={-1}
              className="shrink-0 text-sm font-semibold outline-none"
            >
              {active.label}
            </h1>
            <Popover.Root
              modal
              open={projectOpen}
              onOpenChange={(open) => {
                if (open) navAtOpen.current = nav;
                setProjectOpen(open);
              }}
            >
              <Popover.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto min-w-0 max-w-[60%]"
                  aria-label={`当前项目：${project.name}`}
                >
                  <Folder className="size-4 shrink-0" />
                  <span className="truncate">{project.name}</span>
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  aria-label="当前项目"
                  sideOffset={8}
                  align="end"
                  className="bg-popover text-popover-foreground z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border p-4 shadow-lg"
                  onCloseAutoFocus={(event) => {
                    if (navAtOpen.current !== nav) {
                      event.preventDefault();
                      heading.current?.focus();
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">{project.name}</h2>
                    <Popover.Close asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="关闭项目定位"
                      >
                        <X className="size-4" />
                      </Button>
                    </Popover.Close>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    当前会话目录
                  </p>
                  <code className="mt-1 block break-all text-xs">
                    {project.cwd || "尚未选择会话"}
                  </code>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Agent：{project.agent || "未选择"}
                  </p>
                  <Button
                    className="mt-4 w-full"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setProjectOpen(false);
                      onNavigate("sessions");
                    }}
                  >
                    进入会话
                  </Button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </header>
          {children}
        </main>
      </div>
    </TooltipProvider>
  );
}
