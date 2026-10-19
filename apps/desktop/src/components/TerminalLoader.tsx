import { Component, Suspense, lazy, type ReactNode } from "react";
import { Button } from "./ui/button";
import { LoadingState } from "./FeedbackState";

const Terminal = lazy(() => import("./SessionTerminal").then(module => ({ default: module.SessionTerminal })));
class TerminalBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="p-3 text-sm"><p role="alert">终端组件加载失败，请关闭后重试。</p><Button variant="outline" size="sm" onClick={this.props.onClose}>关闭终端</Button></div>;
    return this.props.children;
  }
}
/** Keep the xterm runtime off the initial import graph; closing cancels mounting. */
export function SessionTerminal(props: { cwd: string; onClose: () => void }) {
  return <TerminalBoundary onClose={props.onClose}><Suspense fallback={<div className="p-3"><LoadingState label="正在加载终端…" /></div>}><Terminal {...props} /></Suspense></TerminalBoundary>;
}
