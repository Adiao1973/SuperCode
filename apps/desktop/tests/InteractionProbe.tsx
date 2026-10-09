/** Test-method probe, NOT the product composer or theme implementation. */
import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { Textarea } from "../src/components/ui/textarea";

export const darkQuery = "(prefers-color-scheme: dark)";
export const reduceQuery = "(prefers-reduced-motion: reduce)";
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
export function InteractionProbe() {
  const dark = useMedia(darkQuery),
    reduced = useMedia(reduceQuery);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(0);
  const [composing, setComposing] = useState(false);
  return (
    <main
      data-theme={dark ? "dark" : "light"}
      data-reduced={reduced}
      style={{
        padding: 32,
        color: dark ? "#eee" : "#161616",
        background: dark ? "#171717" : "#fff",
        minHeight: "100vh",
      }}
    >
      <h1>前端交互测试样例</h1>
      <p>仅用于验证测试方法；无 IPC、模型调用、数据库与任务执行。</p>
      <p role="status" aria-label="系统偏好">
        系统主题：{dark ? "深色" : "浅色"}；减少动态：
        {reduced ? "开启" : "关闭"}
      </p>
      <label htmlFor="fixture-input">合成输入</label>
      <Textarea
        id="fixture-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !composing &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            setSubmitted((n) => n + 1);
          }
        }}
      />
      <p>组合输入：{composing ? "进行中" : "结束"}</p>
      <p>
        合成提交次数：<output aria-label="合成提交次数">{submitted}</output>
      </p>
      <Dialog.Root>
        <Dialog.Trigger>打开焦点测试</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay
            style={{ position: "fixed", inset: 0, background: "#0007" }}
          />
          <Dialog.Content
            style={{
              position: "fixed",
              top: "25%",
              left: "25%",
              width: "50%",
              padding: 24,
              background: "white",
              color: "black",
            }}
          >
            <Dialog.Title>焦点测试</Dialog.Title>
            <Dialog.Description>
              Tab 应在两按钮间循环，Esc 关闭并回到触发按钮。
            </Dialog.Description>
            <Dialog.Close>返回</Dialog.Close>
            <button onClick={() => setSubmitted((n) => n + 1)}>
              增加合成计数
            </button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
