//! Thin authenticated HTTP adapter; media work never depends on a frontend event.
use super::error::Error;
use super::{
    contracts::{ProbeRequest, SubmitRequest},
    service,
};
use crate::services::http_api::{
    extension_origin, read_api_secret, validate_bearer_token, ApiContext,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderName, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Error::ApiAuthFailed => StatusCode::UNAUTHORIZED,
            Error::OriginDenied => StatusCode::FORBIDDEN,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::Expired => StatusCode::GONE,
            Error::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error":self})),
        )
            .into_response()
    }
}

fn authorize(ctx: &ApiContext, headers: &HeaderMap) -> Result<(), Error> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin.to_str().is_ok_and(extension_origin) {
            return Err(Error::OriginDenied);
        }
    }
    let secret = read_api_secret(&ctx.app);
    if secret.is_empty() || validate_bearer_token(headers, &secret).is_err() {
        return Err(Error::ApiAuthFailed);
    }
    Ok(())
}

pub fn router() -> Router<Arc<ApiContext>> {
    Router::new()
        .route("/capabilities", get(capabilities))
        .route("/probes", post(create))
        .route("/probes/{id}", get(read))
        .route("/probes/{id}/submit", post(submit))
        .route("/probes/{id}/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| {
                    origin.to_str().is_ok_and(extension_origin)
                }))
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    HeaderName::from_static("x-rayburst-client"),
                ])
                .allow_private_network(true),
        )
}

type Reply = Result<([(axum::http::HeaderName, &'static str); 1], Json<Value>), Error>;
fn reply(value: Value) -> Reply {
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(value)))
}
async fn capabilities(State(ctx): State<Arc<ApiContext>>, headers: HeaderMap) -> Reply {
    authorize(&ctx, &headers)?;
    reply(service(&ctx.app).await?.capabilities().await?)
}
async fn create(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
    body: Result<Json<ProbeRequest>, axum::extract::rejection::JsonRejection>,
) -> Reply {
    authorize(&ctx, &headers)?;
    let Json(request) = body.map_err(|_| Error::UnsupportedSource)?;
    let service = service(&ctx.app).await?;
    service.capabilities().await?;
    let config = ctx
        .app
        .state::<crate::services::config::RuntimeConfigState>()
        .snapshot()
        .await;
    reply(
        service
            .create(
                request,
                super::contracts::Format::parse(&config.media_default_format)?,
            )
            .await?,
    )
}
async fn read(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Reply {
    authorize(&ctx, &headers)?;
    reply(service(&ctx.app).await?.read(id).await?)
}
async fn submit(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<SubmitRequest>, axum::extract::rejection::JsonRejection>,
) -> Reply {
    authorize(&ctx, &headers)?;
    let Json(request) = body.map_err(|_| Error::UnsupportedSelection)?;
    reply(service(&ctx.app).await?.submit(id, request).await?)
}
async fn cancel(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Reply {
    authorize(&ctx, &headers)?;
    if body.map_err(|_| Error::UnsupportedSource)?.0 != json!({}) {
        return Err(Error::UnsupportedSource);
    }
    reply(service(&ctx.app).await?.cancel(id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_extension_origins_pass() {
        assert!(extension_origin("chrome-extension://abcdefghijklmnop"));
        assert!(extension_origin("moz-extension://12345678-abcd"));
        for value in [
            "null",
            "https://example.com",
            "chrome-extension://",
            "chrome-extension://id.evil/path",
            "chrome-extension://user@id",
        ] {
            assert!(!extension_origin(value));
        }
    }
}
