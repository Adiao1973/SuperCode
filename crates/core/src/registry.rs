//! AgentRegistry：agent 定义与本机安装探测（docs/architecture.md §4.4）。
//!
//! 注册表 = 内置定义 + 用户自定义（`~/.supercode/agents.json`），同 id 用户条目覆盖内置。
//! 新增 agent ≈ 加一条配置；AcpDriver 只消费 `command`，对注册表零感知。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// 版本探测超时（npx 类适配器冷启动可能较慢，但探测不能卡死宿主）。
const DETECT_TIMEOUT: Duration = Duration::from_secs(8);

/// driver 协议种类（§4.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriverKind {
    Acp,
    StreamJson,
    Native,
}

/// agent 能力位（UI 展示与功能开关）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// 续聊 session/load（或等价 resume）
    pub supports_load_session: bool,
    /// 工具事件携带结构化 diff
    pub supports_diff: bool,
    /// 可外部审批（zcode = false，受限支持：预授权 yolo，UI 明确标注）
    pub supports_permission: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            supports_load_session: true,
            supports_diff: true,
            supports_permission: true,
        }
    }
}

fn default_version_args() -> Vec<String> {
    vec!["--version".into()]
}

/// 一个 agent 的接入声明（serde 双向：内置常量 + 用户自定义文件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub display_name: String,
    pub driver_kind: DriverKind,
    /// spawn 命令（shell-words 语法，如 "opencode acp"）
    pub command: String,
    /// 版本探测参数（跟在 program 之后；缺省 `--version`）
    #[serde(default = "default_version_args")]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub capabilities: Capabilities,
}

impl AgentDefinition {
    /// 探测本机安装：执行 `program <version_args...>`，返回版本号首行；
    /// 未安装 / 超时 / 非零退出 → None。
    pub async fn detect_version(&self) -> Option<String> {
        let program = self.command.split_whitespace().next()?;
        let fut = async {
            let output = tokio::process::Command::new(program)
                .args(&self.version_args)
                .output()
                .await
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let version = stdout
                .lines()
                .chain(stderr.lines())
                .next()?
                .trim()
                .to_string();
            (!version.is_empty()).then_some(version)
        };
        tokio::time::timeout(DETECT_TIMEOUT, fut)
            .await
            .ok()
            .flatten()
    }

    /// 按注册表 id 查找内置+用户自定义的合并视图（便捷入口，等价 `AgentRegistry::load().find`）
    pub fn find(id: &str) -> Result<Self> {
        AgentRegistry::load().find(id).cloned()
    }
}

/// 注册表 = 内置定义 + 用户自定义；同 id 用户条目覆盖内置。
#[derive(Debug, Clone)]
pub struct AgentRegistry {
    entries: Vec<AgentDefinition>,
}

impl AgentRegistry {
    /// 内置注册表（P2-1 起五条齐备，见 architecture §4.4 表）
    pub fn builtin() -> Self {
        let cap = Capabilities::default();
        let entries = vec![
            AgentDefinition {
                id: "opencode".into(),
                display_name: "OpenCode".into(),
                driver_kind: DriverKind::Acp,
                command: "opencode acp".into(),
                version_args: vec!["--version".into()],
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "claude-code".into(),
                display_name: "Claude Code".into(),
                driver_kind: DriverKind::Acp,
                command: "npx -y @agentclientprotocol/claude-agent-acp".into(),
                // 探测 adapter 本身是否就绪（而非 npx 外壳）
                version_args: vec![
                    "-y".into(),
                    "@agentclientprotocol/claude-agent-acp".into(),
                    "--version".into(),
                ],
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "codex".into(),
                display_name: "Codex".into(),
                driver_kind: DriverKind::Acp,
                command: "npx -y @agentclientprotocol/codex-acp".into(),
                version_args: vec![
                    "-y".into(),
                    "@agentclientprotocol/codex-acp".into(),
                    "--version".into(),
                ],
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "mimo".into(),
                display_name: "MiMo".into(),
                driver_kind: DriverKind::Acp,
                command: "mimo acp".into(),
                version_args: vec!["--version".into()],
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "zcode".into(),
                display_name: "ZCode".into(),
                driver_kind: DriverKind::StreamJson,
                command: "zcode -p --output-format stream-json --mode yolo".into(),
                version_args: vec!["--version".into()],
                // 受限支持：yolo 预授权，无法外部审批（architecture §4.4 / ADR-0006 管辖边界）
                capabilities: Capabilities {
                    supports_load_session: false,
                    supports_diff: true,
                    supports_permission: false,
                },
            },
        ];
        Self { entries }
    }

    /// 用户自定义文件路径：`~/.supercode/agents.json`
    pub fn user_config_path() -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".supercode").join("agents.json"))
    }

    /// 内置 + 默认用户自定义路径合并（文件缺失/解析失败 → 仅内置，不阻塞启动）
    pub fn load() -> Self {
        let mut reg = Self::builtin();
        if let Some(path) = Self::user_config_path() {
            reg.merge_user_file(&path);
        }
        reg
    }

    /// 合并用户自定义文件（JSON 数组）。解析失败静默忽略——注册表不可用不应拖垮宿主。
    /// pub 便于测试指定路径。
    pub fn merge_user_file(&mut self, path: &Path) {
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(user_entries) = serde_json::from_str::<Vec<AgentDefinition>>(&text) else {
            return;
        };
        for def in user_entries {
            self.upsert(def);
        }
    }

    fn upsert(&mut self, def: AgentDefinition) {
        match self.entries.iter_mut().find(|e| e.id == def.id) {
            Some(slot) => *slot = def,
            None => self.entries.push(def),
        }
    }

    /// 按 id 查找（合并视图）
    pub fn find(&self, id: &str) -> Result<&AgentDefinition> {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| crate::error::CoreError::Spawn(format!("未知 agent: {id}")))
    }

    /// 全部条目（内置顺序 + 用户新增）
    pub fn entries(&self) -> &[AgentDefinition] {
        &self.entries
    }

    /// 批量探测安装与版本：`(definition, Option<version>)`
    pub async fn probe_installed(&self) -> Vec<(AgentDefinition, Option<String>)> {
        let mut out = Vec::with_capacity(self.entries.len());
        for def in &self.entries {
            let version = def.detect_version().await;
            out.push((def.clone(), version));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_has_five_agents() {
        let reg = AgentRegistry::builtin();
        let ids: Vec<_> = reg.entries().iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            ["opencode", "claude-code", "codex", "mimo", "zcode"],
            "内置注册表应含五条（architecture §4.4）"
        );
    }

    #[test]
    fn builtin_capabilities_flags() {
        let reg = AgentRegistry::builtin();
        let zcode = reg.find("zcode").unwrap();
        assert!(
            !zcode.capabilities.supports_permission,
            "zcode 不可外部审批"
        );
        assert!(
            !zcode.capabilities.supports_load_session,
            "zcode 无 session/load"
        );
        assert_eq!(zcode.driver_kind, DriverKind::StreamJson);

        let oc = reg.find("opencode").unwrap();
        assert!(oc.capabilities.supports_permission);
        assert_eq!(oc.driver_kind, DriverKind::Acp);
    }

    #[test]
    fn find_unknown_agent_errors() {
        let reg = AgentRegistry::builtin();
        assert!(reg.find("no-such-agent").is_err());
    }

    #[test]
    fn user_file_overrides_builtin_by_id() {
        let dir = std::env::temp_dir().join(format!("sc-registry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.json");
        std::fs::write(
            &path,
            r#"[
              {
                "id": "opencode",
                "display_name": "My OpenCode",
                "driver_kind": "acp",
                "command": "my-opencode acp",
                "version_args": ["--version"],
                "capabilities": {
                  "supports_load_session": true,
                  "supports_diff": false,
                  "supports_permission": true
                }
              },
              {
                "id": "custom-agent",
                "display_name": "Custom",
                "driver_kind": "acp",
                "command": "custom-agent --acp"
              }
            ]"#,
        )
        .unwrap();

        let mut reg = AgentRegistry::builtin();
        reg.merge_user_file(&path);

        let oc = reg.find("opencode").unwrap();
        assert_eq!(oc.display_name, "My OpenCode", "同 id 用户条目覆盖内置");
        assert_eq!(oc.command, "my-opencode acp");
        assert!(!oc.capabilities.supports_diff);

        let custom = reg.find("custom-agent").unwrap();
        assert_eq!(custom.driver_kind, DriverKind::Acp);
        assert_eq!(
            custom.version_args,
            vec!["--version".to_string()],
            "version_args 缺省 --version"
        );
        assert!(
            custom.capabilities.supports_permission,
            "capabilities 缺省全 true"
        );
        assert_eq!(reg.entries().len(), 6, "五内置 + 一自定义");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_invalid_user_file_is_ignored() {
        let mut reg = AgentRegistry::builtin();
        let before = reg.entries().len();

        reg.merge_user_file(Path::new("/nonexistent/agents.json"));
        assert_eq!(reg.entries().len(), before, "文件缺失不影响内置");

        let dir = std::env::temp_dir().join(format!("sc-registry-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.json");
        std::fs::write(&path, "not json at all").unwrap();
        reg.merge_user_file(&path);
        assert_eq!(reg.entries().len(), before, "解析失败静默忽略");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn detect_version_missing_command_is_none() {
        let def = AgentDefinition {
            id: "ghost".into(),
            display_name: "Ghost".into(),
            driver_kind: DriverKind::Acp,
            command: "definitely-not-installed-xyz".into(),
            version_args: vec!["--version".into()],
            capabilities: Capabilities::default(),
        };
        assert!(def.detect_version().await.is_none());
    }

    #[tokio::test]
    async fn detect_version_reads_first_line() {
        // 用 /bin/echo 冒充 agent：program + version_args → 输出首行即版本
        let def = AgentDefinition {
            id: "echo".into(),
            display_name: "Echo".into(),
            driver_kind: DriverKind::Acp,
            command: "echo".into(),
            version_args: vec!["1.2.3-stub".into()],
            capabilities: Capabilities::default(),
        };
        assert_eq!(def.detect_version().await.as_deref(), Some("1.2.3-stub"));
    }
}
