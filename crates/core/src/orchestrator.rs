//! Shared launch validation for desktop and CLI hosts.
use crate::{
    db::SessionRow,
    error::{CoreError, Result},
    registry::{AgentDefinition, DriverKind},
};

/// Validate before spawning any process or allocating event pipelines.
pub fn validate_launch(
    def: &AgentDefinition,
    resume: Option<&SessionRow>,
    cwd: &str,
) -> Result<()> {
    let invalid = |message: &str| CoreError::Protocol(message.into());
    if def.driver_kind != DriverKind::Acp {
        return Err(invalid("该 agent 的驱动尚未接入，仅支持 ACP"));
    }
    if let Some(session) = resume {
        if session.agent_id != def.id {
            return Err(invalid("续聊 agent 与历史会话不一致，请新建会话切换 agent"));
        }
        if session.cwd != cwd {
            return Err(invalid("续聊工作目录与历史会话不一致"));
        }
        if !def.capabilities.supports_load_session {
            return Err(invalid("该 agent 不支持 session/load，请新建会话"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::AgentRegistry;

    #[test]
    fn launch_rejects_unsupported_driver_and_mismatched_resume() {
        let registry = AgentRegistry::builtin();
        let claude = registry.find("claude-code").unwrap();
        let session = SessionRow {
            id: "local".into(),
            agent_id: "claude-code".into(),
            agent_session_id: "remote".into(),
            cwd: "/tmp/project".into(),
            title: "test".into(),
            status: "completed".into(),
            updated_at: String::new(),
            workspace_id: "default".into(),
        };
        assert!(validate_launch(claude, None, &session.cwd).is_ok());
        assert!(validate_launch(claude, Some(&session), &session.cwd).is_ok());
        assert!(
            validate_launch(
                registry.find("opencode").unwrap(),
                Some(&session),
                &session.cwd
            )
            .is_err()
        );
        assert!(validate_launch(claude, Some(&session), "/tmp/other").is_err());
        assert!(validate_launch(registry.find("zcode").unwrap(), None, &session.cwd).is_err());
        let mut no_load = claude.clone();
        no_load.capabilities.supports_load_session = false;
        assert!(validate_launch(&no_load, Some(&session), &session.cwd).is_err());
    }
}
