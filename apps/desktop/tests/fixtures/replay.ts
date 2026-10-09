import type { AgentEvent } from "../../src/lib/events";

export interface Frame {
  at: number;
  batch: AgentEvent[];
}
/** Explicit virtual milliseconds: no wall-clock timers or random ids. */
export function replay(
  frames: readonly Frame[],
  receive: (batch: AgentEvent[]) => void,
) {
  if (frames.some((f, i) => f.at < 0 || (i > 0 && f.at < frames[i - 1].at))) {
    throw new Error("Fixture frames must be ordered and nonnegative");
  }
  let index = 0,
    time = 0,
    stopped = false;
  return {
    advanceTo(next: number) {
      if (next < time) throw new Error("Fixture clock cannot go backwards");
      time = next;
      while (!stopped && index < frames.length && frames[index].at <= time) {
        receive(structuredClone(frames[index++].batch));
      }
    },
    stop() {
      stopped = true;
    },
  };
}
export const conversation: readonly Frame[] = [
  { at: 0, batch: [{ type: "session_started", session_id: "fixture-acp-a" }] },
  {
    at: 50,
    batch: [{ type: "message_chunk", message_id: "reply", text: "你好，" }],
  },
  {
    at: 100,
    batch: [{ type: "message_chunk", message_id: "reply", text: "世界。" }],
  },
  { at: 150, batch: [{ type: "turn_completed", stop_reason: "end_turn" }] },
];
