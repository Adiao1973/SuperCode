//! Static commander plan contract; validation never executes a task.
pub mod llm;
pub mod scheduler;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    error::{CoreError, Result},
    orchestrator::validate_launch,
    registry::AgentRegistry,
};

pub const MAX_PLAN_BYTES: u64 = 1024 * 1024;
pub const MAX_TASKS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPlan {
    pub version: u32,
    pub objective: String,
    pub tasks: Vec<PlannedTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedTask {
    pub id: String,
    pub title: String,
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ValidatedPlan {
    pub plan: TaskPlan,
    pub batches: Vec<Vec<String>>,
}

impl TaskPlan {
    pub fn validate(self, registry: &AgentRegistry) -> Result<ValidatedPlan> {
        let invalid = |message: String| CoreError::Protocol(format!("指挥官计划: {message}"));
        if self.version != 1 {
            return Err(invalid("version 必须为 1".into()));
        }
        if self.objective.trim().is_empty() {
            return Err(invalid("objective 不能为空".into()));
        }
        if self.tasks.is_empty() || self.tasks.len() > MAX_TASKS {
            return Err(invalid(format!("tasks 必须有 1～{MAX_TASKS} 项")));
        }
        let mut ids = HashMap::new();
        for (index, task) in self.tasks.iter().enumerate() {
            if task.id.is_empty()
                || task.id.len() > 64
                || !task
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(invalid(format!("任务 {index} 的 id 格式无效")));
            }
            if ids.insert(task.id.as_str(), index).is_some() {
                return Err(invalid(format!("重复任务 id: {}", task.id)));
            }
            if task.title.trim().is_empty() || task.prompt.trim().is_empty() {
                return Err(invalid(format!(
                    "任务 {} 的 title/prompt 不能为空",
                    task.id
                )));
            }
            let agent = registry.find(&task.agent_id).map_err(|_| {
                invalid(format!(
                    "任务 {} 的 agent 未注册: {}",
                    task.id, task.agent_id
                ))
            })?;
            validate_launch(agent, None, ".")
                .map_err(|e| invalid(format!("任务 {} 的 agent 不可执行: {e}", task.id)))?;
        }
        for task in &self.tasks {
            let mut dependencies = HashSet::new();
            for dependency in &task.depends_on {
                if dependency == &task.id
                    || !ids.contains_key(dependency.as_str())
                    || !dependencies.insert(dependency)
                {
                    return Err(invalid(format!(
                        "任务 {} 的依赖无效: {dependency}",
                        task.id
                    )));
                }
            }
        }
        let batches = self.dependency_batches()?;
        Ok(ValidatedPlan {
            plan: self,
            batches,
        })
    }
    /// Read-only layout of persisted history; does not authorize execution.
    pub fn dependency_batches(&self) -> Result<Vec<Vec<String>>> {
        let invalid = |message: String| CoreError::Protocol(format!("指挥官计划: {message}"));
        let mut completed = HashSet::new();
        let mut batches = Vec::new();
        while completed.len() < self.tasks.len() {
            let batch: Vec<String> = self
                .tasks
                .iter()
                .filter(|t| {
                    !completed.contains(t.id.as_str())
                        && t.depends_on.iter().all(|d| completed.contains(d.as_str()))
                })
                .map(|t| t.id.clone())
                .collect();
            if batch.is_empty() {
                let blocked: Vec<_> = self
                    .tasks
                    .iter()
                    .filter(|t| !completed.contains(t.id.as_str()))
                    .map(|t| t.id.as_str())
                    .collect();
                return Err(invalid(format!(
                    "循环依赖，无法调度: {}",
                    blocked.join(", ")
                )));
            }
            completed.extend(batch.iter().cloned());
            batches.push(batch);
        }
        Ok(batches)
    }
}
