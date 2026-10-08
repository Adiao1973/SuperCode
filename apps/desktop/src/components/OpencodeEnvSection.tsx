/**
 * 设置页「opencode 环境」区块（P1-7）：安装状态 + 默认模型检查 + 严格模式引导。
 * 全局视角（cwd=null）；项目级严格检查在每个会话的运行框里按 cwd 联检。
 * 引导片段始终可见可复制（验收要求），状态行只做事实提示。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableBlock } from "@/components/CopyableBlock";
import {
  INSTALL_GUIDE,
  JURISDICTION_NOTE,
  LEVEL_LABEL,
  MODEL_GUIDE,
  checkOpencodeEnv,
  strictGuideSnippet,
  type OpencodeEnvReport,
} from "@/lib/opencode-env";
import { Loader2, RefreshCw } from "lucide-react";

function LevelChip({ label, level }: { label: string; level: OpencodeEnvReport["global_edit"] }) {
  const info = LEVEL_LABEL[level];
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className={info.ok ? "border-emerald-500/50 text-emerald-500" : "border-amber-500/50 text-amber-500"}>
        {info.text}
      </Badge>
    </span>
  );
}

export function OpencodeEnvSection() {
  const [report, setReport] = useState<OpencodeEnvReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await checkOpencodeEnv(null));
    } catch {
      // 探测命令异常时保持旧报告；设置页不弹错误打断
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">opencode 环境</h2>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground h-6 px-2"
          onClick={() => void refresh()}
          disabled={loading}
          title="重新检测"
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-md border px-3 py-3">
        {/* 安装状态 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge
            variant="outline"
            className={
              report?.installed
                ? "border-emerald-500/50 text-emerald-500"
                : "border-destructive/50 text-destructive"
            }
          >
            {report == null ? "检测中…" : report.installed ? `已安装 v${report.version ?? "?"}` : "未安装"}
          </Badge>
          {report?.bin_path && <code className="text-muted-foreground text-[11px]">{report.bin_path}</code>}
          {report?.probe_error && <span className="text-destructive text-[11px]">{report.probe_error}</span>}
        </div>
        <CopyableBlock text={INSTALL_GUIDE} label="安装指引（未安装时需要；macOS / Linux）" />

        {/* 默认模型检查（P0-4：opencode acp 不继承 auth 默认模型） */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground text-[11px]">默认模型</span>
          {report?.global_model ? (
            <code className="text-[11px]">{report.global_model}</code>
          ) : (
            <span className="text-amber-500 text-[11px]">
              未设置——opencode acp 不继承 auth 默认模型，将回退免费模型（可能受到限流）
            </span>
          )}
        </div>
        <CopyableBlock text={MODEL_GUIDE} label="默认模型指引（写入后重启 SuperCode 生效）" />

        {/* 严格模式引导（ADR-0006 管辖边界） */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground text-[11px]">严格模式（全局）</span>
          {report && (
            <>
              <LevelChip label="edit" level={report.global_edit} />
              <LevelChip label="bash" level={report.global_bash} />
              <Badge
                variant="outline"
                className={report.strict ? "border-emerald-500/50 text-emerald-500" : "border-amber-500/50 text-amber-500"}
              >
                {report.strict ? "已收紧" : "宽松"}
              </Badge>
            </>
          )}
        </div>
        <CopyableBlock text={strictGuideSnippet(null)} label="严格模式指引（写入会话工作目录后点运行框的「重新检测」）" />
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          {JURISDICTION_NOTE}
          {report?.config_error && <span className="text-destructive"> · 配置解析失败：{report.config_error}</span>}
        </p>
      </div>
    </section>
  );
}
