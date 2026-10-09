import { describe, expect, it } from "vitest";
import { beginRun, streamReducer } from "../src/lib/stream";
import { conversation, replay } from "./fixtures/replay";

describe("deterministic event replay", () => {
  it("retains batch boundaries and joins Chinese chunks before closing the turn", () => {
    let state = beginRun();
    const sizes: number[] = [];
    const run = replay(conversation, (batch) => {
      sizes.push(batch.length);
      state = streamReducer(state, { type: "batch", batch });
    });
    run.advanceTo(99);
    expect(state.running).toBe(true);
    expect(state.items).toMatchObject([
      { kind: "message", text: "你好，", active: true },
    ]);
    run.advanceTo(150);
    expect(state.items).toMatchObject([
      { kind: "message", text: "你好，世界。", active: false },
      { kind: "turn_end", stopReason: "end_turn" },
    ]);
    expect(state.running).toBe(false);
    expect(sizes).toEqual([1, 1, 1, 1]);
    run.advanceTo(1000);
    expect(sizes).toHaveLength(4);
  });
  it("stops future delivery after cancellation or component cleanup", () => {
    const received: unknown[] = [];
    const run = replay(conversation, (batch) => received.push(batch));
    run.advanceTo(50);
    run.stop();
    run.advanceTo(1000);
    expect(received).toHaveLength(2);
    expect(() => run.advanceTo(0)).toThrow("backwards");
    expect(() => replay([...conversation].reverse(), () => {})).toThrow(
      "ordered",
    );
  });
  it("closes active text on driver failure without mutating the earlier snapshot", () => {
    const before = streamReducer(beginRun(), {
      type: "batch",
      batch: [{ type: "thought_chunk", message_id: "t", text: "分析" }],
    });
    const after = streamReducer(before, {
      type: "batch",
      batch: [{ type: "driver_error", message: "fixture failure" }],
    });
    expect(before.items[0]).toMatchObject({ active: true });
    expect(after.items).toMatchObject([
      { active: false },
      { kind: "error", message: "fixture failure" },
    ]);
    expect(after.running).toBe(false);
  });
  it("keeps completed items stable while a later response streams", () => {
    let state = streamReducer(beginRun(), {
      type: "batch",
      batch: conversation.flatMap((f) => f.batch),
    });
    const completed = state.items[0];
    state = streamReducer(state, {
      type: "batch",
      batch: [{ type: "message_chunk", message_id: "reply", text: "下一轮" }],
    });
    expect(state.items[0]).toBe(completed);
    expect(state.items[2]).toMatchObject({ text: "下一轮", active: true });
  });
});
