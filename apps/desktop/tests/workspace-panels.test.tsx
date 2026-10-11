import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkspacePanels } from "../src/components/WorkspacePanels";
import { DEFAULT_LAYOUT, LayoutProvider } from "../src/lib/layout";
import { calls, handle } from "./fixtures/tauri";

it("constrains real panels, preserves narrow-window intent, and persists keyboard resize", async () => {
  let width = 1000;
  const observers: Array<{
    callback: ResizeObserverCallback;
    targets: Set<Element>;
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  function pixels(el: HTMLElement) {
    if (el.hasAttribute("data-separator")) return 4;
    if (el.hasAttribute("data-group")) return width;
    if (el.hasAttribute("data-panel")) {
      const siblings = Array.from(el.parentElement!.children).filter((e) =>
        e.hasAttribute("data-panel"),
      ) as HTMLElement[];
      const sum = siblings.reduce(
        (n, e) => n + Number(e.style.flexGrow || 0),
        0,
      );
      return sum
        ? ((width - 4) * Number(el.style.flexGrow)) / sum
        : Number.parseFloat(el.style.flexBasis) || 0;
    }
    return width;
  }
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return pixels(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
    function (this: HTMLElement) {
      const list = document.getElementById("session-list-panel");
      return this.id === "session-detail-panel"
        ? (list ? pixels(list) : 224) + 4
        : this.hasAttribute("data-separator")
          ? list
            ? pixels(list)
            : 224
          : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const w = pixels(this);
      const list = document.getElementById("session-list-panel");
      const left = this.hasAttribute("data-separator")
        ? list
          ? pixels(list)
          : 224
        : this.id === "session-detail-panel"
          ? (list ? pixels(list) : 224) + 4
          : 0;
      return {
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + w,
        bottom: 600,
        width: w,
        height: 600,
        toJSON() {},
      };
    },
  );
  const tick = async () =>
    act(async () => {
      for (const o of observers)
        o.callback(
          [...o.targets].map((target) => ({
            target,
            borderBoxSize: [
              { inlineSize: pixels(target as HTMLElement), blockSize: 600 },
            ],
          })) as unknown as ResizeObserverEntry[],
          {} as ResizeObserver,
        );
    });
  handle("save_layout_preferences", () => undefined);
  render(
    <LayoutProvider initial={{ preferences: DEFAULT_LAYOUT, error: null }}>
      <WorkspacePanels list={<button>合成会话</button>}>
        <textarea aria-label="合成草稿" />
      </WorkspacePanels>
    </LayoutProvider>,
  );
  await tick();
  await tick();
  const divider = screen.getByRole("separator", { name: "调整会话列表宽度" });
  expect(divider).toHaveAttribute("aria-orientation", "vertical");
  expect(calls).toHaveLength(0);
  width = 700;
  await tick();
  await tick();
  expect(screen.getByRole("button", { name: "显示会话列表" })).toBeDisabled();
  expect(calls).toHaveLength(0);
  width = 1000;
  await tick();
  await tick();
  expect(screen.getByRole("button", { name: "隐藏会话列表" })).toBeEnabled();
  expect(calls).toHaveLength(0);
  divider.focus();
  fireEvent.keyDown(divider, { key: "ArrowRight" });
  await tick();
  await waitFor(() =>
    expect(calls.some((c) => c.command === "save_layout_preferences")).toBe(
      true,
    ),
  );
  const saved = calls[calls.length - 1].args
    .preferences as typeof DEFAULT_LAYOUT;
  expect(saved.session_list_width).toBeGreaterThan(224);
  expect(saved.session_list_width).toBeLessThanOrEqual(400);
  expect(saved.session_list_collapsed).toBe(false);
});
