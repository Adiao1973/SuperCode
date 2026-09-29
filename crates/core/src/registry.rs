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

fn is_false(value: &bool) -> bool {
    !*value
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
    /// ACP 子进程必须从会话 cwd 启动（MiMo 服务限制 session/new 目录）。
    #[serde(default, skip_serializing_if = "is_false")]
    pub acp_process_cwd: bool,
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
                .kill_on_drop(true)
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
                acp_process_cwd: false,
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
                acp_process_cwd: false,
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
                acp_process_cwd: false,
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "mimo".into(),
                display_name: "MiMo".into(),
                driver_kind: DriverKind::Acp,
                command: "mimo acp".into(),
                version_args: vec!["--version".into()],
                acp_process_cwd: true,
                capabilities: cap.clone(),
            },
            AgentDefinition {
                id: "zcode".into(),
                display_name: "ZCode".into(),
                driver_kind: DriverKind::StreamJson,
                command: "zcode -p --output-format stream-json --mode yolo".into(),
                version_args: vec!["--version".into()],
                acp_process_cwd: false,
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

    /// 批量探测安装与版本：`(definition, Option<version>)`（并行，总耗时≈最慢一条）
    pub async fn probe_installed(&self) -> Vec<(AgentDefinition, Option<String>)> {
        let futs = self.entries.iter().map(|def| {
            let def = def.clone();
            async move {
                let version = def.detect_version().await;
                (def, version)
            }
        });
        futures::future::join_all(futs).await
    }

    // ── 用户自定义写路径（P2-2：设置 UI agent 管理，§4.4） ──

    /// 仅用户文件中的条目（不含内置；文件缺失/解析失败 → 空）
    pub fn load_user_entries() -> Vec<AgentDefinition> {
        match Self::user_config_path() {
            Some(path) => Self::load_user_entries_at(&path),
            None => Vec::new(),
        }
    }

    /// 原子写回用户文件（`~/.supercode/` 自动创建；临时文件 + rename）
    pub fn save_user_entries(entries: &[AgentDefinition]) -> Result<()> {
        let path = Self::user_config_path().ok_or_else(|| {
            crate::error::CoreError::Io(std::io::Error::other("无法定位用户目录"))
        })?;
        Self::save_user_entries_at(&path, entries)
    }

    /// upsert 进用户文件（同 id 覆盖；覆盖内置 id = 用户覆盖语义）
    pub fn upsert_user_agent(def: AgentDefinition) -> Result<()> {
        let path = Self::user_config_path().ok_or_else(|| {
            crate::error::CoreError::Io(std::io::Error::other("无法定位用户目录"))
        })?;
        Self::upsert_user_agent_at(&path, def)
    }

    /// 从用户文件移除：纯自定义即消失，覆盖内置则恢复内置条目；
    /// 用户文件中不存在该 id → Err
    pub fn remove_user_agent(id: &str) -> Result<()> {
        let path = Self::user_config_path().ok_or_else(|| {
            crate::error::CoreError::Io(std::io::Error::other("无法定位用户目录"))
        })?;
        Self::remove_user_agent_at(&path, id)
    }

    /// 路径参数形态（测试与显式路径场景）
    pub fn load_user_entries_at(path: &Path) -> Vec<AgentDefinition> {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        serde_json::from_str::<Vec<AgentDefinition>>(&text).unwrap_or_default()
    }

    /// 原子写：父目录自动创建，临时文件 + rename 避免半截文件
    pub fn save_user_entries_at(path: &Path, entries: &[AgentDefinition]) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(entries).map_err(|e| {
            crate::error::CoreError::Protocol(format!("序列化用户 agent 失败: {e}"))
        })?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn upsert_user_agent_at(path: &Path, def: AgentDefinition) -> Result<()> {
        let mut entries = Self::load_user_entries_at(path);
        match entries.iter_mut().find(|e| e.id == def.id) {
            Some(slot) => *slot = def,
            None => entries.push(def),
        }
        Self::save_user_entries_at(path, &entries)
    }

    pub fn remove_user_agent_at(path: &Path, id: &str) -> Result<()> {
        let mut entries = Self::load_user_entries_at(path);
        let before = entries.len();
        entries.retain(|e| e.id != id);
        if entries.len() == before {
            return Err(crate::error::CoreError::Spawn(format!(
                "用户自定义中无 agent: {id}"
            )));
        }
        Self::save_user_entries_at(path, &entries)
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
        assert!(!oc.acp_process_cwd);

        let mimo = reg.find("mimo").unwrap();
        assert!(mimo.acp_process_cwd);
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
        assert!(!custom.acp_process_cwd, "旧版用户配置保持兼容");
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
            acp_process_cwd: false,
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
            acp_process_cwd: false,
            capabilities: Capabilities::default(),
        };
        assert_eq!(def.detect_version().await.as_deref(), Some("1.2.3-stub"));
    }

    fn temp_user_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sc-reg-write-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("agents.json")
    }

    fn sample_def(id: &str, command: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.into(),
            display_name: id.into(),
            driver_kind: DriverKind::Acp,
            command: command.into(),
            version_args: vec!["--version".into()],
            acp_process_cwd: false,
            capabilities: Capabilities::default(),
        }
    }

    #[test]
    fn upsert_writes_and_overrides_builtin() {
        let path = temp_user_path("upsert");
        AgentRegistry::upsert_user_agent_at(&path, sample_def("custom-a", "a --acp")).unwrap();
        AgentRegistry::upsert_user_agent_at(&path, sample_def("opencode", "my-oc acp")).unwrap();

        let entries = AgentRegistry::load_user_entries_at(&path);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|e| e.id == "custom-a"));
        let oc = entries.iter().find(|e| e.id == "opencode").unwrap();
        assert_eq!(oc.command, "my-oc acp", "同 id 覆盖写入用户文件");

        // 合并视图：内置 opencode 被用户条目覆盖
        let mut reg = AgentRegistry::builtin();
        reg.merge_user_file(&path);
        assert_eq!(reg.find("opencode").unwrap().command, "my-oc acp");
        assert_eq!(reg.entries().len(), 6);

        // 再 upsert 同 id 不膨胀
        AgentRegistry::upsert_user_agent_at(&path, sample_def("custom-a", "a2 --acp")).unwrap();
        let entries = AgentRegistry::load_user_entries_at(&path);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries.iter().find(|e| e.id == "custom-a").unwrap().command,
            "a2 --acp"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_custom_vanishes_and_override_restores_builtin() {
        let path = temp_user_path("remove");
        AgentRegistry::upsert_user_agent_at(&path, sample_def("custom-b", "b --acp")).unwrap();
        AgentRegistry::upsert_user_agent_at(&path, sample_def("zcode", "my-zcode run")).unwrap();

        // 删纯自定义：条目消失
        AgentRegistry::remove_user_agent_at(&path, "custom-b").unwrap();
        let entries = AgentRegistry::load_user_entries_at(&path);
        assert!(entries.iter().all(|e| e.id != "custom-b"));
        assert_eq!(entries.len(), 1);

        // 删覆盖条目：合并视图恢复内置 zcode
        AgentRegistry::remove_user_agent_at(&path, "zcode").unwrap();
        assert!(AgentRegistry::load_user_entries_at(&path).is_empty());
        let mut reg = AgentRegistry::builtin();
        reg.merge_user_file(&path);
        assert_eq!(
            reg.find("zcode").unwrap().command,
            "zcode -p --output-format stream-json --mode yolo"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_unknown_id_errors_and_save_creates_dir() {
        let path = temp_user_path("unknown");
        assert!(AgentRegistry::remove_user_agent_at(&path, "nope").is_err());

        // 父目录不存在时 save 自动创建（不 panic）
        let nested = std::env::temp_dir()
            .join(format!("sc-reg-nested-{}", std::process::id()))
            .join("sub")
            .join("agents.json");
        let _ = std::fs::remove_dir_all(nested.parent().unwrap().parent().unwrap());
        AgentRegistry::save_user_entries_at(&nested, &[sample_def("x", "x")]).unwrap();
        assert_eq!(AgentRegistry::load_user_entries_at(&nested).len(), 1);
        let _ = std::fs::remove_dir_all(nested.parent().unwrap().parent().unwrap());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
