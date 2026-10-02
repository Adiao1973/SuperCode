//! Direct chat-completions planner, separate from execution-agent credentials.
use super::{MAX_PLAN_BYTES, TaskPlan, ValidatedPlan};
use crate::{
    error::{CoreError, Result},
    orchestrator::validate_launch,
    registry::AgentRegistry,
};
use reqwest::{
    header::{AUTHORIZATION, HeaderValue},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt, io::Read, net::IpAddr, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub const MAX_CONFIG_BYTES: u64 = 64 * 1024;
fn default_timeout() -> u64 {
    60
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LlmConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key_env: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}
fn invalid(message: &str) -> CoreError {
    CoreError::Protocol(format!("指挥官 LLM: {message}"))
}
impl LlmConfig {
    pub fn read(path: &Path) -> Result<Self> {
        if !std::fs::metadata(path)
            .map_err(|_| invalid("无法读取配置文件"))?
            .is_file()
        {
            return Err(invalid("配置必须为普通文件"));
        }
        let file = std::fs::File::open(path).map_err(|_| invalid("无法读取配置文件"))?;
        if !file
            .metadata()
            .map_err(|_| invalid("无法读取配置文件"))?
            .is_file()
        {
            return Err(invalid("配置必须为普通文件"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("无法读取配置文件"))?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid("配置超过 64 KiB"));
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid("配置 JSON 无效或包含未知字段"))
    }
    pub fn validate(&self) -> Result<reqwest::Url> {
        if self.endpoint.len() as u64 > MAX_CONFIG_BYTES
            || self.model.len() > 1024
            || self.api_key_env.len() > 128
        {
            return Err(invalid("配置字段过长"));
        }
        if serde_json::to_vec(self)
            .map_err(|_| invalid("配置格式无效"))?
            .len() as u64
            > MAX_CONFIG_BYTES
        {
            return Err(invalid("配置超过 64 KiB"));
        }
        let url = reqwest::Url::parse(&self.endpoint).map_err(|_| invalid("endpoint URL 无效"))?;
        let loopback = url
            .host_str()
            .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.host_str().is_none()
            || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        {
            return Err(invalid(
                "endpoint 必须为无凭据/查询/fragment 的 HTTPS 或 loopback HTTP URL",
            ));
        }
        let name = self.api_key_env.as_bytes();
        if self.model.trim().is_empty()
            || self.model.len() > 1024
            || name.is_empty()
            || name.len() > 128
            || !(name[0].is_ascii_alphabetic() || name[0] == b'_')
            || !name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            return Err(invalid("model 或 api_key_env 无效"));
        }
        if !(1..=300).contains(&self.timeout_secs) {
            return Err(invalid("timeout_secs 必须为 1～300"));
        }
        Ok(url)
    }
}

pub struct LlmClient {
    http: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    authorization: HeaderValue,
    timeout: Duration,
}
impl fmt::Debug for LlmClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LlmClient { credentials: [REDACTED] }")
    }
}
impl LlmClient {
    pub fn from_config(config: LlmConfig) -> Result<Self> {
        config.validate()?;
        let key = std::env::var(&config.api_key_env)
            .map_err(|_| invalid("key 环境变量未设置或不可读"))?;
        Self::new(config, key)
    }
    /// Host-supplied credential; never serialized or included in Debug/errors.
    pub fn new(config: LlmConfig, key: String) -> Result<Self> {
        let endpoint = config.validate()?;
        if key.trim().is_empty() {
            return Err(invalid("key 不能为空"));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| invalid("key 不是合法 HTTP 凭据"))?;
        authorization.set_sensitive(true);
        let http = reqwest::Client::builder()
            .redirect(Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| invalid("无法创建 HTTP 客户端"))?;
        Ok(Self {
            http,
            endpoint,
            model: config.model,
            authorization,
            timeout: Duration::from_secs(config.timeout_secs),
        })
    }
    /// Read-only provider catalog; returned ids do not prove inference permission.
    pub async fn discover_models(mut config: LlmConfig, key: String) -> Result<Vec<String>> {
        if config.model.is_empty() {
            config.model = "catalog-query".into();
        }
        let client = Self::new(config, key)?;
        let mut url = client.endpoint.clone();
        let prefix = url
            .path()
            .strip_suffix("/chat/completions")
            .ok_or_else(|| invalid("模型查询需要以 /chat/completions 结尾的 endpoint"))?;
        let path = format!("{prefix}/models");
        url.set_path(&path);
        let request = async {
            let mut response = client
                .http
                .get(url)
                .header(AUTHORIZATION, client.authorization.clone())
                .send()
                .await
                .map_err(|_| invalid("模型列表请求失败"))?;
            if !response.status().is_success() {
                return Err(invalid(&format!(
                    "模型列表 HTTP 状态 {}；可继续手填模型",
                    response.status().as_u16()
                )));
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_PLAN_BYTES)
            {
                return Err(invalid("模型列表超过 1 MiB"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| invalid("模型列表读取失败"))?
            {
                if bytes.len() as u64 + chunk.len() as u64 > MAX_PLAN_BYTES {
                    return Err(invalid("模型列表超过 1 MiB"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| invalid("模型列表不是合法 JSON"))?;
            let data = value["data"]
                .as_array()
                .filter(|items| items.len() <= 4096)
                .ok_or_else(|| invalid("模型列表格式无效或超过 4096 项"))?;
            let mut models = Vec::new();
            for item in data {
                let id = item["id"]
                    .as_str()
                    .filter(|id| {
                        !id.trim().is_empty()
                            && id.len() <= 1024
                            && !id.chars().any(char::is_control)
                    })
                    .ok_or_else(|| invalid("模型列表含无效模型 ID"))?;
                models.push(id.to_string());
            }
            models.sort();
            models.dedup();
            Ok(models)
        };
        tokio::time::timeout(client.timeout, request)
            .await
            .map_err(|_| CoreError::Timeout("模型列表请求超时".into()))?
    }
    pub async fn generate_plan(
        &self,
        objective: &str,
        registry: &AgentRegistry,
        cancel: CancellationToken,
    ) -> Result<ValidatedPlan> {
        if objective.trim().is_empty() || objective.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid("目标不能为空且不能超过 64 KiB"));
        }
        let agents: Vec<_> = registry
            .entries()
            .iter()
            .filter(|agent| validate_launch(agent, None, ".").is_ok())
            .map(|agent| agent.id.as_str())
            .collect();
        if agents.is_empty() {
            return Err(invalid("没有已接入的 agent"));
        }
        let schema = json!({"version":1,"objective":"user objective","tasks":[{"id":"task-1","title":"task title","agent_id":agents[0],"prompt":"instruction for this task","depends_on":[]}]});
        let system = format!(
            "You are a task planner. Return only one bare JSON object, no Markdown or prose. Do not execute tasks or call tools. Exact contract example: {schema}. version must be 1. objective is the user goal. tasks must have 1 to 64 items. Each id is unique, 1 to 64 ASCII alphanumeric, hyphen or underscore characters. title and prompt must be nonempty. depends_on contains only other existing ids, no duplicates or cycles. No extra fields. Choose agent_id only from this JSON array: {}. Use dependencies to describe the work; agents receive prompts separately so include enough context in each prompt.",
            json!(agents)
        );
        let payload = json!({"model":self.model,"stream":false,"messages":[{"role":"system","content":system},{"role":"user","content":objective}]});
        let request = async {
            let mut response = self
                .http
                .post(self.endpoint.clone())
                .header(AUTHORIZATION, self.authorization.clone())
                .json(&payload)
                .send()
                .await
                .map_err(|_| invalid("HTTP 请求失败"))?;
            if !response.status().is_success() {
                return Err(invalid(&format!(
                    "HTTP 状态 {}",
                    response.status().as_u16()
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_PLAN_BYTES)
            {
                return Err(invalid("响应超过 1 MiB"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| invalid("HTTP 响应读取失败"))?
            {
                if bytes.len() as u64 + chunk.len() as u64 > MAX_PLAN_BYTES {
                    return Err(invalid("响应超过 1 MiB"));
                }
                bytes.extend_from_slice(&chunk);
            }
            parse_response(&bytes, objective, registry)
        };
        tokio::select! {
            biased;
            _=cancel.cancelled()=>Err(invalid("已取消")),
            result=tokio::time::timeout(self.timeout,request)=>result.map_err(|_|CoreError::Timeout("指挥官 LLM 请求超时".into()))?,
        }
    }
}
fn parse_response(
    bytes: &[u8],
    objective: &str,
    registry: &AgentRegistry,
) -> Result<ValidatedPlan> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid("响应不是合法 JSON"))?;
    let choices = value["choices"]
        .as_array()
        .filter(|choices| choices.len() == 1)
        .ok_or_else(|| invalid("响应必须包含唯一 choice"))?;
    let choice = &choices[0];
    let message = &choice["message"];
    if choice["finish_reason"] != "stop"
        || message["role"] != "assistant"
        || !message["tool_calls"].is_null()
        || !message["refusal"].is_null()
    {
        return Err(invalid("响应未正常完成或包含工具调用/拒绝"));
    }
    let content = message["content"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| invalid("响应缺少文本计划"))?;
    let plan: TaskPlan =
        serde_json::from_str(content).map_err(|_| invalid("计划不是合法契约 JSON"))?;
    let mut validated = plan
        .validate(registry)
        .map_err(|_| invalid("计划未通过 agent/字段/依赖校验"))?;
    validated.plan.objective = objective.to_string();
    Ok(validated)
}
