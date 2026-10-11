import { useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LayoutNotice, useLayoutPreferences } from "@/lib/layout";
function useMeasured() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}
export function WorkspacePanels({
  list,
  children,
}: {
  list: ReactNode;
  children: ReactNode;
}) {
  const { preferences, update } = useLayoutPreferences();
  const panel = usePanelRef();
  const { ref, size } = useMeasured();
  const narrow = size.width > 0 && size.width < 780;
  const [collapsed, setCollapsed] = useState(
    preferences.session_list_collapsed,
  );
  useEffect(() => {
    if (!panel.current || !size.width) return;
    if (narrow || preferences.session_list_collapsed) panel.current.collapse();
    else panel.current.resize(preferences.session_list_width);
  }, [
    narrow,
    size.width,
    panel,
    preferences.session_list_width,
    preferences.session_list_collapsed,
  ]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-8 shrink-0 items-center gap-2 border-b px-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          aria-label={collapsed ? "显示会话列表" : "隐藏会话列表"}
          aria-expanded={!collapsed}
          aria-controls="session-list-panel"
          disabled={narrow}
          onClick={() => update({ session_list_collapsed: !collapsed })}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-3.5" />
          ) : (
            <PanelLeftClose className="size-3.5" />
          )}
          会话列表
        </Button>
        {narrow && (
          <span className="text-muted-foreground text-[11px]">
            窗口较窄，已收起列表；折叠导航后可展开
          </span>
        )}
      </div>
      <LayoutNotice />
      <Group
        elementRef={ref}
        id="session-workspace-panels"
        orientation="horizontal"
        className="min-h-0 flex-1"
        resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction || narrow) return;
          const pixels =
            ((meta.requestedLayout?.["session-list-panel"] ??
              layout["session-list-panel"] ??
              0) *
              Math.max(0, size.width - 4)) /
            100;
          update({
            session_list_collapsed: pixels < 1,
            ...(pixels >= 180
              ? { session_list_width: Math.min(400, Math.round(pixels)) }
              : {}),
          });
        }}
      >
        <Panel
          id="session-list-panel"
          panelRef={panel}
          defaultSize={
            preferences.session_list_collapsed
              ? 0
              : preferences.session_list_width
          }
          minSize={180}
          maxSize={400}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          onResize={(value) => setCollapsed(value.inPixels < 1)}
        >
          <div hidden={collapsed} inert={collapsed} className="h-full">
            {list}
          </div>
        </Panel>
        <Separator
          aria-label="调整会话列表宽度"
          disabled={narrow}
          className="bg-border hover:bg-primary focus-visible:bg-primary w-1 shrink-0 transition-colors"
        />
        <Panel id="session-detail-panel" minSize={460}>
          {children}
        </Panel>
      </Group>
    </div>
  );
}
export function TerminalPanels({
  open,
  terminal,
  children,
}: {
  open: boolean;
  terminal: ReactNode;
  children: ReactNode;
}) {
  const { preferences, update } = useLayoutPreferences();
  const panel = usePanelRef();
  const { ref, size } = useMeasured();
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    if (!panel.current) return;
    if (!open || preferences.terminal_collapsed) panel.current.collapse();
    else if (size.height) panel.current.resize(preferences.terminal_height);
  }, [
    open,
    preferences.terminal_collapsed,
    preferences.terminal_height,
    panel,
    size.height,
  ]);
  return (
    <Group
      elementRef={ref}
      id="session-terminal-panels"
      orientation="vertical"
      className="min-h-0 flex-1"
      resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
      onLayoutChanged={(layout, meta) => {
        if (!open || !meta.isUserInteraction) return;
        const pixels =
          ((meta.requestedLayout?.["session-terminal-panel"] ??
            layout["session-terminal-panel"] ??
            0) *
            Math.max(0, size.height - 4)) /
          100;
        update({
          terminal_collapsed: pixels < 1,
          ...(pixels >= 96
            ? { terminal_height: Math.min(360, Math.round(pixels)) }
            : {}),
        });
      }}
    >
      <Panel id="session-content-panel" minSize={300}>
        <div className="flex h-full min-h-0 flex-col overflow-y-auto">
          {children}
        </div>
      </Panel>
      <Separator
        aria-label="调整终端高度"
        title="上下键调整；Enter 收起或展开终端"
        onKeyDownCapture={(event) => {
          if (
            open &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            event.stopPropagation();
            update({ terminal_collapsed: !preferences.terminal_collapsed });
          }
        }}
        disabled={!open}
        className={`${open ? "h-1" : "h-0"} bg-border hover:bg-primary focus-visible:bg-primary shrink-0 transition-colors`}
      />
      <Panel
        id="session-terminal-panel"
        panelRef={panel}
        defaultSize={0}
        minSize={96}
        maxSize={size.height ? Math.min(360, size.height * 0.45) : 360}
        collapsible
        collapsedSize={0}
        onResize={(value) => setCollapsed(value.inPixels < 1)}
      >
        <div hidden={collapsed} inert={collapsed} className="h-full">
          {terminal}
        </div>
      </Panel>
    </Group>
  );
}
