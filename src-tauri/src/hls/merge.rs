use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::error::AppError;

const EMPTY_CONCAT: &str = "empty-concat";
const INVALID_CHUNK: &str = "invalid-chunk";
const CONCAT_OVERFLOW: &str = "concat-overflow";

fn hls_err(code: &str) -> AppError {
    AppError::Hls(code.into())
}

fn hls_io(err: io::Error) -> AppError {
    AppError::Hls(err.to_string())
}

fn add_written(written: u64, n: u64) -> Result<u64, AppError> {
    written
        .checked_add(n)
        .ok_or_else(|| hls_err(CONCAT_OVERFLOW))
}

/// Concatenate `paths` in order into a new `output` file. Returns bytes written.
///
/// Uses `create_new`; existing output or IO failure becomes [`AppError::Hls`].
/// Source files are left in place.
pub async fn concat_files(paths: &[PathBuf], output: &Path) -> Result<u64, AppError> {
    if paths.is_empty() {
        return Err(hls_err(EMPTY_CONCAT));
    }

    let mut dest = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .await
        .map_err(hls_io)?;

    let mut written = 0u64;
    for path in paths {
        let mut src = tokio::fs::File::open(path).await.map_err(hls_io)?;
        let n = tokio::io::copy(&mut src, &mut dest).await.map_err(hls_io)?;
        written = add_written(written, n)?;
    }
    tokio::io::AsyncWriteExt::flush(&mut dest)
        .await
        .map_err(hls_io)?;
    Ok(written)
}

/// Combine `paths` into intermediate files of at most `chunk` parts under `temp_dir`.
///
/// Sync; uses `std::fs`. `chunk == 0` is an error. Sources are not deleted.
pub fn partial_combine(
    paths: &[PathBuf],
    temp_dir: &Path,
    chunk: usize,
) -> Result<Vec<PathBuf>, AppError> {
    if chunk == 0 {
        return Err(hls_err(INVALID_CHUNK));
    }

    let mut outputs = Vec::new();
    for (index, group) in paths.chunks(chunk).enumerate() {
        let output = temp_dir.join(format!("part-{index:04}"));
        concat_files_sync(group, &output)?;
        outputs.push(output);
    }
    Ok(outputs)
}

fn concat_files_sync(paths: &[PathBuf], output: &Path) -> Result<u64, AppError> {
    if paths.is_empty() {
        return Err(hls_err(EMPTY_CONCAT));
    }

    let mut dest = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(hls_io)?;

    let mut written = 0u64;
    for path in paths {
        let mut src = std::fs::File::open(path).map_err(hls_io)?;
        let n = io::copy(&mut src, &mut dest).map_err(hls_io)?;
        written = add_written(written, n)?;
    }
    dest.flush().map_err(hls_io)?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::{concat_files, partial_combine};
    use crate::error::AppError;
    use std::path::{Path, PathBuf};

    async fn write_named(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        tokio::fs::write(&path, bytes)
            .await
            .expect("write test fixture");
        path
    }

    async fn assert_exists(path: &Path) {
        assert!(
            tokio::fs::try_exists(path)
                .await
                .expect("check fixture exists"),
            "source {} should remain after concat",
            path.display()
        );
    }

    #[tokio::test]
    async fn concat_three_files_yields_abc() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = write_named(dir.path(), "a", b"a").await;
        let b = write_named(dir.path(), "b", b"b").await;
        let c = write_named(dir.path(), "c", b"c").await;
        let output = dir.path().join("out");

        let n = concat_files(&[a.clone(), b.clone(), c.clone()], &output)
            .await
            .expect("concat");

        assert_eq!(n, 3);
        let body = tokio::fs::read(&output).await.expect("read concat output");
        assert_eq!(body, b"abc");
        assert_exists(&a).await;
        assert_exists(&b).await;
        assert_exists(&c).await;
    }

    #[tokio::test]
    async fn concat_fmp4_init_then_fragments() {
        let dir = tempfile::tempdir().expect("tempdir");
        let init = write_named(dir.path(), "init", b"INIT").await;
        let s1 = write_named(dir.path(), "s1", b"S1").await;
        let s2 = write_named(dir.path(), "s2", b"S2").await;
        let output = dir.path().join("out.mp4");

        let n = concat_files(&[init, s1, s2], &output)
            .await
            .expect("concat fmp4");

        assert_eq!(n, 8);
        let body = tokio::fs::read(&output).await.expect("read fmp4 output");
        assert_eq!(body, b"INITS1S2");
    }

    #[tokio::test]
    async fn concat_empty_paths_is_err() {
        let dir = tempfile::tempdir().expect("tempdir");
        let output = dir.path().join("out");
        let err = concat_files(&[], &output)
            .await
            .expect_err("empty concat must fail");
        assert!(
            matches!(err, AppError::Hls(_)),
            "expected AppError::Hls, got {err}"
        );
    }

    #[tokio::test]
    async fn concat_create_new_failure_is_hls() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = write_named(dir.path(), "a", b"a").await;
        let output = dir.path().join("out");
        tokio::fs::write(&output, b"existing")
            .await
            .expect("seed existing output");

        let err = concat_files(&[a], &output)
            .await
            .expect_err("existing output must fail create_new");
        assert!(
            matches!(err, AppError::Hls(_)),
            "expected AppError::Hls, got {err}"
        );
        assert!(
            !matches!(err, AppError::Io(_)),
            "create_new failure must not be AppError::Io"
        );
    }

    #[tokio::test]
    async fn partial_combine_chunk_two_then_concat_matches_direct() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = vec![
            write_named(dir.path(), "f0", b"w").await,
            write_named(dir.path(), "f1", b"x").await,
            write_named(dir.path(), "f2", b"y").await,
            write_named(dir.path(), "f3", b"z").await,
        ];

        let intermediates = partial_combine(&paths, dir.path(), 2).expect("partial_combine");
        assert_eq!(intermediates.len(), 2);

        let from_partial = dir.path().join("from-partial");
        concat_files(&intermediates, &from_partial)
            .await
            .expect("concat intermediates");
        let partial_body = tokio::fs::read(&from_partial)
            .await
            .expect("read partial concat");

        let direct = dir.path().join("direct");
        concat_files(&paths, &direct)
            .await
            .expect("concat original");
        let direct_body = tokio::fs::read(&direct).await.expect("read direct concat");

        assert_eq!(partial_body, direct_body);
        assert_eq!(direct_body, b"wxyz");
        for path in &paths {
            assert_exists(path).await;
        }
    }

    #[tokio::test]
    async fn partial_combine_zero_chunk_is_err() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = write_named(dir.path(), "a", b"a").await;
        let err = partial_combine(&[a], dir.path(), 0).expect_err("chunk 0 must fail");
        assert!(
            matches!(err, AppError::Hls(_)),
            "expected AppError::Hls, got {err}"
        );
    }
}
