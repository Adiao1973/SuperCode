//! AgentRegistry：agent 定义与本机安装探测（docs/architecture.md §4.4）。

use crate::error::Result;

/// 一个 agent 的接入声明。Phase 2 起支持用户自定义（~/.supercode/agents.json）。
#[derive(Debug, Clone)]
pub struct AgentDefinition {
    pub id: String,
    pub display_name: String,
    /// spawn 命令（shell-words 语法），AcpDriver 直接消费
    pub command: String,
    /// 版本探测命令（默认 `<program> --version`）
    pub version_args: Vec<String>,
}

/// 内置注册表。Phase 0 仅 opencode；Phase 2 增加 claude-code/codex（npx adapter）与 mimo。
pub fn builtin() -> Vec<AgentDefinition> {
    vec![AgentDefinition {
        id: "opencode".into(),
        display_name: "OpenCode".into(),
        command: "opencode acp".into(),
        version_args: vec!["--version".into()],
    }]
}

impl AgentDefinition {
    /// 探测本机安装：执行 `<program> --version`，返回版本号首行；未安装返回 None。
    pub async fn detect_version(&self) -> Option<String> {
        let program = self.command.split_whitespace().next()?;
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
    }

    /// 按注册表 id 查找内置定义
    pub fn find(id: &str) -> Result<Self> {
        builtin()
            .into_iter()
            .find(|def| def.id == id)
            .ok_or_else(|| crate::error::CoreError::Spawn(format!("未知 agent: {id}")))
    }
}
