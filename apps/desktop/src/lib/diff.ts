/**
 * 最小 unified git patch 生成器（P1-4）。
 * @git-diff-view 的 DiffParser 以标准 git patch 为输入（其传统格式），
 * 我们从 DiffPayload 的原始新旧内容在客户端生成 patch。
 * 算法：去公共前后缀后对中段做 LCS（规模超限退化为整块替换），带 ±3 行上下文。
 */

/** LCS 编辑脚本：' ' 保留 | '-' 删除 | '+' 新增 */
function diffOps(
  oldLines: string[],
  newLines: string[],
): Array<{ type: " " | "-" | "+"; text: string }> {
  const n = oldLines.length;
  const m = newLines.length;
  // 中段过大时退化为整块替换（LDP 表 n*m 过大）
  if (n * m > 250_000) {
    return [
      ...oldLines.map((text) => ({ type: "-" as const, text })),
      ...newLines.map((text) => ({ type: "+" as const, text })),
    ];
  }
  // dp[i][j] = old[i..] 与 new[j..] 的最长公共子序列长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ type: " " | "-" | "+"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: " ", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "-", text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "+", text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", text: oldLines[i++] });
  while (j < m) ops.push({ type: "+", text: newLines[j++] });
  return ops;
}

/** 生成标准 git unified patch；内容完全相同时返回空串 */
export function unifiedPatch(
  path: string,
  oldText: string | null | undefined,
  newText: string,
): string {
  const oldLines = oldText ? oldText.replace(/\n$/, "").split("\n") : [];
  const newLines = newText.replace(/\n$/, "").split("\n");

  // 公共前后缀裁剪
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  if (endOld === start && endNew === start) {
    return ""; // 无差异
  }

  const ctx = 3;
  const ctxStart = Math.max(0, start - ctx);
  const ctxEndOld = Math.min(oldLines.length, endOld + ctx);
  const ctxEndNew = Math.min(newLines.length, endNew + ctx);

  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    oldText == null ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldLines.length ? ctxStart + 1 : 0},${ctxEndOld - ctxStart} +${newLines.length ? ctxStart + 1 : 0},${ctxEndNew - ctxStart} @@`,
  ];
  for (let k = ctxStart; k < start; k++) lines.push(` ${oldLines[k]}`);
  for (const op of diffOps(oldLines.slice(start, endOld), newLines.slice(start, endNew))) {
    lines.push(`${op.type}${op.text}`);
  }
  for (let k = start; k < ctxEndOld; k++) lines.push(` ${oldLines[k]}`);
  return lines.join("\n");
}
