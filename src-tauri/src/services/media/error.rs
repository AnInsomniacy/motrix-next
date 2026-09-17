//! Stable media errors at the browser and native command boundaries.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    #[error("unsupported_source")]
    UnsupportedSource,
    #[error("protected_media")]
    ProtectedMedia,
    #[error("authentication_required")]
    AuthenticationRequired,
    #[error("source_expired")]
    SourceExpired,
    #[error("unsupported_selection")]
    UnsupportedSelection,
    #[error("probe_failed")]
    ProbeFailed,
    #[error("expired")]
    Expired,
    #[error("not_found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("unavailable")]
    Unavailable,
    #[error("api_auth_failed")]
    ApiAuthFailed,
    #[error("origin_denied")]
    OriginDenied,
}
