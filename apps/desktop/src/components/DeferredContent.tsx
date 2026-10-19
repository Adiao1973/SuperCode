import { Component, Suspense, type ReactNode } from "react";
class LoadingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">组件加载失败，请重启应用重试。</p> : this.props.children;
  }
}
export function DeferredContent({ children }: { children: ReactNode }) {
  return <LoadingBoundary><Suspense fallback={<p role="status">加载中…</p>}>{children}</Suspense></LoadingBoundary>;
}
