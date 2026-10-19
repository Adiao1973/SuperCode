import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { expect, it, vi } from "vitest";
import {
  createReadingMemory,
  noteTimelineUpdate,
  initialLocation,
  nearBottom,
  captureReadingAnchor,
} from "../src/lib/reading";
import {
  MessageTimeline,
  TimelineDisclosure,
} from "../src/components/MessageTimeline";
import {
  streamReducer,
  initialStream,
  type StreamItem,
} from "../src/lib/stream";
import type { AgentEvent } from "../src/lib/events";

const message = (key: string): StreamItem => ({
  key,
  id: key,
  kind: "message",
  text: `正文 ${key}`,
  active: false,
});
it("keeps reading intent across updates and restores by key when counts change", () => {
  const memory = createReadingMemory();
  const items = [message("a"), message("b")];
  noteTimelineUpdate(memory, items);
  expect(initialLocation(memory, items)).toEqual({ index: 1, align: "end" });
  memory.following = false;
  memory.anchor = { key: "a", offset: -12 };
  noteTimelineUpdate(memory, [...items, message("c")]);
  expect(memory.unread).toBe(true);
  expect(initialLocation(memory, [...items, message("c")])).toEqual({
    index: 0,
    align: "start",
    offset: 12,
  });
  noteTimelineUpdate(memory, [message("new-run")]);
  expect(memory.following).toBe(true);
  expect(memory.unread).toBe(false);
  expect(memory.anchor).toBeNull();
  expect(nearBottom(77, 200, 100)).toBe(true);
  expect(nearBottom(70, 200, 100)).toBe(false);
});
it("1000 mixed items + sustained 20Hz preserve finished references and detect active text updates off-bottom", () => {
  const events: AgentEvent[] = Array.from(
    { length: 250 },
    (_, i) =>
      [
        { type: "message_chunk", message_id: `m${i}`, text: `正文中文 ${i}` },
        { type: "thought_chunk", message_id: `t${i}`, text: `思考 ${i}` },
        {
          type: "tool_call",
          tool_call_id: `tool${i}`,
          kind: "read",
          name: "read",
          title: `文件 ${i}`,
        },
        { type: "turn_completed", stop_reason: "end_turn" },
      ] as AgentEvent[],
  ).flat();
  let state = streamReducer(initialStream, { type: "batch", batch: events });
  expect(state.items).toHaveLength(1000);
  const first = state.items[0];
  const memory = createReadingMemory();
  noteTimelineUpdate(memory, state.items);
  memory.following = false;
  memory.anchor = { key: first.key, offset: -8 };
  for (let i = 0; i < 600; i++) {
    state = streamReducer(state, {
      type: "batch",
      batch: [
        { type: "message_chunk", message_id: "active", text: `${i} 中文\n` },
      ],
    });
    noteTimelineUpdate(memory, state.items);
  }
  expect(state.items[0]).toBe(first);
  expect(memory.unread).toBe(true);
  expect(memory.anchor).toEqual({ key: first.key, offset: -8 });
  expect(state.items).toHaveLength(1001);
});
it("disclosures retain full copyable contents and expansion across virtual unmounts", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const memory = createReadingMemory();
  const items = [message("a")];
  const text = "完整中文\n第二行\n" + "长内容".repeat(400);
  function Host() {
    return (
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 500, itemHeight: 100 }}
      >
        <MessageTimeline
          items={items}
          memory={memory}
          visible
          renderItem={(item) => (
            <TimelineDisclosure itemKey={item.key} summary="思考摘要">
              <pre>{text}</pre>
            </TimelineDisclosure>
          )}
        />
      </VirtuosoMockContext.Provider>
    );
  }
  const first = render(<Host />);
  const trigger = await screen.findByRole("button", { name: "思考摘要" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/完整中文/)).toBeNull();
  fireEvent.click(trigger);
  expect(screen.getByText(/完整中文/).textContent).toBe(text);
  expect(memory.expanded.has("a")).toBe(true);
  first.unmount();
  const second = render(<Host />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "思考摘要" })).toHaveAttribute(
      "aria-expanded",
      "true",
    ),
  );
  expect(screen.getByText(/完整中文/).textContent).toBe(text);
  second.unmount();
});
it("off-bottom updates expose one new-message action and explicit jump resumes following", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const memory = createReadingMemory();
  const items = [message("a")];
  noteTimelineUpdate(memory, items);
  memory.following = false;
  const view = render(
    <VirtuosoMockContext.Provider
      value={{ viewportHeight: 500, itemHeight: 100 }}
    >
      <MessageTimeline
        items={items}
        memory={memory}
        visible
        renderItem={(item) => <p>{item.kind === "message" ? item.text : ""}</p>}
      />
    </VirtuosoMockContext.Provider>,
  );
  view.rerender(
    <VirtuosoMockContext.Provider
      value={{ viewportHeight: 500, itemHeight: 100 }}
    >
      <MessageTimeline
        items={[...items, message("b")]}
        memory={memory}
        visible
        renderItem={(item) => <p>{item.key}</p>}
      />
    </VirtuosoMockContext.Provider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "新消息 · 回到底部" }),
  );
  expect(memory.following).toBe(true);
  expect(memory.unread).toBe(false);
});

it("captures the first intersecting virtual row and preserves its relative offset", () => {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "clientHeight", { value: 100 });
  scroller.getBoundingClientRect = () => ({ top: 20 } as DOMRect);
  for (const [key, top, bottom] of [["above", -80, 10], ["reading", 10, 60], ["below", 130, 180]] as const) {
    const row = document.createElement("div");
    row.dataset.timelineKey = key;
    row.getBoundingClientRect = () => ({ top, bottom } as DOMRect);
    scroller.append(row);
  }
  expect(captureReadingAnchor(scroller)).toEqual({ key: "reading", offset: -10 });
});
