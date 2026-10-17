import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MessageMarkdown } from "../src/components/MessageMarkdown";
import { safeExternalUrl, codeSource, canHighlight, rawTextChunks } from "../src/lib/markdown";
import { streamReducer, initialStream } from "../src/lib/stream";
import { openUrl } from "@tauri-apps/plugin-opener";
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const copy = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/clipboard", () => ({
  copyText: (text: string) => copy(text),
}));

it("renders incremental Chinese, incomplete fences/table/link then matches history", async () => {
  const chunks = [
    "## 中文\n\n```ts\nconst x = '你好';",
    "\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 中文 | 1 |\n\n[资料](https://example",
    ".com/)\n",
  ];
  let state = streamReducer(initialStream, { type: "begin" });
  const view = render(<MessageMarkdown text="" active />);
  for (const text of chunks) {
    state = streamReducer(state, {
      type: "batch",
      batch: [{ type: "message_chunk", message_id: "m", text }],
    });
    const item = state.items[0];
    if (item.kind !== "message") throw new Error("wrong item");
    view.rerender(<MessageMarkdown text={item.text} active />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 130));
    });
  }
  state = streamReducer(state, {
    type: "batch",
    batch: [{ type: "turn_completed", stop_reason: "end_turn" }],
  });
  view.rerender(<MessageMarkdown text={chunks.join("")} active={false} />);
  expect(await screen.findByRole("heading", { name: "中文" })).toBeVisible();
  expect(screen.getByRole("table")).toHaveTextContent("中文");
  expect(screen.getByRole("button", { name: "资料" })).toBeVisible();
  const body = view.container.querySelector(".message-markdown")!.innerHTML;
  view.unmount();
  const history = render(
    <MessageMarkdown text={chunks.join("")} active={false} />,
  );
  await screen.findByRole("heading", { name: "中文" });
  expect(history.container.querySelector(".message-markdown")!.innerHTML).toBe(
    body,
  );
});

it("never mounts images/raw HTML or activates unsafe URLs; external open requires confirmation", async () => {
  vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
  const text =
    '<script>window.pwned=1</script>\n\n<img src="https://evil.test/x">\n\n![远端图](https://evil.test/p.png)\n\n[危险](javascript:alert%281%29) [本地](file:///tmp/x) [相对](/x) [正常](https://example.com/a?q=1)';
  const view = render(<MessageMarkdown text={text} active={false} />);
  const link = await screen.findByRole("button", { name: "正常" });
  expect(view.container.querySelector("img,script,iframe,a[href]")).toBeNull();
  expect(screen.queryByRole("button", { name: "危险" })).toBeNull();
  expect(screen.getByText(/图片：远端图/)).toBeVisible();
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(link);
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "https://example.com/a?q=1",
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(link);
  fireEvent.click(screen.getByRole("button", { name: "在浏览器打开" }));
  await waitFor(() =>
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a?q=1"),
  );
  for (const url of [
    "//evil.test",
    "https://u:p@example.com",
    "https://example.com/\nfoo",
    " data:text/html,x",
    "https:example.com",
    "mailto:x@y.com",
  ])
    expect(safeExternalUrl(url)).toBeNull();
});

it("copies code exactly, preserves entire source on toggle, and bounds expensive rendering", async () => {
  copy.mockClear();
  const text = '原文中文\n\n```json\n{"a":1}\n\n```\n';
  const view = render(<MessageMarkdown text={text} active={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "复制代码" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith('{"a":1}\n\n'));
  fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
  expect(view.container.querySelector("pre")!.textContent).toBe(text);
  fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(text));
  fireEvent.click(screen.getByRole("button", { name: "返回排版" }));
  expect(await screen.findByRole("button", { name: "复制代码" })).toBeVisible();
  view.rerender(<MessageMarkdown text={"中".repeat(33000)} active />);
  expect(screen.getByText(/长消息/)).toBeVisible();
  await waitFor(() => expect(view.container.querySelector("pre")!.textContent).toHaveLength(33000));
  expect(screen.queryByRole("button", { name: "高亮代码" })).toBeNull();
  expect(
    codeSource("```py\nprint(1)\n", {
      start: { offset: 0 },
      end: { offset: 15 },
    }),
  ).toBe("print(1)\n");
});

it("loads highlighting only on demand and never for active or oversized code", async () => {
  const view = render(
    <MessageMarkdown text={'```json\n{"ok":true}\n```'} active />,
  );
  await screen.findByRole("button", { name: "复制代码" });
  expect(screen.queryByRole("button", { name: "高亮代码" })).toBeNull();
  view.rerender(
    <MessageMarkdown text={'```json\n{"ok":true}\n```'} active={false} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "高亮代码" }));
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-highlighted="true"]'),
    ).not.toBeNull(),
  );
  expect(view.container.querySelector("code")!.textContent).toBe(
    '{"ok":true}\n',
  );
  view.rerender(
    <MessageMarkdown
      text={"```json\n" + "x\n".repeat(201) + "```"}
      active={false}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector("code")!.textContent).toHaveLength(402),
  );
  expect(screen.queryByRole("button", { name: "高亮代码" })).toBeNull();
});

it("does not starve sustained stream parsing or remount finished message DOM", async () => {
  const view = render(
    <>
      <MessageMarkdown text="## 已完成" active={false} />
      <MessageMarkdown text="" active />
    </>,
  );
  const heading = await screen.findByRole("heading", { name: "已完成" });
  for (let i = 1; i <= 6; i++) {
    view.rerender(
      <>
        <MessageMarkdown text="## 已完成" active={false} />
        <MessageMarkdown text={"增量".repeat(i)} active />
      </>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
  }
  expect(screen.getByRole("heading", { name: "已完成" })).toBe(heading);
  expect(
    view.container.querySelectorAll(".message-markdown")[1].textContent!.length,
  ).toBeGreaterThan(4);
});

it("shows copy/open failures in place and keeps complete oversized history", async () => {
  copy.mockRejectedValueOnce(new Error("denied"));
  vi.mocked(openUrl).mockRejectedValueOnce(new Error("denied"));
  const view = render(
    <MessageMarkdown text="[访问](https://example.com/)" active={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
  expect(await screen.findByText("复制失败，请选择原文复制")).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "访问" }));
  fireEvent.click(screen.getByRole("button", { name: "在浏览器打开" }));
  expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("打开失败");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  view.rerender(<MessageMarkdown text={"中".repeat(132000)} active={false} />);
  expect(view.container.querySelector("pre")!.textContent).toHaveLength(132000);
});

it("copies fenced content with CRLF, quote/list indentation and empty trailing lines", async () => {
  const cases = [
    ["```ts\r\nx\r\n\r\n```", "x\r\n\r\n"],
    ["> ```ts\n> x\n> ```", "x\n"],
    ["- ```ts\n  x\n  ```", "x\n"],
  ];
  for (const [text, expected] of cases) {
    copy.mockClear();
    const view = render(<MessageMarkdown text={text} active={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(expected));
    view.unmount();
  }
});

it("enforces highlight line and language limits", () => {
  expect(canHighlight(Array(201).fill("x").join("\n"), "json")).toBe(false);
  expect(canHighlight("x\n".repeat(200), "json")).toBe(true);
  expect(canHighlight("x", "unknown")).toBe(false);
});

it("reports actual clipboard fallback failure and restores focus without leaking a textarea", async () => {
  const { copyText } = await vi.importActual<
    typeof import("../src/lib/clipboard")
  >("../src/lib/clipboard");
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn().mockRejectedValue(new Error("unavailable")),
    },
  });
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => false),
  });
  try {
    await expect(copyText("完整中文")).rejects.toThrow("Clipboard unavailable");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  } finally {
    button.remove();
    delete (document as Partial<Document>).execCommand;
  }
});

it("bounds growing stream parsing without losing source and restores completed Markdown", async () => {
  const text = "# 流式预算\n\n" + "中文内容 ".repeat(1900);
  const view = render(<MessageMarkdown text={text} active />);
  expect(view.container.querySelector("pre")!.textContent).toBe(text);
  expect(screen.queryByRole("heading", { name: "流式预算" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
  await waitFor(() => expect(copy).toHaveBeenLastCalledWith(text));
  view.rerender(<MessageMarkdown text={text} active={false} />);
  expect(await screen.findByRole("heading", { name: "流式预算" })).toBeVisible();
});

it("coalesces raw streaming layout updates and flushes all content at completion", () => {
  vi.useFakeTimers();
  try {
    const initial = "中".repeat(9000);
    const view = render(<MessageMarkdown text={initial} active />);
    view.rerender(<MessageMarkdown text={initial + "第一批"} active />);
    expect(view.container.querySelector("pre")!.textContent).toBe(initial);
    act(() => { vi.advanceTimersByTime(100); });
    expect(view.container.querySelector("pre")!.textContent).toBe(initial + "第一批");
    view.rerender(<MessageMarkdown text={initial + "第一批第二批"} active />);
    view.rerender(<MessageMarkdown text={initial + "第一批第二批"} active={false} />);
    fireEvent.click(screen.getByRole("button", { name: "查看原文" }));
    expect(view.container.querySelector("pre")!.textContent).toBe(initial + "第一批第二批");
  } finally { vi.useRealTimers(); }
});

it("keeps raw chunks lossless and stable at newline boundaries while appending Unicode", () => {
  const prefix = "中文🙂\n".repeat(1000);
  const before = rawTextChunks(prefix);
  const after = rawTextChunks(prefix + "追加🙂\n");
  expect(before.join("")).toBe(prefix);
  expect(after.join("")).toBe(prefix + "追加🙂\n");
  expect(after[0]).toBe(before[0]);
  expect(rawTextChunks("🙂".repeat(5000))).toEqual(["🙂".repeat(5000)]);
});
