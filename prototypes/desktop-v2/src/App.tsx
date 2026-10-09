import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
  LazyMotion,
  domMax,
  AnimatePresence,
  MotionConfig,
  useReducedMotion,
  LayoutGroup,
} from "motion/react";
import * as m from "motion/react-m";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Dialog, AlertDialog } from "radix-ui";
import { Command } from "cmdk";
import { Toaster, toast } from "sonner";
import {
  ArrowUp,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns3,
  Copy,
  FileCode2,
  Folder,
  GitBranch,
  Layers,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
const Markdown = lazy(() => import("./markdown.tsx"));
type Page = "sessions" | "commander" | "kanban" | "approvals" | "settings";
type Scenario = "ready" | "empty" | "loading" | "error";
const names: Record<Page, string> = {
  sessions: "会话",
  commander: "指挥官",
  kanban: "任务看板",
  approvals: "审批中心",
  settings: "设置",
};
const icons = {
  sessions: MessageSquare,
  commander: Layers,
  kanban: Columns3,
  approvals: ShieldCheck,
  settings: Settings2,
};
const pages = Object.keys(names) as Page[];
const tasks = [
  {
    title: "建立持久化数据层",
    agent: "Codex",
    file: "src/storage/tasks.ts",
    text: "实现 SQLite 任务仓库和迁移，保留已有字段。新增与更新任务应当使用事务，失败时保持原状态。",
    status: 0,
  },
  {
    title: "连接任务列表与筛选",
    agent: "OpenCode",
    file: "src/components/TaskList.tsx",
    text: "接入任务查询，提供状态与关键词筛选。处理中保持现有列表，空结果给出清除筛选入口。",
    status: 1,
  },
  {
    title: "完善键盘操作",
    agent: "Codex",
    file: "src/components/TaskRow.tsx",
    text: "确保 Tab、Enter 和 Escape 的行为清晰，完成后补充可访问性检查。",
    status: 2,
  },
  {
    title: "核对升级与回归",
    agent: "OpenCode",
    file: "tests/tasks.test.ts",
    text: "验证旧数据升级后不会丢失；覆盖新增、编辑与完成任务的往返路径。",
    status: 3,
  },
];
const md =
  '## 数据层已经就绪\n\n任务现在通过统一仓库读写，**列表与看板共享同一份状态**。接下来可以连接筛选与键盘操作。\n\n| 检查项 | 结果 |\n| --- | --- |\n| 数据迁移 | 保留已有任务 |\n| 事务回滚 | 写入失败可恢复 |\n\n```ts\nexport async function completeTask(id: string) {\n  return repository.update(id, { status: "done" });\n}\n```\n\n建议先审阅 `src/storage/tasks.ts` 的修改，再继续界面任务。';
const parse = () => {
  const q = new URLSearchParams(location.hash.slice(1));
  return {
    page: (pages.includes(q.get("page") as Page)
      ? q.get("page")
      : "sessions") as Page,
    theme: q.get("theme") === "light" ? "light" : "dark",
    state: (["ready", "empty", "loading", "error"].includes(
      q.get("state") || "",
    )
      ? q.get("state")
      : "ready") as Scenario,
    reduce: q.get("motion") === "reduce",
    slow: q.get("speed") === "slow",
  };
};
export default function App() {
  const initial = parse();
  const [page, setPage] = useState<Page>(initial.page),
    [theme, setTheme] = useState(initial.theme),
    [scenario, setScenario] = useState<Scenario>(initial.state),
    [reduced, setReduced] = useState(initial.reduce),
    [slow, setSlow] = useState(initial.slow),
    [width, setWidth] = useState(innerWidth),
    [context, setContext] = useState(true),
    [detail, setDetail] = useState<number | null>(null),
    [confirm, setConfirm] = useState(false),
    [palette, setPalette] = useState(false),
    [terminal, setTerminal] = useState(false),
    [prompt, setPrompt] = useState(""),
    [sent, setSent] = useState(""),
    [decision, setDecision] = useState(""),
    [running, setRunning] = useState(false),
    [settingsTab, setSettingsTab] = useState("模型连接"),
    [positions, setPositions] = useState(tasks.map((t) => t.status));
  const detailTrigger = useRef<HTMLElement | null>(null);
  const systemReduced = useReducedMotion();
  const reduce = reduced || systemReduced;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nav = (p: Page) => {
    setPage(p);
    setDetail(null);
    setScenario("ready");
  };
  useEffect(() => {
    const resize = () => setWidth(innerWidth);
    const hash = () => {
      const s = parse();
      setPage(s.page);
      setTheme(s.theme);
      setScenario(s.state);
      setReduced(s.reduce);
      setSlow(s.slow);
      setDetail(null);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((x) => !x);
      }
    };
    addEventListener("resize", resize);
    addEventListener("hashchange", hash);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("resize", resize);
      removeEventListener("hashchange", hash);
      removeEventListener("keydown", key);
      clearTimeout(timer.current);
    };
  }, []);

  const generate = () => {
    setScenario("loading");
    timer.current = setTimeout(() => setScenario("ready"), 650);
  };
  const layoutMotion = {
    duration: reduce ? 0 : slow ? 2.2 : 0.22,
    ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  };
  const stateBlock =
    scenario === "loading" ? (
      <div className="skeleton" role="status" aria-label="正在加载">
        <span />
        <span />
        <span />
      </div>
    ) : scenario === "error" ? (
      <div className="state-box error" role="alert">
        <span className="eyebrow">连接未完成</span>
        <h2>暂时无法读取内容</h2>
        <p>请求超时。已有记录仍保留，可以稍后重新查询。</p>
        <button onClick={() => setScenario("ready")}>
          重新查询 <ArrowRight size={14} />
        </button>
      </div>
    ) : scenario === "empty" ? (
      <div className="state-box">
        <span className="empty-symbol">
          <MessageSquare />
        </span>
        <h2>
          {page === "approvals" ? "所有请求都已处理" : "从一个明确的目标开始"}
        </h2>
        <p>
          {page === "approvals"
            ? "需要你确认的操作会出现在这里。"
            : "选择项目与 Agent，描述你接下来想完成的事情。"}
        </p>
        <button onClick={() => setScenario("ready")}>
          返回当前项目 <ArrowRight size={14} />
        </button>
      </div>
    ) : null;
  return (
    <MotionConfig reducedMotion={reduce ? "always" : "user"}>
      <LazyMotion features={domMax} strict>
        <div
          className="app"
          data-theme={theme}
          data-reduced={!!reduce}
          onPointerDownCapture={(e) => {
            if (detail === null)
              detailTrigger.current = (e.target as HTMLElement).closest(
                "button",
              );
          }}
          onKeyDownCapture={(e) => {
            if (detail === null && (e.key === "Enter" || e.key === " "))
              detailTrigger.current = (e.target as HTMLElement).closest(
                "button",
              );
          }}
        >
          <nav className="rail" aria-label="主导航">
            <a
              className="brand"
              href="#page=sessions"
              aria-label="SuperCode 首页"
            >
              <Code2 size={23} />
              <strong>SuperCode</strong>
            </a>
            <button
              className="search-button"
              onClick={() => setPalette(true)}
              aria-label="搜索与命令"
            >
              <Search size={17} />
              <span>搜索</span>
              <kbd>⌘K</kbd>
            </button>
            <div className="nav-items">
              {pages.slice(0, 4).map((p) => {
                const Icon = icons[p];
                return (
                  <button
                    key={p}
                    className={page === p ? "active" : ""}
                    onClick={() => nav(p)}
                    aria-current={page === p ? "page" : undefined}
                    aria-label={names[p]}
                  >
                    <Icon size={18} />
                    <span>{names[p]}</span>
                    {p === "approvals" && !decision && (
                      <b className="count">1</b>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="rail-bottom">
              <button
                className={page === "settings" ? "active" : ""}
                onClick={() => nav("settings")}
                aria-label="设置"
              >
                <Settings2 size={18} />
                <span>设置</span>
              </button>
              <div className="profile">
                <span className="avatar">A</span>
                <span>
                  本机工作区<small>所有数据保存在本机</small>
                </span>
              </div>
            </div>
          </nav>
          <div className="shell">
            <header className="topbar">
              <div className="breadcrumb">
                <button
                  aria-label="折叠项目列表"
                  onClick={() => setContext((x) => !x)}
                >
                  <PanelLeftClose size={17} />
                </button>
                <span>待办应用</span>
                <ChevronRight size={13} />
                <strong>{names[page]}</strong>
              </div>
              <div className="top-actions">
                <span className="local">
                  <span />
                  本机
                </span>
                <button
                  aria-label="切换深浅主题"
                  onClick={() =>
                    setTheme((x) => (x === "dark" ? "light" : "dark"))
                  }
                >
                  {theme === "dark" ? "浅色" : "深色"}
                </button>
                <button aria-label="更多操作" onClick={() => setPalette(true)}>
                  <MoreHorizontal size={18} />
                </button>
              </div>
            </header>
            <Group
              orientation="horizontal"
              className="workspace"
              id="workspace-panels"
            >
              {width >= 1100 && context && page !== "settings" && (
                <>
                  <Panel
                    id="context"
                    defaultSize="224px"
                    minSize="180px"
                    maxSize="300px"
                  >
                    <aside className="context">
                      <div className="context-heading">
                        <span>
                          {page === "commander"
                            ? "计划历史"
                            : page === "kanban"
                              ? "项目空间"
                              : "项目会话"}
                        </span>
                        <button
                          aria-label="新建会话"
                          onClick={() => {
                            nav("sessions");
                            setScenario("empty");
                          }}
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                      <button className="project-name">
                        <Folder size={16} />
                        待办应用
                        <ChevronDown size={14} />
                      </button>
                      <div className="context-section">今天</div>
                      {[
                        "完善任务管理流程",
                        "检查数据层与迁移",
                        "优化筛选交互",
                      ].map((t, i) => (
                        <button
                          className={
                            "session-link " + (i === 0 ? "selected" : "")
                          }
                          key={t}
                          onClick={() => {
                            setScenario("ready");
                            setSent("");
                          }}
                        >
                          <span className={"dot " + (i === 0 ? "green" : "")} />
                          <span>
                            {t}
                            <small>
                              {i === 0
                                ? "Codex · 等待审阅"
                                : i === 1
                                  ? "OpenCode · 已完成"
                                  : "Codex · 已完成"}
                            </small>
                          </span>
                        </button>
                      ))}
                      <div className="context-section">昨天</div>
                      <button className="session-link">
                        <span className="dot" />
                        <span>
                          构建基础布局<small>OpenCode · 已完成</small>
                        </span>
                      </button>
                      <div className="context-footer">
                        <GitBranch size={14} />
                        <span>dev</span>
                        <span className="muted">本机项目</span>
                      </div>
                    </aside>
                  </Panel>
                  <Separator
                    className="separator"
                    aria-label="调整项目列表宽度"
                  />
                </>
              )}
              <Panel id="content" minSize="460px">
                <main className="main">
                  <AnimatePresence mode="wait" initial={false}>
                    <m.section
                      className="page"
                      key={page}
                      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={layoutMotion}
                    >
                      {page === "sessions" ? (
                        <>
                          <div className="page-heading session-heading">
                            <div>
                              <span className="eyebrow">待办应用 / 会话</span>
                              <h1>完善任务管理流程</h1>
                            </div>
                            <button
                              className="subtle"
                              onClick={() => setDetail(0)}
                            >
                              会话详情 <ChevronRight size={14} />
                            </button>
                          </div>
                          <div className="reading">
                            {stateBlock || (
                              <div className="thread">
                                <div className="user-line">
                                  <span className="avatar small">A</span>
                                  <div>
                                    <b>
                                      你 <time>14:32</time>
                                    </b>
                                    <p>
                                      为任务列表接入持久化与状态筛选，保持现有数据不丢失。先检查结构，再给出修改建议。
                                    </p>
                                  </div>
                                </div>
                                <div className="agent-line">
                                  <div className="agent-avatar">
                                    <Code2 size={17} />
                                  </div>
                                  <div className="agent-body">
                                    <b>
                                      Codex <span className="muted">·</span>{" "}
                                      <time>14:33</time>
                                    </b>
                                    <button
                                      className="thinking"
                                      onClick={() => setDetail(0)}
                                    >
                                      <Check size={13} />
                                      已检查 4 个文件 <ChevronRight size={13} />
                                    </button>
                                    <Suspense fallback={<p>正在排版…</p>}>
                                      <Markdown text={md} />
                                    </Suspense>
                                    <button
                                      className="file-row"
                                      onClick={() => setDetail(0)}
                                    >
                                      <FileCode2 size={16} />
                                      <span>src/storage/tasks.ts</span>
                                      <em>+32</em>
                                      <ChevronRight size={14} />
                                    </button>
                                    <div className="message-actions">
                                      <button
                                        aria-label="复制回复"
                                        onClick={() => {
                                          navigator.clipboard
                                            ?.writeText(md)
                                            .then(() =>
                                              toast.success("已复制回复"),
                                            )
                                            .catch(() =>
                                              toast.error(
                                                "复制失败，请选择文字复制",
                                              ),
                                            );
                                        }}
                                      >
                                        <Copy size={14} />
                                      </button>
                                      <span>已完成 · 18 秒</span>
                                    </div>
                                    {!decision && (
                                      <div className="inline-approval">
                                        <ShieldCheck size={17} />
                                        <div>
                                          <b>等待你确认文件修改</b>
                                          <p>Codex · src/storage/tasks.ts</p>
                                        </div>
                                        <button onClick={() => setDetail(0)}>
                                          审阅
                                        </button>
                                      </div>
                                    )}
                                    {sent && (
                                      <div className="user-followup">
                                        <b>你</b>
                                        <p>{sent}</p>
                                        <p className="muted">
                                          已记录在当前原型中。
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="composer-wrap">
                            <div className="composer">
                              <textarea
                                aria-label="任务提示词"
                                placeholder="描述接下来要完成的事情…"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                onKeyDown={(e) => {
                                  if (
                                    e.key === "Enter" &&
                                    !e.shiftKey &&
                                    !e.nativeEvent.isComposing
                                  ) {
                                    e.preventDefault();
                                    if (prompt.trim()) {
                                      setSent(prompt);
                                      setPrompt("");
                                      setScenario("ready");
                                    }
                                  }
                                }}
                              />
                              <div className="composer-controls">
                                <div>
                                  <button onClick={() => setDetail(0)}>
                                    <Plus size={15} />
                                  </button>
                                  <button>
                                    Codex <ChevronDown size={12} />
                                  </button>
                                  <button
                                    className="permission"
                                    onClick={() => setDetail(0)}
                                  >
                                    <ShieldCheck size={13} />
                                    修改前确认
                                  </button>
                                </div>
                                <button
                                  className="send"
                                  aria-label="发送消息"
                                  disabled={!prompt.trim()}
                                  onClick={() => {
                                    setSent(prompt);
                                    setPrompt("");
                                    setScenario("ready");
                                  }}
                                >
                                  <ArrowUp size={17} />
                                </button>
                              </div>
                            </div>
                            <div className="composer-caption">
                              <span>
                                <Folder size={12} />
                                待办应用
                              </span>
                              <button onClick={() => setTerminal((x) => !x)}>
                                <Terminal size={13} />
                                终端
                              </button>
                              <span>↵ 发送 · ⇧↵ 换行</span>
                            </div>
                          </div>
                        </>
                      ) : page === "commander" ? (
                        <>
                          <div className="page-heading">
                            <div>
                              <span className="eyebrow">
                                目标 → 计划 → 执行
                              </span>
                              <h1>把目标变成下一步</h1>
                            </div>
                            <span className="status-label">
                              <span className="dot green" />
                              MiMo · 已验证
                            </span>
                          </div>
                          <div className="page-scroll">
                            {stateBlock || (
                              <>
                                <div className="goal-input">
                                  <label htmlFor="goal">任务目标</label>
                                  <textarea
                                    id="goal"
                                    defaultValue="完善待办应用的任务管理：接入持久化、筛选与键盘操作，保留原有数据。"
                                  />
                                  <div className="goal-controls">
                                    <button>
                                      <Folder size={14} />
                                      待办应用 <ChevronDown size={12} />
                                    </button>
                                    <button>
                                      Codex + OpenCode <ChevronDown size={12} />
                                    </button>
                                    <button
                                      className="primary"
                                      onClick={generate}
                                    >
                                      <Sparkles size={14} />
                                      生成计划
                                    </button>
                                  </div>
                                </div>
                                <div className="section-title">
                                  <div>
                                    <h2>执行计划</h2>
                                    <p>4 个任务 · 3 个依赖批次 · 并发上限 2</p>
                                  </div>
                                  <span className="status-label">
                                    {running ? "执行中" : "待审阅"}
                                  </span>
                                </div>
                                <div className="plan-list">
                                  {tasks.map((t, i) => (
                                    <button
                                      className="plan-row"
                                      key={t.title}
                                      onClick={() => setDetail(i)}
                                    >
                                      <span className="task-number">
                                        0{i + 1}
                                      </span>
                                      <div>
                                        <b>{t.title}</b>
                                        <p>
                                          {t.agent} ·{" "}
                                          {i === 0
                                            ? "无前置任务"
                                            : `依赖任务 0${i}`}
                                        </p>
                                      </div>
                                      <span className="task-stage">
                                        {running
                                          ? i === 0
                                            ? "运行中"
                                            : "排队中"
                                          : "查看详情"}
                                      </span>
                                      <ChevronRight size={15} />
                                    </button>
                                  ))}
                                </div>
                                <div className="plan-note">
                                  <ShieldCheck size={16} />
                                  <p>
                                    确认后才会交给 Agent
                                    执行。文件修改和命令仍按当前权限请求确认。
                                  </p>
                                </div>
                                <div className="plan-footer">
                                  <span className="muted">
                                    工作目录 /projects/todo-app
                                  </span>
                                  <AlertDialog.Root
                                    open={confirm}
                                    onOpenChange={setConfirm}
                                  >
                                    <AlertDialog.Trigger asChild>
                                      <button
                                        className="primary"
                                        disabled={running}
                                      >
                                        审阅并执行 <ArrowRight size={15} />
                                      </button>
                                    </AlertDialog.Trigger>
                                    <AlertDialog.Portal>
                                      <AlertDialog.Overlay className="modal-overlay" />
                                      <AlertDialog.Content className="confirm-modal">
                                        <AlertDialog.Title>
                                          确认执行此计划？
                                        </AlertDialog.Title>
                                        <AlertDialog.Description>
                                          4 个任务将交给 Codex 与
                                          OpenCode，最多同时执行 2
                                          个。当前是合成原型，确认只改变本页状态。
                                        </AlertDialog.Description>
                                        <dl>
                                          <dt>项目目录</dt>
                                          <dd>/projects/todo-app</dd>
                                          <dt>权限模式</dt>
                                          <dd>修改前确认</dd>
                                        </dl>
                                        <div className="dialog-actions">
                                          <AlertDialog.Cancel asChild>
                                            <button>返回审阅</button>
                                          </AlertDialog.Cancel>
                                          <AlertDialog.Action asChild>
                                            <button
                                              className="primary"
                                              onClick={() => {
                                                setRunning(true);
                                                toast.success(
                                                  "计划已进入执行视图",
                                                );
                                              }}
                                            >
                                              确认执行
                                            </button>
                                          </AlertDialog.Action>
                                        </div>
                                      </AlertDialog.Content>
                                    </AlertDialog.Portal>
                                  </AlertDialog.Root>
                                </div>
                              </>
                            )}
                          </div>
                        </>
                      ) : page === "kanban" ? (
                        <>
                          <div className="page-heading">
                            <div>
                              <span className="eyebrow">待办应用</span>
                              <h1>
                                任务看板{" "}
                                <span className="heading-count">4</span>
                              </h1>
                            </div>
                            <button onClick={() => setDetail(0)}>
                              <Plus size={15} />
                              新建任务
                            </button>
                          </div>
                          {stateBlock || (
                            <LayoutGroup>
                              <div className="board">
                                {["待办", "进行中", "待审阅", "已完成"].map(
                                  (label, col) => (
                                    <div className="board-column" key={label}>
                                      <div className="column-title">
                                        <span className={"dot col-" + col} />
                                        {label}
                                        <span className="muted">
                                          {
                                            positions.filter((p) => p === col)
                                              .length
                                          }
                                        </span>
                                        <Plus size={14} />
                                      </div>
                                      {tasks.map(
                                        (t, i) =>
                                          positions[i] === col && (
                                            <m.article
                                              layout
                                              layoutId={"task-" + i}
                                              transition={layoutMotion}
                                              className="task-card"
                                              key={t.title}
                                            >
                                              <span className="task-id">
                                                TODO-{12 + i}
                                              </span>
                                              <button
                                                className="task-title"
                                                onClick={() => setDetail(i)}
                                              >
                                                {t.title}
                                              </button>
                                              <p>{t.text}</p>
                                              <div className="card-footer">
                                                <span className="mini-avatar">
                                                  {t.agent === "Codex"
                                                    ? "C"
                                                    : "O"}
                                                </span>
                                                <span>{t.agent}</span>
                                                {col < 3 && (
                                                  <button
                                                    aria-label={`将${t.title}移至${["待办", "进行中", "待审阅", "已完成"][col + 1]}`}
                                                    onClick={() =>
                                                      setPositions((p) =>
                                                        p.map((v, j) =>
                                                          j === i ? v + 1 : v,
                                                        ),
                                                      )
                                                    }
                                                  >
                                                    <ArrowRight size={15} />
                                                  </button>
                                                )}
                                              </div>
                                            </m.article>
                                          ),
                                      )}
                                    </div>
                                  ),
                                )}
                              </div>
                            </LayoutGroup>
                          )}
                        </>
                      ) : page === "approvals" ? (
                        <>
                          <div className="page-heading">
                            <div>
                              <span className="eyebrow">需要你的决定</span>
                              <h1>
                                审批中心{" "}
                                <span className="heading-count">
                                  {decision ? 0 : 1}
                                </span>
                              </h1>
                            </div>
                            <span className="muted">
                              一次裁决，仅用于当前操作
                            </span>
                          </div>
                          <div className="page-scroll">
                            {stateBlock ||
                              (decision ? (
                                <div className="state-box">
                                  <ShieldCheck size={36} />
                                  <h2>所有请求都已处理</h2>
                                  <p>{decision} · Codex 的文件修改请求</p>
                                </div>
                              ) : (
                                <div className="approval-detail">
                                  <div className="approval-meta">
                                    <span className="agent-avatar">
                                      <Code2 size={18} />
                                    </span>
                                    <div>
                                      <b>Codex 请求修改文件</b>
                                      <p>完善任务管理流程 · 待办应用</p>
                                    </div>
                                    <span className="status-label amber">
                                      待确认
                                    </span>
                                  </div>
                                  <h2>src/storage/tasks.ts</h2>
                                  <p className="muted">
                                    添加任务状态更新与事务处理。
                                  </p>
                                  <pre className="diff">
                                    <span>
                                      {" "}
                                      export const repository = &#123;
                                    </span>
                                    <span className="added">
                                      + async update(id: string, patch:
                                      TaskPatch) &#123;
                                    </span>
                                    <span className="added">
                                      + return db.transaction(tx =&gt;
                                      tx.update(id, patch));
                                    </span>
                                    <span className="added">+ &#125;</span>
                                    <span> &#125;;</span>
                                  </pre>
                                  <details>
                                    <summary>查看完整请求参数</summary>
                                    <pre>
                                      &#123;"path": "src/storage/tasks.ts",
                                      "operation": "edit"&#125;
                                    </pre>
                                  </details>
                                  <div className="approval-footer">
                                    <p>
                                      <ShieldCheck size={14} />
                                      拒绝不会自动重试或扩大权限。
                                    </p>
                                    <button
                                      onClick={() => setDecision("已拒绝")}
                                    >
                                      拒绝
                                    </button>
                                    <button
                                      className="primary"
                                      onClick={() => setDecision("已允许一次")}
                                    >
                                      允许这一次 <Check size={14} />
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="page-heading">
                            <div>
                              <span className="eyebrow">本机工作区</span>
                              <h1>设置</h1>
                            </div>
                          </div>
                          <div className="settings-layout">
                            <div className="settings-tabs">
                              {["模型连接", "Agent", "外观", "审批规则"].map(
                                (t) => (
                                  <button
                                    className={
                                      settingsTab === t ? "selected" : ""
                                    }
                                    onClick={() => setSettingsTab(t)}
                                    key={t}
                                  >
                                    {t}
                                  </button>
                                ),
                              )}
                            </div>
                            <div className="settings-body">
                              {stateBlock ||
                                (settingsTab === "外观" ? (
                                  <>
                                    <h2>外观与动态效果</h2>
                                    <div className="setting-row">
                                      <div>
                                        <b>界面主题</b>
                                        <p>为当前工作区选择明暗外观。</p>
                                      </div>
                                      <select
                                        aria-label="界面主题"
                                        value={theme}
                                        onChange={(e) =>
                                          setTheme(e.target.value)
                                        }
                                      >
                                        <option value="dark">深色</option>
                                        <option value="light">浅色</option>
                                      </select>
                                    </div>
                                    <div className="setting-row">
                                      <div>
                                        <b>减少动态效果</b>
                                        <p>
                                          保留状态变化，关闭位移与弹性动画。
                                        </p>
                                      </div>
                                      <input
                                        aria-label="减少动态效果"
                                        type="checkbox"
                                        checked={reduced}
                                        onChange={(e) =>
                                          setReduced(e.target.checked)
                                        }
                                      />
                                    </div>
                                  </>
                                ) : settingsTab === "Agent" ? (
                                  <>
                                    <h2>已接入的 Agent</h2>
                                    {["Codex", "OpenCode", "MiMo"].map((a) => (
                                      <div className="setting-row" key={a}>
                                        <b>{a}</b>
                                        <span className="status-label">
                                          已配置 · 运行状态待检测
                                        </span>
                                      </div>
                                    ))}
                                  </>
                                ) : settingsTab === "审批规则" ? (
                                  <>
                                    <h2>审批规则</h2>
                                    <p className="muted">
                                      修改前确认。当前原型不更改本机权限。
                                    </p>
                                    <div className="setting-row">
                                      <b>文件修改</b>
                                      <span>逐次确认</span>
                                    </div>
                                    <div className="setting-row">
                                      <b>命令执行</b>
                                      <span>逐次确认</span>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <div className="section-title">
                                      <div>
                                        <h2>指挥官模型</h2>
                                        <p>
                                          用于生成计划，与执行任务的 Agent
                                          独立。
                                        </p>
                                      </div>
                                      <span className="status-label">
                                        <span className="dot green" />
                                        已验证
                                      </span>
                                    </div>
                                    <div className="connection-summary">
                                      <span className="model-icon">
                                        <Sparkles size={23} />
                                      </span>
                                      <div>
                                        <b>MiMo</b>
                                        <p>mimo-v2.6-pro</p>
                                      </div>
                                      <span>本机保存</span>
                                    </div>
                                    <label className="field">
                                      API 地址
                                      <input
                                        defaultValue="https://api.example.com/v1"
                                        readOnly
                                      />
                                    </label>
                                    <label className="field">
                                      模型
                                      <select defaultValue="mimo-v2.6-pro">
                                        <option>mimo-v2.6-pro</option>
                                        <option>mimo-v2.6-flash</option>
                                      </select>
                                    </label>
                                    <label className="field">
                                      API key
                                      <input
                                        type="password"
                                        placeholder="已保存在本机，输入可替换"
                                        readOnly
                                      />
                                    </label>
                                    <p className="setting-hint">
                                      <ShieldCheck size={14} />
                                      这是合成配置。原型不保存密钥，也不调用
                                      API。
                                    </p>
                                    <div className="settings-actions">
                                      <button
                                        onClick={() =>
                                          toast("原型仅展示连接信息")
                                        }
                                      >
                                        编辑连接
                                      </button>
                                      <button
                                        className="primary"
                                        onClick={generate}
                                      >
                                        检查连接
                                      </button>
                                    </div>
                                    <div className="setting-row">
                                      <div>
                                        <b>连接状态</b>
                                        <p>
                                          已保存设置 · 密钥已保存 · 示例验证通过
                                        </p>
                                      </div>
                                      <Check size={17} />
                                    </div>
                                  </>
                                ))}
                            </div>
                          </div>
                        </>
                      )}
                    </m.section>
                  </AnimatePresence>
                  {terminal && (
                    <div className="terminal">
                      <div>
                        <span>
                          <Terminal size={13} />
                          终端 · 待办应用
                        </span>
                        <button
                          aria-label="关闭终端"
                          onClick={() => setTerminal(false)}
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <pre>
                        ~/projects/todo-app dev
                        <br />
                        <span>❯</span>{" "}
                        <span className="muted">原型终端预览，不执行命令</span>
                      </pre>
                    </div>
                  )}
                </main>
              </Panel>
            </Group>
          </div>
          <Dialog.Root
            open={detail !== null}
            onOpenChange={(v) => !v && setDetail(null)}
          >
            <AnimatePresence>
              {detail !== null && (
                <Dialog.Portal forceMount>
                  <Dialog.Overlay forceMount asChild>
                    <m.div
                      className="sheet-overlay"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={layoutMotion}
                    />
                  </Dialog.Overlay>
                  <Dialog.Content
                    forceMount
                    asChild
                    onCloseAutoFocus={(e) => {
                      e.preventDefault();
                      detailTrigger.current?.focus();
                    }}
                  >
                    <m.aside
                      className="inspector"
                      initial={{ x: reduce ? 0 : 20, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      exit={{ x: reduce ? 0 : 20, opacity: 0 }}
                      transition={layoutMotion}
                    >
                      <div className="inspector-header">
                        <span className="eyebrow">任务详情</span>
                        <Dialog.Close asChild>
                          <button aria-label="关闭详情">
                            <X size={18} />
                          </button>
                        </Dialog.Close>
                      </div>
                      <span className="task-id">TODO-{12 + detail}</span>
                      <Dialog.Title>{tasks[detail].title}</Dialog.Title>
                      <Dialog.Description>
                        {tasks[detail].text}
                      </Dialog.Description>
                      <dl>
                        <dt>执行 Agent</dt>
                        <dd>{tasks[detail].agent}</dd>
                        <dt>权限</dt>
                        <dd>修改前确认</dd>
                        <dt>依赖</dt>
                        <dd>
                          {detail === 0
                            ? "无前置任务"
                            : tasks[detail - 1].title}
                        </dd>
                        <dt>工作目录</dt>
                        <dd>/projects/todo-app</dd>
                      </dl>
                      <h3>完整任务说明</h3>
                      <p>
                        请先阅读相关代码，{tasks[detail].text}{" "}
                        完成后说明修改与验证结果；遇到失败保留错误，不自动重新执行计划。
                      </p>
                      <div className="inspector-file">
                        <FileCode2 size={16} />
                        {tasks[detail].file}
                      </div>
                      <button
                        className="wide-button"
                        onClick={() => {
                          setDetail(null);
                          nav("approvals");
                        }}
                      >
                        <ShieldCheck size={15} />
                        查看关联审批 <ArrowRight size={15} />
                      </button>
                    </m.aside>
                  </Dialog.Content>
                </Dialog.Portal>
              )}
            </AnimatePresence>
          </Dialog.Root>
          <Command.Dialog
            open={palette}
            onOpenChange={setPalette}
            label="搜索与命令"
            className="command-dialog"
          >
            <Command.Input placeholder="搜索模块、会话或任务…" />
            <Command.List>
              <Command.Empty>没有匹配的已加载内容</Command.Empty>
              <Command.Group heading="模块">
                {pages.map((p) => (
                  <Command.Item
                    key={p}
                    value={names[p]}
                    onSelect={() => {
                      nav(p);
                      setPalette(false);
                    }}
                  >
                    {names[p]}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="当前会话">
                <Command.Item
                  onSelect={() => {
                    nav("sessions");
                    setPalette(false);
                  }}
                >
                  完善任务管理流程
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command.Dialog>
          <Toaster
            theme={theme === "dark" ? "dark" : "light"}
            position="bottom-right"
          />
        </div>
      </LazyMotion>
    </MotionConfig>
  );
}
