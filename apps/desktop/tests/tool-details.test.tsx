import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ToolDetails, DiffDetails } from "../src/components/ToolDetails";
import {
  toolCommand,
  formatToolInterval,
  largeDiff,
} from "../src/lib/tool-details";
import { streamReducer, initialStream } from "../src/lib/stream";
import { handle, calls } from "./fixtures/tauri";
import type { DiffPayload } from "../src/lib/events";
const copy = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock("../src/lib/clipboard", () => ({ copyText: copy }));
vi.mock("../src/components/DiffPreview", () => ({
  default: ({ payload }: { payload: DiffPayload }) => {
    if (payload.path === "/throws") throw Error("fixture renderer failure");
    return <div data-testid="diff-preview">{payload.new_text}</div>;
  },
}));
function tool() {
  const raw = {
    command: "printf '完整中文\\n'\n# trailing\n",
    data: { items: [1, false, null] },
  };
  let s = streamReducer(initialStream, {
    type: "batch",
    receivedAt: 1000,
    batch: [
      {
        type: "tool_call",
        tool_call_id: "t",
        kind: "execute",
        title: "运行命令",
        name: "bash",
        raw_input: raw,
      },
    ],
  });
  s = streamReducer(s, {
    type: "batch",
    receivedAt: 2500,
    batch: [
      {
        type: "tool_call_update",
        tool_call_id: "t",
        status: "completed",
        content: [{ type: "text", text: "输出中文\n最后一行\n" }],
        locations: [],
      },
    ],
  });
  const item = s.items[0];
  if (item.kind !== "tool") throw Error("fixture");
  return { item, raw, state: s };
}
it("retains exact raw input and first terminal receive interval without perturbing finished tools", () => {
  const { item, raw, state } = tool();
  expect(item.rawInput).toBe(raw);
  expect(item.startedAt).toBe(1000);
  expect(item.endedAt).toBe(2500);
  const next = streamReducer(state, {
    type: "batch",
    receivedAt: 9000,
    batch: [
      {
        type: "tool_call_update",
        tool_call_id: "t",
        status: "completed",
        content: [],
        locations: [],
      },
    ],
  });
  expect(next.items[0]).toMatchObject({ endedAt: 2500 });
  const text = streamReducer(state, {
    type: "batch",
    batch: [{ type: "message_chunk", message_id: "m", text: "独立正文" }],
  });
  expect(text.items[0]).toBe(item);
  expect(formatToolInterval(item)).toBe("接收间隔 1.5s");
  expect(toolCommand(raw)).toBe(raw.command);
  expect(toolCommand({ cmd: "echo exact\n" })).toBe("echo exact\n");
});
it("separates collapsed parameters/output and copies complete command, JSON and output", async () => {
  copy.mockClear();
  const { item, raw } = tool();
  render(<ToolDetails item={item} />);
  expect(screen.queryByText("参数")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /运行命令/ }));
  expect(screen.queryByText(/最后一行/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(raw.command));
  fireEvent.click(screen.getByRole("button", { name: "复制完整参数" }));
  await waitFor(() =>
    expect(copy).toHaveBeenLastCalledWith(JSON.stringify(raw, null, 2)),
  );
  fireEvent.click(screen.getByRole("button", { name: "输出 · 1 段" }));
  fireEvent.click(screen.getByRole("button", { name: "复制工具输出" }));
  await waitFor(() =>
    expect(copy).toHaveBeenLastCalledWith(item.content.join("\n")),
  );
  expect(screen.queryByRole("button", { name: /文件变更/ })).toBeNull();
});
it("distinguishes missing/null parameters and does not invent a command or elapsed runtime", () => {
  const { item } = tool();
  const view = render(
    <ToolDetails
      item={{ ...item, rawInput: undefined, startedAt: null, endedAt: null }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /运行命令/ }));
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(screen.getByText("当前事件未提供参数")).toBeVisible();
  expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();
  view.rerender(<ToolDetails item={{ ...item, rawInput: null }} />);
  expect(screen.getByText("null")).toBeVisible();
  expect(toolCommand({ command: ["do not guess"] })).toBeNull();
  expect(
    formatToolInterval({ ...item, status: "in_progress", endedAt: null }),
  ).toBe("尚未结束");
});
it("does not read disk before explicit expansion and recovers missing file via retry", async () => {
  let fail = true;
  handle("read_text_file", () => {
    if (fail) throw Error("fixture missing file");
    return "当前磁盘中文\n完整结尾\n";
  });
  render(
    <DiffDetails itemKey="disk" diff={null} lazyPath="/fixture/file.txt" />,
  );
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "fixture missing file",
  );
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
  expect(await screen.findByTestId("diff-preview")).toHaveTextContent(
    "当前磁盘中文",
  );
  expect(calls.filter((c) => c.command === "read_text_file")).toHaveLength(2);
  expect(screen.getByText(/当前磁盘内容/)).toBeVisible();
});
it("ignores a pending disk response after close or replacement with structured diff", async () => {
  let finish!: (v: string) => void;
  handle("read_text_file", () => new Promise<string>((r) => (finish = r)));
  const view = render(
    <DiffDetails itemKey="race" diff={null} lazyPath="/old" />,
  );
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  await waitFor(() => expect(calls).toHaveLength(1));
  view.rerender(
    <DiffDetails
      itemKey="race"
      diff={{ path: "/new", old_text: "before", new_text: "正确结构化内容" }}
      lazyPath={null}
    />,
  );
  await act(async () => finish("过期磁盘内容"));
  expect(await screen.findByTestId("diff-preview")).toHaveTextContent(
    "正确结构化内容",
  );
  expect(screen.queryByText("过期磁盘内容")).toBeNull();
});
it("long diff bypasses renderer with complete selectable and copyable old/new text", async () => {
  const payload = {
    path: "/long",
    old_text: "old\n".repeat(2500),
    new_text: "中文 new\n".repeat(2500),
  };
  expect(largeDiff(payload)).toBe(true);
  render(<DiffDetails itemKey="long" diff={payload} />);
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  expect(screen.getByText(/内容较长/)).toBeVisible();
  expect(screen.queryByTestId("diff-preview")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^新内容/ }));
  expect(screen.getByTestId("new-source").textContent).toBe(payload.new_text);
  fireEvent.click(screen.getByRole("button", { name: "复制新内容" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(payload.new_text));
});
it("renderer failure stays local, offers retry and original content fallback", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <DiffDetails
      itemKey="fail"
      diff={{
        path: "/throws",
        old_text: "old exact\n",
        new_text: "new exact\n",
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "对照视图暂不可用",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看原文对照" }));
  fireEvent.click(screen.getByRole("button", { name: /^新内容/ }));
  expect(screen.getByTestId("new-source").textContent).toBe("new exact\n");
  error.mockRestore();
});

it("closing a lazy-read disclosure discards its response and reopening reads again", async () => {
  const pending: Array<(text: string) => void> = [];
  handle(
    "read_text_file",
    () => new Promise<string>((resolve) => pending.push(resolve)),
  );
  render(<DiffDetails itemKey="close" diff={null} lazyPath="/close" />);
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  await act(async () => pending[0]("discarded"));
  expect(screen.queryByTestId("diff-preview")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /文件变更/ }));
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[1]("fresh content"));
  expect(await screen.findByTestId("diff-preview")).toHaveTextContent(
    "fresh content",
  );
});
