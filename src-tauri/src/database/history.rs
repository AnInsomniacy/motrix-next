//! Download history queries and lifecycle transactions.
use super::Database;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRecord {
    pub id: Option<i64>,
    pub gid: String,
    pub name: String,
    pub uri: Option<String>,
    pub dir: Option<String>,
    pub total_length: Option<i64>,
    pub status: String,
    pub task_type: Option<String>,
    pub added_at: Option<String>,
    pub created_at: Option<String>,
    pub completed_at: Option<String>,
    pub meta: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageInput {
    pub status: Option<String>,
    pub page: u32,
    pub page_size: u32,
    pub sort_field: Option<String>,
    pub sort_order: Option<String>,
}
#[derive(Serialize)]
pub struct HistoryPage {
    pub records: Vec<HistoryRecord>,
    pub total: i64,
}

impl Database {
    pub async fn get_record(&self, gid: &str) -> Result<Option<HistoryRecord>, AppError> {
        Ok(self
            .connection()
            .await?
            .query_row(
                "SELECT * FROM download_history WHERE gid=?1",
                [gid],
                Self::row_to_record,
            )
            .optional()?)
    }

    pub async fn get_records_page(&self, input: HistoryPageInput) -> Result<HistoryPage, AppError> {
        let mut conn = self.connection().await?;
        let transaction = conn.transaction()?;
        let column = match input.sort_field.as_deref() {
            Some("name") => "name",
            Some("status") => "status",
            Some("total_length") => "total_length",
            Some("task_type") => "task_type",
            Some("completed_at") => "completed_at",
            _ => "COALESCE(added_at, completed_at)",
        };
        let direction = if input.sort_order.as_deref() == Some("ascend") {
            "ASC"
        } else {
            "DESC"
        };
        let size = input.page_size.clamp(1, 100);
        let offset = u64::from(input.page.saturating_sub(1)) * u64::from(size);
        let filter = "WHERE (?1 IS NULL OR status=?1)";
        let records = transaction.prepare(&format!(
            "SELECT * FROM download_history {filter} ORDER BY {column} {direction}, COALESCE(added_at, completed_at) DESC, id DESC LIMIT ?2 OFFSET ?3"
        ))?.query_map(params![input.status, size, offset], Self::row_to_record)?.collect::<Result<Vec<_>, _>>()?;
        let total = transaction.query_row(
            &format!("SELECT COUNT(*) FROM download_history {filter}"),
            params![input.status],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(HistoryPage { records, total })
    }

    pub async fn remove_birth_records(&self, gids: &[String]) -> Result<(), AppError> {
        let mut conn = self.connection().await?;
        let transaction = conn.transaction()?;
        {
            let mut statement = transaction.prepare("DELETE FROM task_birth WHERE gid=?1")?;
            for gid in gids {
                statement.execute([gid])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
    /// Upsert a history record by GID.
    ///
    /// Uses ON CONFLICT(gid) DO UPDATE to preserve the immutable `added_at`.
    pub async fn add_record(&self, record: &HistoryRecord) -> Result<(), AppError> {
        let conn = self.connection().await?;
        conn.execute(
            "INSERT INTO download_history
                (gid, name, uri, dir, total_length, status, task_type, added_at, completed_at, meta)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(gid) DO UPDATE SET
                name = excluded.name,
                uri = excluded.uri,
                dir = excluded.dir,
                total_length = excluded.total_length,
                status = excluded.status,
                task_type = excluded.task_type,
                added_at = COALESCE(download_history.added_at, excluded.added_at),
                completed_at = CASE
                    WHEN download_history.status = 'complete' AND excluded.status = 'complete'
                    THEN COALESCE(download_history.completed_at, excluded.completed_at)
                    ELSE excluded.completed_at
                END,
                meta = CASE
                    WHEN download_history.meta IS NULL THEN excluded.meta
                    WHEN excluded.meta IS NULL THEN download_history.meta
                    ELSE json_patch(download_history.meta, excluded.meta)
                END",
            params![
                record.gid,
                record.name,
                record.uri,
                record.dir,
                record.total_length,
                record.status,
                record.task_type,
                record.added_at,
                record.completed_at,
                record.meta,
            ],
        )?;
        Ok(())
    }

    /// Returns whether a lifecycle record already exists for the GID.
    pub async fn contains_record(&self, gid: &str) -> Result<bool, AppError> {
        let conn = self.connection().await?;
        let exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM download_history WHERE gid = ?1)",
            params![gid],
            |row| row.get(0),
        )?;
        Ok(exists)
    }

    /// Query records, optionally filtered by status.
    ///
    /// Sorted by `COALESCE(added_at, completed_at) DESC`.
    pub async fn get_records(
        &self,
        status: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<HistoryRecord>, AppError> {
        let conn = self.connection().await?;
        let order = "ORDER BY COALESCE(added_at, completed_at) DESC";
        let limit_clause = limit
            .map(|l| format!(" LIMIT {}", l.min(10_000)))
            .unwrap_or_default();

        if let Some(status) = status {
            let sql =
                format!("SELECT * FROM download_history WHERE status = ?1 {order}{limit_clause}");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![status], Self::row_to_record)?;
            let records: Vec<HistoryRecord> = rows.collect::<Result<Vec<_>, _>>()?;
            Ok(records)
        } else {
            let sql = format!("SELECT * FROM download_history {order}{limit_clause}");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], Self::row_to_record)?;
            let records: Vec<HistoryRecord> = rows.collect::<Result<Vec<_>, _>>()?;
            Ok(records)
        }
    }

    /// Remove a single record by GID.
    pub async fn remove_record(&self, gid: &str) -> Result<(), AppError> {
        let conn = self.connection().await?;
        conn.execute("DELETE FROM download_history WHERE gid = ?1", params![gid])?;
        Ok(())
    }

    /// Remove every persisted record owned by a deleted task.
    pub async fn remove_task_records(
        &self,
        gid: &str,
        info_hash: Option<&str>,
    ) -> Result<(), AppError> {
        let mut conn = self.connection().await?;
        let transaction = conn.transaction()?;
        transaction.execute("DELETE FROM download_history WHERE gid = ?1", params![gid])?;
        if let Some(info_hash) = info_hash.filter(|value| !value.is_empty()) {
            transaction.execute(
                "DELETE FROM download_history WHERE json_extract(meta, '$.infoHash') = ?1",
                params![info_hash],
            )?;
        }
        transaction.execute("DELETE FROM task_birth WHERE gid = ?1", params![gid])?;
        transaction.commit()?;
        Ok(())
    }

    /// Clear all records, optionally filtered by status.
    pub async fn clear_records(&self, status: Option<&str>) -> Result<(), AppError> {
        let mut conn = self.connection().await?;
        let transaction = conn.transaction()?;
        if let Some(status) = status {
            transaction.execute(
                "DELETE FROM task_birth WHERE gid IN (SELECT gid FROM download_history WHERE status = ?1)",
                params![status],
            )?;
            transaction.execute(
                "DELETE FROM download_history WHERE status = ?1",
                params![status],
            )?;
        } else {
            transaction.execute(
                "DELETE FROM task_birth WHERE gid IN (SELECT gid FROM download_history)",
                [],
            )?;
            transaction.execute("DELETE FROM download_history", [])?;
        }
        transaction.commit()?;
        if status.is_none() {
            conn.execute_batch("VACUUM")?;
        }
        Ok(())
    }

    /// Remove records whose GIDs are in the provided list (stale cleanup).
    pub async fn remove_stale_records(&self, gids: &[String]) -> Result<(), AppError> {
        if gids.is_empty() {
            return Ok(());
        }
        let conn = self.connection().await?;
        let placeholders: Vec<String> = gids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "DELETE FROM download_history WHERE gid IN ({})",
            placeholders.join(", ")
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            gids.iter().map(|g| g as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params.as_slice())?;
        Ok(())
    }

    /// Remove records matching a BT infoHash in the meta JSON column.
    pub async fn remove_by_info_hash(
        &self,
        info_hash: &str,
        exclude_gid: Option<&str>,
    ) -> Result<(), AppError> {
        if info_hash.is_empty() {
            return Ok(());
        }
        let conn = self.connection().await?;
        if let Some(exclude) = exclude_gid {
            conn.execute(
                "DELETE FROM download_history WHERE json_extract(meta, '$.infoHash') = ?1 AND gid != ?2",
                params![info_hash, exclude],
            )?;
        } else {
            conn.execute(
                "DELETE FROM download_history WHERE json_extract(meta, '$.infoHash') = ?1",
                params![info_hash],
            )?;
        }
        Ok(())
    }

    /// Record a task birth timestamp (INSERT OR IGNORE — first write wins).
    pub async fn record_task_birth(&self, gid: &str, added_at: &str) -> Result<(), AppError> {
        let conn = self.connection().await?;
        conn.execute(
            "INSERT OR IGNORE INTO task_birth (gid, added_at) VALUES (?1, ?2)",
            params![gid, added_at],
        )?;
        Ok(())
    }

    /// Return the first recorded birth timestamp for a task GID.
    pub async fn get_task_birth(&self, gid: &str) -> Result<Option<String>, AppError> {
        let conn = self.connection().await?;
        let added_at = conn
            .query_row(
                "SELECT added_at FROM task_birth WHERE gid = ?1",
                params![gid],
                |row| row.get(0),
            )
            .optional()?;
        Ok(added_at)
    }

    /// Load all birth records for pre-populating in-memory maps.
    pub async fn load_birth_records(&self) -> Result<Vec<(String, String)>, AppError> {
        let conn = self.connection().await?;
        let mut stmt = conn.prepare("SELECT gid, added_at FROM task_birth")?;
        let records = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    /// Check database integrity.
    pub async fn check_integrity(&self) -> Result<String, AppError> {
        let conn = self.connection().await?;
        let result: Option<String> = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .optional()?;
        Ok(result.unwrap_or_else(|| "unknown".to_string()))
    }

    /// Map a rusqlite Row to a HistoryRecord.
    fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<HistoryRecord> {
        Ok(HistoryRecord {
            id: row.get("id")?,
            gid: row.get("gid")?,
            name: row.get("name")?,
            uri: row.get("uri")?,
            dir: row.get("dir")?,
            total_length: row.get("total_length")?,
            status: row.get("status")?,
            task_type: row.get("task_type")?,
            added_at: row.get("added_at")?,
            created_at: row.get("created_at")?,
            completed_at: row.get("completed_at")?,
            meta: row.get("meta")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_initialization_preserves_records_without_a_webview() {
        let directory =
            tempfile::tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/target")).unwrap();
        let path = directory.path().join("history.db");
        let db = Database::unavailable();
        db.initialize(&path).await.unwrap();
        db.add_record(&make_record("saved", "literal%20.txt", "complete"))
            .await
            .unwrap();
        db.close().await;
        db.initialize(&path).await.unwrap();
        assert_eq!(
            db.get_records(None, None).await.unwrap()[0].name,
            "literal%20.txt"
        );
        assert_eq!(db.schema_version().await.unwrap(), 4);
    }

    #[tokio::test]
    async fn pages_filter_and_sort_native_records_with_a_consistent_count() {
        let db = Database::open_in_memory().unwrap();
        for (gid, name, status) in [
            ("1", "z", "complete"),
            ("2", "a", "complete"),
            ("3", "b", "error"),
        ] {
            db.add_record(&make_record(gid, name, status))
                .await
                .unwrap();
        }
        let page = db
            .get_records_page(HistoryPageInput {
                status: Some("complete".into()),
                page: 2,
                page_size: 1,
                sort_field: Some("name".into()),
                sort_order: Some("ascend".into()),
            })
            .await
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.records[0].gid, "1");
        db.record_task_birth("1", "original").await.unwrap();
        db.record_task_birth("2", "other").await.unwrap();
        db.remove_birth_records(&["1".into()]).await.unwrap();
        assert_eq!(db.get_task_birth("1").await.unwrap(), None);
        assert_eq!(
            db.get_task_birth("2").await.unwrap().as_deref(),
            Some("other")
        );
    }

    fn make_record(gid: &str, name: &str, status: &str) -> HistoryRecord {
        HistoryRecord {
            id: None,
            gid: gid.to_string(),
            name: name.to_string(),
            uri: Some("http://example.com/file.zip".to_string()),
            dir: Some("/tmp".to_string()),
            total_length: Some(1024),
            status: status.to_string(),
            task_type: Some("uri".to_string()),
            added_at: Some("2025-01-01T00:00:00Z".to_string()),
            created_at: None,
            completed_at: Some("2025-01-01T01:00:00Z".to_string()),
            meta: None,
        }
    }

    // ── CRUD operations ─────────────────────────────────────────────

    #[tokio::test]
    async fn add_and_get_record() {
        let db = Database::open_in_memory().unwrap();
        let rec = make_record("gid001", "test.zip", "complete");
        db.add_record(&rec).await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].gid, "gid001");
        assert_eq!(records[0].name, "test.zip");
        assert_eq!(records[0].status, "complete");
        assert_eq!(records[0].total_length, Some(1024));
    }

    #[tokio::test]
    async fn contains_record_checks_lifecycle_gid() {
        let db = Database::open_in_memory().unwrap();
        assert!(!db.contains_record("gid001").await.unwrap());

        db.add_record(&make_record("gid001", "test.zip", "complete"))
            .await
            .unwrap();

        assert!(db.contains_record("gid001").await.unwrap());
    }

    #[tokio::test]
    async fn upsert_preserves_completion_timestamps_and_merges_meta() {
        let db = Database::open_in_memory().unwrap();
        let rec1 = HistoryRecord {
            added_at: Some("2025-01-01T00:00:00Z".to_string()),
            meta: Some(r#"{"infoHash":"abc"}"#.to_string()),
            ..make_record("gid001", "test.zip", "complete")
        };
        db.add_record(&rec1).await.unwrap();

        // Upsert with a different added_at — COALESCE should preserve the original
        let rec2 = HistoryRecord {
            added_at: Some("2025-06-01T00:00:00Z".to_string()),
            completed_at: Some("2025-06-01T01:00:00Z".to_string()),
            meta: Some(r#"{"sharingTime":"3600"}"#.to_string()),
            status: "complete".to_string(),
            ..make_record("gid001", "test-updated.zip", "complete")
        };
        db.add_record(&rec2).await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].name, "test-updated.zip");
        assert_eq!(records[0].status, "complete");
        assert_eq!(records[0].added_at.as_deref(), Some("2025-01-01T00:00:00Z"));
        assert_eq!(
            records[0].completed_at.as_deref(),
            Some("2025-01-01T01:00:00Z")
        );
        let meta: serde_json::Value =
            serde_json::from_str(records[0].meta.as_deref().unwrap()).unwrap();
        assert_eq!(meta["infoHash"], "abc");
        assert_eq!(meta["sharingTime"], "3600");
    }

    #[tokio::test]
    async fn get_records_filters_by_status() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g2", "b.zip", "error"))
            .await
            .unwrap();
        db.add_record(&make_record("g3", "c.zip", "complete"))
            .await
            .unwrap();

        let complete = db.get_records(Some("complete"), None).await.unwrap();
        assert_eq!(complete.len(), 2);

        let errors = db.get_records(Some("error"), None).await.unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].gid, "g2");
    }

    #[tokio::test]
    async fn get_records_respects_limit() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..10 {
            let mut rec = make_record(&format!("g{i}"), &format!("file{i}.zip"), "complete");
            rec.added_at = Some(format!("2025-01-{:02}T00:00:00Z", i + 1));
            db.add_record(&rec).await.unwrap();
        }

        let limited = db.get_records(None, Some(3)).await.unwrap();
        assert_eq!(limited.len(), 3);
    }

    #[tokio::test]
    async fn remove_record_by_gid() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g2", "b.zip", "complete"))
            .await
            .unwrap();

        db.remove_record("g1").await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].gid, "g2");
    }

    #[tokio::test]
    async fn remove_task_records_clears_history_and_birth() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("gid001", "test.zip", "complete"))
            .await
            .unwrap();
        db.record_task_birth("gid001", "2025-01-01T00:00:00Z")
            .await
            .unwrap();

        db.remove_task_records("gid001", None).await.unwrap();

        assert!(db.get_records(None, None).await.unwrap().is_empty());
        assert_eq!(db.get_task_birth("gid001").await.unwrap(), None);
    }

    #[tokio::test]
    async fn clear_records_by_status() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g2", "b.zip", "error"))
            .await
            .unwrap();
        db.record_task_birth("g1", "2025-01-01T00:00:00Z")
            .await
            .unwrap();
        db.record_task_birth("g2", "2025-01-02T00:00:00Z")
            .await
            .unwrap();

        db.clear_records(Some("error")).await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].gid, "g1");
        assert_eq!(
            db.get_task_birth("g1").await.unwrap().as_deref(),
            Some("2025-01-01T00:00:00Z")
        );
        assert_eq!(db.get_task_birth("g2").await.unwrap(), None);
    }

    #[tokio::test]
    async fn clear_all_records() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g2", "b.zip", "error"))
            .await
            .unwrap();

        db.clear_records(None).await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert!(records.is_empty());
    }

    #[tokio::test]
    async fn remove_stale_records() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g2", "b.zip", "complete"))
            .await
            .unwrap();
        db.add_record(&make_record("g3", "c.zip", "complete"))
            .await
            .unwrap();

        db.remove_stale_records(&["g1".to_string(), "g3".to_string()])
            .await
            .unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].gid, "g2");
    }

    #[tokio::test]
    async fn remove_stale_records_empty_is_noop() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.remove_stale_records(&[]).await.unwrap();
        assert_eq!(db.get_records(None, None).await.unwrap().len(), 1);
    }

    // ── InfoHash operations ─────────────────────────────────────────

    #[tokio::test]
    async fn remove_by_info_hash() {
        let db = Database::open_in_memory().unwrap();
        let mut rec = make_record("g1", "torrent.zip", "complete");
        rec.meta = Some(r#"{"infoHash":"abc123"}"#.to_string());
        db.add_record(&rec).await.unwrap();

        let mut rec2 = make_record("g2", "torrent2.zip", "complete");
        rec2.meta = Some(r#"{"infoHash":"abc123"}"#.to_string());
        db.add_record(&rec2).await.unwrap();

        // Remove all with infoHash abc123, excluding g2
        db.remove_by_info_hash("abc123", Some("g2")).await.unwrap();

        let records = db.get_records(None, None).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].gid, "g2");
    }

    #[tokio::test]
    async fn remove_by_info_hash_empty_is_noop() {
        let db = Database::open_in_memory().unwrap();
        db.add_record(&make_record("g1", "a.zip", "complete"))
            .await
            .unwrap();
        db.remove_by_info_hash("", None).await.unwrap();
        assert_eq!(db.get_records(None, None).await.unwrap().len(), 1);
    }

    // ── Task birth tracking ─────────────────────────────────────────

    #[tokio::test]
    async fn record_and_load_task_births() {
        let db = Database::open_in_memory().unwrap();
        db.record_task_birth("g1", "2025-01-01T00:00:00Z")
            .await
            .unwrap();
        db.record_task_birth("g2", "2025-01-02T00:00:00Z")
            .await
            .unwrap();

        let births = db.load_birth_records().await.unwrap();
        assert_eq!(births.len(), 2);
    }

    #[tokio::test]
    async fn record_task_birth_ignores_duplicate() {
        let db = Database::open_in_memory().unwrap();
        db.record_task_birth("g1", "2025-01-01T00:00:00Z")
            .await
            .unwrap();
        // Second insert should be silently ignored
        db.record_task_birth("g1", "2025-06-01T00:00:00Z")
            .await
            .unwrap();

        let births = db.load_birth_records().await.unwrap();
        assert_eq!(births.len(), 1);
        assert_eq!(births[0].1, "2025-01-01T00:00:00Z");
    }

    #[tokio::test]
    async fn get_task_birth_returns_persisted_added_at() {
        let db = Database::open_in_memory().unwrap();
        db.record_task_birth("g1", "2025-01-01T00:00:00Z")
            .await
            .unwrap();

        assert_eq!(
            db.get_task_birth("g1").await.unwrap().as_deref(),
            Some("2025-01-01T00:00:00Z")
        );
        assert_eq!(db.get_task_birth("missing").await.unwrap(), None);
    }

    // ── Integrity check ─────────────────────────────────────────────

    #[tokio::test]
    async fn check_integrity_returns_ok() {
        let db = Database::open_in_memory().unwrap();
        let result = db.check_integrity().await.unwrap();
        assert_eq!(result, "ok");
    }

    // ── Serialization contract ──────────────────────────────────────

    #[test]
    fn history_record_serializes_to_camel_case_free_json() {
        // HistoryRecord fields are snake_case matching SQL columns.
        // This test ensures serde doesn't silently rename anything.
        let rec = make_record("g1", "test.zip", "complete");
        let json = serde_json::to_value(&rec).unwrap();
        assert!(json.get("gid").is_some());
        assert!(json.get("total_length").is_some());
        assert!(json.get("added_at").is_some());
        assert!(json.get("task_type").is_some());
        // No camelCase — frontend expects snake_case from SQL columns
        assert!(json.get("totalLength").is_none());
        assert!(json.get("addedAt").is_none());
    }
}
