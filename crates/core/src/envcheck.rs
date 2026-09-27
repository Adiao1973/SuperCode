//! opencode 环境探测（P1-7，docs/architecture.md §4.7）。
//!
//! 只产事实，引导文案由宿主前端负责；全程只读，绝不代改用户配置
//! （"自动写入托管配置"留待后续评估，见 ADR-0006 实证记录）。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tokio::time::{Duration, timeout};

/// 版本探测超时：CLI 卡死（网络盘 PATH、坏壳脚本）不得拖住调用方。
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// opencode 权限条目的解析结果。NotConfigured 按 opencode 默认语义 = 放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    /// 配置存在但未写该键（opencode 默认放行 bash/edit）
    NotConfigured,
    Allow,
    Ask,
    Deny,
    /// pattern 对象且无 `"*"` 通配——用户显式配置过，不判定宽松
    Custom,
    /// 值形态不可识别（非已知字符串/对象）
    Unparseable,
}

impl PermissionLevel {
    fn is_strict(self) -> bool {
        matches!(self, Self::Ask | Self::Deny | Self::Custom)
    }
}

/// opencode 环境报告（§4.7）——字段即事实，供前端渲染引导。
#[derive(Debug, Clone, Serialize)]
pub struct OpencodeEnvReport {
    pub installed: bool,
    pub version: Option<String>,
    pub bin_path: Option<String>,
    pub probe_error: Option<String>,
    pub global_config_path: Option<String>,
    pub global_model: Option<String>,
    pub global_edit: PermissionLevel,
    pub global_bash: PermissionLevel,
    /// cwd=None 时项目侧字段保持未配置
    pub project_config_path: Option<String>,
    pub project_edit: PermissionLevel,
    pub project_bash: PermissionLevel,
    /// 有效 edit ∧ bash 均 ∈ {ask, deny, custom}（项目覆盖全局）
    pub strict: bool,
    /// 配置存在但 JSONC 解析失败的原因
    pub config_error: Option<String>,
}

/// 探测 opencode 环境。cwd=Some 时附检 `<cwd>/opencode.json(c)` 项目级配置。
pub async fn check(cwd: Option<&Path>) -> OpencodeEnvReport {
    let (installed, version, bin_path, probe_error) = match find_in_path("opencode", &path_var()) {
        Some(bin) => match probe_version(&bin).await {
            Ok(v) => (true, Some(v), Some(bin.display().to_string()), None),
            Err(e) => (true, None, Some(bin.display().to_string()), Some(e)),
        },
        None => (
            false,
            None,
            None,
            Some("PATH 中未找到 opencode 可执行文件".to_string()),
        ),
    };

    let mut config_error = None;
    let (global_config_path, global_model, global_edit, global_bash) =
        match global_config_dir().and_then(|dir| config_file_in(&dir)) {
            Some(path) => match read_config(&path).await {
                Ok(config) => (
                    Some(path.display().to_string()),
                    model_of(&config),
                    permission_level(&config, "edit"),
                    permission_level(&config, "bash"),
                ),
                Err(e) => {
                    config_error = Some(format!("{}：{e}", path.display()));
                    (
                        Some(path.display().to_string()),
                        None,
                        PermissionLevel::NotConfigured,
                        PermissionLevel::NotConfigured,
                    )
                }
            },
            None => (
                None,
                None,
                PermissionLevel::NotConfigured,
                PermissionLevel::NotConfigured,
            ),
        };

    let (project_config_path, project_edit, project_bash) = match cwd {
        Some(cwd) => match config_file_in(cwd) {
            Some(path) => match read_config(&path).await {
                Ok(config) => (
                    Some(path.display().to_string()),
                    permission_level(&config, "edit"),
                    permission_level(&config, "bash"),
                ),
                Err(e) => {
                    // 两个配置同时坏时合并报错，不留静默
                    config_error = match config_error.take() {
                        Some(prev) => Some(format!("{prev}; {}：{e}", path.display())),
                        None => Some(format!("{}：{e}", path.display())),
                    };
                    (
                        Some(path.display().to_string()),
                        PermissionLevel::NotConfigured,
                        PermissionLevel::NotConfigured,
                    )
                }
            },
            None => (
                None,
                PermissionLevel::NotConfigured,
                PermissionLevel::NotConfigured,
            ),
        },
        None => (
            None,
            PermissionLevel::NotConfigured,
            PermissionLevel::NotConfigured,
        ),
    };

    let effective_edit = effective(project_edit, global_edit);
    let effective_bash = effective(project_bash, global_bash);
    OpencodeEnvReport {
        installed,
        version,
        bin_path,
        probe_error,
        global_config_path,
        global_model,
        global_edit,
        global_bash,
        project_config_path,
        project_edit,
        project_bash,
        strict: effective_edit.is_strict() && effective_bash.is_strict(),
        config_error,
    }
}

/// 项目的显式配置覆盖全局；项目未写该键（NotConfigured）时落到全局。
fn effective(project: PermissionLevel, global: PermissionLevel) -> PermissionLevel {
    if project == PermissionLevel::NotConfigured {
        global
    } else {
        project
    }
}

/// 在 PATH 逐目录扫描名为 `name` 的可执行文件（unix 校验可执行位）。
fn find_in_path(name: &str, path_var: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(&path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file())
        .unwrap_or(false)
}

fn path_var() -> std::ffi::OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

/// `<version>`（首行，容忍 `opencode x.y.z` 等前缀形态）。
async fn probe_version(bin: &Path) -> Result<String, String> {
    let output = timeout(
        VERSION_TIMEOUT,
        tokio::process::Command::new(bin).arg("--version").output(),
    )
    .await
    .map_err(|_| format!("--version 超时（>{:?}）", VERSION_TIMEOUT))?
    .map_err(|e| format!("执行失败：{e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| "--version 无输出".to_string())?;
    Ok(line.trim_start_matches("opencode ").trim().to_string())
}

/// 全局配置目录：`$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`。
/// 注意 opencode 在 macOS 也用 XDG 风格路径，不能用 dirs::config_dir()（那是 Library/Application Support）。
fn global_config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let dir = PathBuf::from(xdg);
        if dir.is_absolute() {
            return Some(dir.join("opencode"));
        }
    }
    dirs::home_dir().map(|home| home.join(".config").join("opencode"))
}

/// 目录下 `opencode.jsonc` 优先，其次 `opencode.json`（opencode 的发现顺序）。
fn config_file_in(dir: &Path) -> Option<PathBuf> {
    ["opencode.jsonc", "opencode.json"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

async fn read_config(path: &Path) -> Result<Value, String> {
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| format!("读取失败：{e}"))?;
    // JSONC：注释与尾逗号；json5 正确处理字符串内的 "//"（$schema URL 必须存活）
    json5::from_str(&text).map_err(|e| format!("JSONC 解析失败：{e}"))
}

fn model_of(config: &Value) -> Option<String> {
    config
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `permission.<key>` 的级别：字符串直接映射；对象取 `"*"` 键递归（无则 Custom）；
/// 顶层 permission 为字符串视为对全部键生效的简写；缺失为 NotConfigured。
fn permission_level(config: &Value, key: &str) -> PermissionLevel {
    match config.get("permission") {
        None | Some(Value::Null) => PermissionLevel::NotConfigured,
        Some(Value::String(text)) => level_of_str(text),
        Some(Value::Object(map)) => match map.get(key) {
            None | Some(Value::Null) => PermissionLevel::NotConfigured,
            Some(Value::String(text)) => level_of_str(text),
            Some(Value::Object(patterns)) => match patterns.get("*") {
                Some(Value::String(text)) => level_of_str(text),
                Some(_) => PermissionLevel::Unparseable,
                None => PermissionLevel::Custom,
            },
            Some(_) => PermissionLevel::Unparseable,
        },
        Some(_) => PermissionLevel::Unparseable,
    }
}

fn level_of_str(text: &str) -> PermissionLevel {
    match text.trim().to_ascii_lowercase().as_str() {
        "allow" => PermissionLevel::Allow,
        "ask" => PermissionLevel::Ask,
        "deny" => PermissionLevel::Deny,
        _ => PermissionLevel::Unparseable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn find_in_path_skips_nonexistent_and_non_executable() {
        let tmp = TempDir::new();
        // 目录在 PATH 里但无可执行文件 → 未找到
        assert_eq!(find_in_path("opencode", tmp.path().as_os_str()), None);

        // 存在但无可执行位 → 未找到（unix）
        let plain = tmp.path().join("opencode");
        std::fs::File::create(&plain).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(find_in_path("opencode", tmp.path().as_os_str()), None);
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            find_in_path("opencode", tmp.path().as_os_str()),
            Some(plain)
        );
    }

    #[test]
    fn jsonc_parse_survives_comments_and_schema_url() {
        // $schema 的 URL 含 "//"，朴素剥离注释会把它砍断——必须走 json5
        let text = r#"{
            // 默认模型固定
            "$schema": "https://opencode.ai/config.json", // 行尾注释
            /* 块注释 */
            "model": "zhipuai-coding-plan/glm-5.3-flash",
            "permission": {
                "edit": "ask",
                "bash": {
                    "git status": "allow", // 尾逗号
                    "*": "ask",
                },
            },
        }"#;
        let config: Value = json5::from_str(text).unwrap();
        assert_eq!(
            model_of(&config).as_deref(),
            Some("zhipuai-coding-plan/glm-5.3-flash")
        );
        assert_eq!(permission_level(&config, "edit"), PermissionLevel::Ask);
        // 对象带 "*" → 取通配值
        assert_eq!(permission_level(&config, "bash"), PermissionLevel::Ask);
    }

    #[test]
    fn permission_levels_matrix() {
        let missing: Value = serde_json::json!({});
        assert_eq!(
            permission_level(&missing, "edit"),
            PermissionLevel::NotConfigured
        );

        // 字符串简写对全部键生效
        let shorthand = serde_json::json!({ "permission": "deny" });
        assert_eq!(permission_level(&shorthand, "edit"), PermissionLevel::Deny);
        assert_eq!(permission_level(&shorthand, "bash"), PermissionLevel::Deny);

        // 对象无 "*" → Custom（显式 pattern 配置，不判定宽松）
        let patterns = serde_json::json!({ "permission": { "bash": { "git push": "ask" } } });
        assert_eq!(permission_level(&patterns, "bash"), PermissionLevel::Custom);
        assert_eq!(
            permission_level(&patterns, "edit"),
            PermissionLevel::NotConfigured
        );

        // 未知字符串与畸形值 → Unparseable
        let unknown = serde_json::json!({ "permission": { "edit": "sometimes" } });
        assert_eq!(
            permission_level(&unknown, "edit"),
            PermissionLevel::Unparseable
        );
        let malformed = serde_json::json!({ "permission": { "bash": 3 } });
        assert_eq!(
            permission_level(&malformed, "bash"),
            PermissionLevel::Unparseable
        );
    }

    #[test]
    fn effective_project_overrides_global_only_when_explicit() {
        assert_eq!(
            effective(PermissionLevel::NotConfigured, PermissionLevel::Ask),
            PermissionLevel::Ask
        );
        assert_eq!(
            effective(PermissionLevel::Allow, PermissionLevel::Ask),
            PermissionLevel::Allow
        );
        assert_eq!(
            effective(PermissionLevel::Ask, PermissionLevel::Allow),
            PermissionLevel::Ask
        );
    }

    #[test]
    fn strict_requires_both_tools_guarded() {
        assert!(PermissionLevel::Ask.is_strict());
        assert!(PermissionLevel::Deny.is_strict());
        assert!(PermissionLevel::Custom.is_strict());
        assert!(!PermissionLevel::NotConfigured.is_strict());
        assert!(!PermissionLevel::Allow.is_strict());

        // check() 的严格判定：两键有效级别（项目覆盖全局）都必须有守卫
        let strict = |edit: PermissionLevel, bash: PermissionLevel| {
            effective(edit, PermissionLevel::NotConfigured).is_strict()
                && effective(bash, PermissionLevel::NotConfigured).is_strict()
        };
        assert!(strict(PermissionLevel::Ask, PermissionLevel::Deny));
        assert!(strict(PermissionLevel::Ask, PermissionLevel::Custom));
        // bash 缺省（=opencode 默认放行）→ 宽松
        assert!(!strict(
            PermissionLevel::Ask,
            PermissionLevel::NotConfigured
        ));
        assert!(!strict(
            PermissionLevel::NotConfigured,
            PermissionLevel::NotConfigured
        ));
        assert!(!strict(PermissionLevel::Allow, PermissionLevel::Ask));
    }

    #[tokio::test]
    async fn read_config_reports_parse_error() {
        let tmp = TempDir::new();
        let path = tmp.path().join("opencode.jsonc");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{{ \"model\": \"m\", }} 剩余垃圾").unwrap();

        let ok = tmp.path().join("ok.jsonc");
        std::fs::write(&ok, "{ // c\n  \"permission\": \"ask\"\n}").unwrap();

        assert!(read_config(&path).await.is_err());
        let config = read_config(&ok).await.unwrap();
        assert_eq!(permission_level(&config, "edit"), PermissionLevel::Ask);
    }

    /// 真机联测（cargo test -- --ignored）：不进 CI，仅本地核对真实环境解析链路。
    #[tokio::test]
    #[ignore]
    async fn check_against_real_machine() {
        let report = check(None).await;
        println!("{report:#?}");
        assert!(report.installed, "本机应已安装 opencode");
        assert!(
            report
                .version
                .as_deref()
                .unwrap_or_default()
                .starts_with('1'),
            "版本号异常"
        );
    }

    /// 手搓临时目录（core 惯例无 tempfile 依赖），Drop 时清理。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("sc-envcheck-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
