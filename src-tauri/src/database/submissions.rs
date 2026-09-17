//! Durable handoff identities and short-lived confirmation requests.
use super::Database;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};
#[derive(Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubmissionState {
    Pending,
    Confirming,
    Submitted,
    Cancelled,
}
#[derive(Debug)]
pub struct Submission {
    pub gid: String,
    pub state: SubmissionState,
}
fn submission_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Submission> {
    let state =
        serde_json::from_value(serde_json::Value::String(row.get(1)?)).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(Submission {
        gid: row.get(0)?,
        state,
    })
}
impl Database {
    pub async fn reserve_submission(
        &self,
        id: &str,
        fingerprint: &str,
    ) -> Result<Submission, AppError> {
        let conn = self.connection().await?;
        let gid = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
        conn.execute(
            "INSERT OR IGNORE INTO download_submissions(id,fingerprint,gid) VALUES (?1,?2,?3)",
            params![id, fingerprint, gid],
        )?;
        let previous: String = conn.query_row(
            "SELECT fingerprint FROM download_submissions WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        if previous != fingerprint {
            return Err(AppError::Conflict(
                "Download request ID already belongs to different input".into(),
            ));
        }
        Ok(conn.query_row(
            "SELECT gid,state FROM download_submissions WHERE id=?1",
            [id],
            submission_row,
        )?)
    }
    pub async fn submission(&self, id: &str) -> Result<Option<Submission>, AppError> {
        Ok(self
            .connection()
            .await?
            .query_row(
                "SELECT gid,state FROM download_submissions WHERE id=?1",
                [id],
                submission_row,
            )
            .optional()?)
    }
    pub async fn stage_confirmation(&self, id: &str, request: &str) -> Result<(), AppError> {
        self.connection().await?.execute("UPDATE download_submissions SET state='confirming',request=?2 WHERE id=?1 AND state='pending'", params![id,request])?;
        Ok(())
    }
    pub async fn pending_downloads(&self) -> Result<Vec<String>, AppError> {
        Ok(self
            .connection()
            .await?
            .prepare("SELECT request FROM download_submissions WHERE state='confirming'")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?)
    }
    pub async fn commit_submission(&self, id: &str) -> Result<(), AppError> {
        self.connection().await?.execute(
            "UPDATE download_submissions SET state='submitted',request=NULL WHERE id=?1",
            [id],
        )?;
        Ok(())
    }
    pub async fn cancel_submission(&self, id: &str) -> Result<(), AppError> {
        self.connection().await?.execute("UPDATE download_submissions SET state='cancelled',request=NULL WHERE id=?1 AND state IN ('pending','confirming')", [id])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn replays_preserve_identity_and_confirmation_is_cleared_on_commit_or_cancel() {
        let db = Database::open_in_memory().unwrap();
        let first = db
            .reserve_submission("request", "same input")
            .await
            .unwrap();
        assert_eq!(
            first.gid,
            db.reserve_submission("request", "same input")
                .await
                .unwrap()
                .gid
        );
        assert!(matches!(
            db.reserve_submission("request", "other input").await,
            Err(AppError::Conflict(_))
        ));
        db.stage_confirmation("request", "pending request")
            .await
            .unwrap();
        assert_eq!(db.pending_downloads().await.unwrap(), ["pending request"]);
        db.commit_submission("request").await.unwrap();
        assert!(db.pending_downloads().await.unwrap().is_empty());
        db.cancel_submission("request").await.unwrap();
        assert_eq!(
            db.submission("request").await.unwrap().unwrap().state,
            SubmissionState::Submitted
        );
        db.reserve_submission("cancelled", "input").await.unwrap();
        db.cancel_submission("cancelled").await.unwrap();
        assert_eq!(
            db.reserve_submission("cancelled", "input")
                .await
                .unwrap()
                .state,
            SubmissionState::Cancelled
        );
    }
}
