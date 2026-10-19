import type { PendingPermission } from "../../src/lib/permissions";
export function pending(
  session = "fixture-acp-a",
  id = "fixture-request-a",
): PendingPermission {
  return {
    id,
    request: {
      session_id: session,
      tool_call_id: "same-tool",
      tool_name: "edit",
      kind: "edit",
      raw_input: { path: "/fixture/todo.ts", content: "合成内容" },
      options: [
        { option_id: "yes", kind: "allow_once", name: "允许一次" },
        { option_id: "no", kind: "reject_once", name: "拒绝" },
      ],
    },
  };
}
