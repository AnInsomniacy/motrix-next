//! The desktop owns the ordinary download handoff contract.
use crate::services::external_input::ExternalRequestHeader;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRequest {
    pub id: String,
    pub url: String,
    pub final_url: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
    #[serde(default)]
    pub request_headers: Vec<ExternalRequestHeader>,
    pub filename: Option<String>,
    #[serde(default)]
    pub filename_source: FilenameSource,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilenameSource {
    Browser,
    #[default]
    Suggested,
}
#[derive(Debug, Clone, Serialize)]
pub struct AddResponse {
    pub id: String,
    pub action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<String>,
}
