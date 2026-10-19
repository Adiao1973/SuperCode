import { Component, useEffect, useRef, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import DiffPreview from "../src/components/DiffPreview";
const fixture = vi.hoisted(() => ({ ready: false }));
vi.mock("../src/lib/appearance", () => ({
  useAppearance: () => ({ resolved: "light" }),
}));
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    options,
  }: {
    options: { onPostRender: (node: HTMLElement) => void };
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const node = ref.current!;
      const root = node.attachShadow({ mode: "open" });
      if (fixture.ready) root.innerHTML = "<pre><code>rendered</code></pre>";
      options.onPostRender(node);
    }, []);
    return <div ref={ref} />;
  },
}));
class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">local failure</p>
    ) : (
      this.props.children
    );
  }
}
const payload = { path: "/fixture", old_text: "a", new_text: "b" };
it("shows initialization instead of blank diff, then times out into the local recovery boundary", async () => {
  vi.useFakeTimers();
  fixture.ready = false;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <Catch>
      <DiffPreview payload={payload} />
    </Catch>,
  );
  expect(screen.getByRole("status")).toHaveTextContent("正在生成变更对照");
  await act(async () => vi.advanceTimersByTime(5000));
  expect(screen.getByRole("alert")).toHaveTextContent("local failure");
  errors.mockRestore();
});
it("a populated renderer clears initialization and cancels its deadline", async () => {
  vi.useFakeTimers();
  fixture.ready = true;
  const view = render(
    <Catch>
      <DiffPreview payload={payload} />
    </Catch>,
  );
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
