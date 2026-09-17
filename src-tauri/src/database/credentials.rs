//! Saved HTTP credentials, scoped by the URL library's normalized origin.
use super::Database;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

#[derive(Serialize)]
pub struct HttpAuthCredential {
    pub id: i64,
    origin: String,
    pub username: String,
    pub password: String,
    created_at: String,
    updated_at: String,
    last_used_at: Option<String>,
}

fn origin(value: &str) -> Result<String, AppError> {
    let url =
        url::Url::parse(value.trim()).map_err(|error| AppError::Database(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Database(
            "HTTP credentials require an HTTP URL".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

impl Database {
    pub async fn save_credential(
        &self,
        url: &str,
        username: &str,
        password: &str,
    ) -> Result<(), AppError> {
        let origin = origin(url)?;
        if username.is_empty() {
            return Err(AppError::Database("A username is required".into()));
        }
        self.connection().await?.execute(
            "INSERT INTO http_auth_credentials(origin,username,password,last_used_at) VALUES (?1,?2,?3,CURRENT_TIMESTAMP) ON CONFLICT(origin,username) DO UPDATE SET password=excluded.password, updated_at=CURRENT_TIMESTAMP, last_used_at=CURRENT_TIMESTAMP",
            params![origin,username,password])?;
        Ok(())
    }
    pub async fn credential_for_url(
        &self,
        url: &str,
    ) -> Result<Option<HttpAuthCredential>, AppError> {
        let origin = origin(url)?;
        Ok(self.connection().await?.query_row(
            "SELECT id,origin,username,password,created_at,updated_at,last_used_at FROM http_auth_credentials WHERE origin=?1 ORDER BY COALESCE(last_used_at,updated_at,created_at) DESC,id DESC LIMIT 1",
            [origin], |row| Ok(HttpAuthCredential {
                id: row.get(0)?, origin: row.get(1)?, username: row.get(2)?, password: row.get(3)?,
                created_at: row.get(4)?, updated_at: row.get(5)?, last_used_at: row.get(6)?,
            })).optional()?)
    }
    pub async fn mark_credential_used(&self, id: i64) -> Result<(), AppError> {
        self.connection().await?.execute(
            "UPDATE http_auth_credentials SET last_used_at=CURRENT_TIMESTAMP WHERE id=?1",
            [id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn credentials_match_native_origins_and_preserve_password_text() {
        let db = Database::open_in_memory().unwrap();
        db.save_credential("https://EXAMPLE.com:443/one", "user", "literal%20")
            .await
            .unwrap();
        let saved = db
            .credential_for_url("https://example.com/two")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.password, "literal%20");
        assert!(db
            .credential_for_url("http://example.com")
            .await
            .unwrap()
            .is_none());
        assert!(db
            .credential_for_url("https://example.com:444")
            .await
            .unwrap()
            .is_none());
        db.save_credential("https://example.com", "user", "updated")
            .await
            .unwrap();
        assert_eq!(
            db.credential_for_url("https://example.com")
                .await
                .unwrap()
                .unwrap()
                .password,
            "updated"
        );
    }
}
