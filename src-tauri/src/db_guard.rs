//! Pre-flight database migration compatibility check.
//!
//! Runs **before** `tauri_plugin_sql` initializes to prevent panics when
//! the user downgrades to a version whose binary does not register all
//! previously applied migrations.
//!
//! # Strategy
//!
//! 1. Open `history.db` read-only with `rusqlite` (no tauri dependency).
//! 2. Query `_sqlx_migrations` for applied version numbers.
//! 3. Compare against [`REGISTERED_VERSIONS`] (hardcoded in this binary).
//! 4. On conflict → show a native OS dialog via `rfd` (no WebView needed).
//!    - **OK** → delete the database files and let the app start fresh.
//!    - **Cancel** → exit the process immediately.
//!
//! # i18n
//!
//! The dialog reads the user's saved locale from `config.json` on disk
//! (the `tauri-plugin-store` file), falling back to `sys_locale` and
//! finally `en-US`.  All 27 supported locales have native translations.

use std::path::Path;

/// Migration versions registered in the current binary.
///
/// **MUST** be kept in sync with the `add_migrations()` vec in `lib.rs`.
/// When adding a new migration, append its version here as well.
const REGISTERED_VERSIONS: &[i64] = &[1, 2, 3];

// ─── Public API ──────────────────────────────────────────────────────

/// Checks `history.db` for migration versions unknown to this binary.
///
/// - Missing DB file or missing `_sqlx_migrations` table → no-op.
/// - All applied versions in [`REGISTERED_VERSIONS`] → no-op.
/// - Unknown versions → native dialog; user picks reset or quit.
pub fn check(app_data_dir: &Path) {
    let db_path = app_data_dir.join("history.db");
    if !db_path.exists() {
        return; // Fresh install — nothing to check.
    }

    let unknown = match find_unknown_versions(&db_path) {
        Ok(v) => v,
        Err(e) => {
            // Cannot read DB — let tauri_plugin_sql handle it normally.
            log::debug!("db_guard: skipping check: {}", e);
            return;
        }
    };

    if unknown.is_empty() {
        return; // All migrations recognised — safe to proceed.
    }

    log::warn!(
        "db_guard: found {} unknown migration version(s): {:?}",
        unknown.len(),
        unknown
    );

    // Android: no native message dialog backend (rfd is desktop-only).
    // Reset the database automatically and log it — the WebView is the
    // only UI surface on mobile.
    #[cfg(target_os = "android")]
    {
        log::warn!("db_guard: android reset-on-conflict — deleting history.db");
        delete_db_files(app_data_dir);
        return;
    }

    #[cfg(not(target_os = "android"))]
    {
        let locale = detect_locale(app_data_dir);
        let (title, body, ok_label, cancel_label) = get_dialog_texts(&locale);

        let result = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title(title)
            .set_description(body)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                ok_label.to_string(),
                cancel_label.to_string(),
            ))
            .show();

        match result {
            rfd::MessageDialogResult::Custom(ref s) if s == ok_label => {
                log::info!("db_guard: user chose RESET — deleting history.db");
                delete_db_files(app_data_dir);
            }
            _ => {
                log::info!("db_guard: user chose QUIT");
                std::process::exit(0);
            }
        }
    }
}

// ─── Database inspection ─────────────────────────────────────────────

/// Opens the DB read-only and returns migration versions absent from
/// [`REGISTERED_VERSIONS`].
fn find_unknown_versions(db_path: &Path) -> Result<Vec<i64>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("failed to open DB: {e}"))?;

    // Fresh databases may not have the migrations tracking table yet.
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master \
             WHERE type = 'table' AND name = '_sqlx_migrations'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to check table existence: {e}"))?;

    if !table_exists {
        return Ok(vec![]);
    }

    let mut stmt = conn
        .prepare(
            "SELECT version FROM _sqlx_migrations \
             WHERE success = 1 ORDER BY version",
        )
        .map_err(|e| format!("failed to prepare query: {e}"))?;

    let applied: Vec<i64> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| format!("failed to query versions: {e}"))?
        .filter_map(std::result::Result::ok)
        .collect();

    let unknown: Vec<i64> = applied
        .into_iter()
        .filter(|v| !REGISTERED_VERSIONS.contains(v))
        .collect();

    Ok(unknown)
}

// ─── File cleanup ────────────────────────────────────────────────────

/// Deletes the SQLite database and its WAL/SHM companion files.
fn delete_db_files(app_data_dir: &Path) {
    for suffix in &["", "-wal", "-shm"] {
        let file = app_data_dir.join(format!("history.db{suffix}"));
        if file.exists() {
            match std::fs::remove_file(&file) {
                Ok(()) => log::info!("db_guard: deleted {}", file.display()),
                Err(e) => log::warn!("db_guard: failed to delete {}: {}", file.display(), e),
            }
        }
    }
}

// ─── Locale detection ────────────────────────────────────────────────

/// Reads the user's preferred locale without any Tauri dependency.
///
/// 1. Parse `config.json` (tauri-plugin-store format) → `preferences.locale`
/// 2. Fall back to `sys_locale::get_locale()` (OS language)
/// 3. Fall back to `"en-US"`
#[cfg(any(not(target_os = "android"), test))]
fn detect_locale(app_data_dir: &Path) -> String {
    // 1. Saved user preference
    let config_path = app_data_dir.join("config.json");
    if let Ok(file) = std::fs::File::open(config_path) {
        if let Ok(json) = serde_json::from_reader::<_, serde_json::Value>(file) {
            if let Some(locale) = json
                .get("preferences")
                .and_then(|p| p.get("locale"))
                .and_then(|v| v.as_str())
            {
                if !locale.is_empty() {
                    return locale.to_string();
                }
            }
        }
    }

    // 2. System locale
    sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string())
}

// ─── i18n: 27 locale translations ───────────────────────────────────

/// Returns `(title, description, ok_label, cancel_label)` for the conflict dialog.
#[cfg(any(not(target_os = "android"), test))]
fn get_dialog_texts(locale: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match locale {
        "zh-CN" => (
            "数据库版本不兼容",
            "下载历史数据库由更新版本的 Motrix Next 创建，\n\
             与当前版本不兼容。\n\n\
             继续使用需要重置下载历史记录。\n\
             已下载的文件不会受到影响。",
            "重置并启动",
            "退出",
        ),
        "zh-TW" => (
            "資料庫版本不相容",
            "下載歷史資料庫由更新版本的 Motrix Next 建立，\n\
             與目前版本不相容。\n\n\
             繼續使用需要重設下載歷史記錄。\n\
             已下載的檔案不會受到影響。",
            "重設並啟動",
            "退出",
        ),
        "ja" => (
            "データベースバージョンの不一致",
            "ダウンロード履歴データベースは新しいバージョンの Motrix Next で作成されたため、\
             このバージョンとは互換性がありません。\n\n\
             続行するにはダウンロード履歴をリセットする必要があります。\n\
             ダウンロード済みファイルには影響しません。",
            "リセットして起動",
            "終了",
        ),
        "ko" => (
            "데이터베이스 버전 충돌",
            "다운로드 기록 데이터베이스가 최신 버전의 Motrix Next에서 생성되어 \
             현재 버전과 호환되지 않습니다.\n\n\
             계속하려면 다운로드 기록을 초기화해야 합니다.\n\
             다운로드된 파일은 영향을 받지 않습니다.",
            "초기화 후 시작",
            "종료",
        ),
        "ar" => (
            "تعارض في إصدار قاعدة البيانات",
            "تم إنشاء قاعدة بيانات سجل التنزيل بواسطة إصدار أحدث من Motrix Next \
             وهي غير متوافقة مع هذا الإصدار.\n\n\
             للمتابعة، يجب إعادة تعيين سجل التنزيل.\n\
             لن تتأثر الملفات التي تم تنزيلها.",
            "إعادة تعيين وبدء",
            "خروج",
        ),
        "bg" => (
            "Конфликт на версиите на базата данни",
            "Базата данни с история на изтеглянията е създадена от по-нова версия на Motrix Next \
             и е несъвместима с тази версия.\n\n\
             За да продължите, историята на изтеглянията трябва да бъде нулирана.\n\
             Вашите изтеглени файлове НЯМА да бъдат засегнати.",
            "Нулиране и стартиране",
            "Изход",
        ),
        "ca" => (
            "Conflicte de versió de la base de dades",
            "La base de dades de l'historial de baixades va ser creada per una versió més nova de \
             Motrix Next i no és compatible amb aquesta versió.\n\n\
             Per continuar, l'historial de baixades s'ha de restablir.\n\
             Els fitxers baixats NO es veuran afectats.",
            "Restablir i iniciar",
            "Sortir",
        ),
        "de" => (
            "Datenbankversionskonflikt",
            "Die Download-Verlaufsdatenbank wurde von einer neueren Version von Motrix Next \
             erstellt und ist mit dieser Version nicht kompatibel.\n\n\
             Um fortzufahren, muss der Download-Verlauf zurückgesetzt werden.\n\
             Ihre heruntergeladenen Dateien sind davon nicht betroffen.",
            "Zurücksetzen und starten",
            "Beenden",
        ),
        "el" => (
            "Σύγκρουση έκδοσης βάσης δεδομένων",
            "Η βάση δεδομένων ιστορικού λήψεων δημιουργήθηκε από μια νεότερη έκδοση του Motrix Next \
             και δεν είναι συμβατή με αυτήν την έκδοση.\n\n\
             Για να συνεχίσετε, το ιστορικό λήψεων πρέπει να επαναφερθεί.\n\
             Τα αρχεία που έχετε κατεβάσει ΔΕΝ θα επηρεαστούν.",
            "Επαναφορά και εκκίνηση",
            "Έξοδος",
        ),
        "es" => (
            "Conflicto de versión de la base de datos",
            "La base de datos del historial de descargas fue creada por una versión más reciente de \
             Motrix Next y no es compatible con esta versión.\n\n\
             Para continuar, se debe restablecer el historial de descargas.\n\
             Los archivos descargados NO se verán afectados.",
            "Restablecer e iniciar",
            "Salir",
        ),
        "fa" => (
            "تعارض نسخه پایگاه داده",
            "پایگاه داده تاریخچه دانلود توسط نسخه جدیدتری از Motrix Next ایجاد شده \
             و با این نسخه سازگار نیست.\n\n\
             برای ادامه، تاریخچه دانلود باید بازنشانی شود.\n\
             فایل‌های دانلود شده تحت تأثیر قرار نخواهند گرفت.",
            "بازنشانی و شروع",
            "خروج",
        ),
        "fr" => (
            "Conflit de version de la base de données",
            "La base de données de l'historique des téléchargements a été créée par une version \
             plus récente de Motrix Next et n'est pas compatible avec cette version.\n\n\
             Pour continuer, l'historique des téléchargements doit être réinitialisé.\n\
             Vos fichiers téléchargés ne seront PAS affectés.",
            "Réinitialiser et démarrer",
            "Quitter",
        ),
        "hu" => (
            "Adatbázis verzióütközés",
            "A letöltési előzmények adatbázisát a Motrix Next egy újabb verziója hozta létre, \
             és nem kompatibilis ezzel a verzióval.\n\n\
             A folytatáshoz a letöltési előzményeket vissza kell állítani.\n\
             A letöltött fájlokat ez NEM érinti.",
            "Visszaállítás és indítás",
            "Kilépés",
        ),
        "hi" => (
            "डेटाबेस संस्करण असंगत है",
            "डाउनलोड इतिहास डेटाबेस Motrix Next के नए संस्करण से बनाया गया है \
             और इस संस्करण के साथ संगत नहीं है।\n\n\
             जारी रखने के लिए डाउनलोड इतिहास रीसेट करना होगा।\n\
             डाउनलोड की गई फ़ाइलों पर कोई असर नहीं पड़ेगा।",
            "रीसेट करके शुरू करें",
            "बाहर निकलें",
        ),
        "id" => (
            "Konflik Versi Database",
            "Database riwayat unduhan dibuat oleh versi Motrix Next yang lebih baru \
             dan tidak kompatibel dengan versi ini.\n\n\
             Untuk melanjutkan, riwayat unduhan harus direset.\n\
             File yang sudah diunduh TIDAK akan terpengaruh.",
            "Reset dan Mulai",
            "Keluar",
        ),
        "it" => (
            "Conflitto versione database",
            "Il database della cronologia download è stato creato da una versione più recente di \
             Motrix Next e non è compatibile con questa versione.\n\n\
             Per continuare, la cronologia download deve essere reimpostata.\n\
             I file scaricati NON saranno interessati.",
            "Reimposta e avvia",
            "Esci",
        ),
        "nb" => (
            "Databaseversjonskonflikt",
            "Nedlastingshistorikkdatabasen ble opprettet av en nyere versjon av Motrix Next \
             og er ikke kompatibel med denne versjonen.\n\n\
             For å fortsette må nedlastingshistorikken tilbakestilles.\n\
             De nedlastede filene dine vil IKKE bli påvirket.",
            "Tilbakestill og start",
            "Avslutt",
        ),
        "nl" => (
            "Databaseversieconflict",
            "De downloaddatabase is aangemaakt door een nieuwere versie van Motrix Next \
             en is niet compatibel met deze versie.\n\n\
             Om door te gaan moet de downloadgeschiedenis worden gereset.\n\
             Uw gedownloade bestanden worden NIET beïnvloed.",
            "Resetten en starten",
            "Afsluiten",
        ),
        "pl" => (
            "Konflikt wersji bazy danych",
            "Baza danych historii pobierania została utworzona przez nowszą wersję Motrix Next \
             i jest niezgodna z tą wersją.\n\n\
             Aby kontynuować, historia pobierania musi zostać zresetowana.\n\
             Pobrane pliki NIE zostaną zmienione.",
            "Resetuj i uruchom",
            "Wyjdź",
        ),
        "pt-BR" => (
            "Conflito de versão do banco de dados",
            "O banco de dados do histórico de downloads foi criado por uma versão mais recente do \
             Motrix Next e é incompatível com esta versão.\n\n\
             Para continuar, o histórico de downloads precisa ser redefinido.\n\
             Seus arquivos baixados NÃO serão afetados.",
            "Redefinir e iniciar",
            "Sair",
        ),
        "ro" => (
            "Conflict de versiune a bazei de date",
            "Baza de date a istoricului descărcărilor a fost creată de o versiune mai nouă \
             a Motrix Next și este incompatibilă cu această versiune.\n\n\
             Pentru a continua, istoricul descărcărilor trebuie resetat.\n\
             Fișierele descărcate NU vor fi afectate.",
            "Resetare și pornire",
            "Ieșire",
        ),
        "ru" => (
            "Конфликт версий базы данных",
            "База данных истории загрузок была создана более новой версией Motrix Next \
             и несовместима с текущей версией.\n\n\
             Для продолжения необходимо сбросить историю загрузок.\n\
             Загруженные файлы НЕ будут затронуты.",
            "Сбросить и запустить",
            "Выход",
        ),
        "th" => (
            "ฐานข้อมูลเวอร์ชันขัดแย้ง",
            "ฐานข้อมูลประวัติการดาวน์โหลดถูกสร้างโดย Motrix Next เวอร์ชันใหม่กว่า \
             และไม่สามารถใช้งานร่วมกับเวอร์ชันนี้ได้\n\n\
             หากต้องการดำเนินการต่อ จะต้องรีเซ็ตประวัติการดาวน์โหลด\n\
             ไฟล์ที่ดาวน์โหลดแล้วจะไม่ได้รับผลกระทบ",
            "รีเซ็ตและเริ่มต้น",
            "ออก",
        ),
        "tr" => (
            "Veritabanı Sürüm Uyumsuzluğu",
            "İndirme geçmişi veritabanı Motrix Next'in daha yeni bir sürümü tarafından \
             oluşturulmuş olup bu sürümle uyumlu değildir.\n\n\
             Devam etmek için indirme geçmişi sıfırlanmalıdır.\n\
             İndirilen dosyalarınız etkilenmeyecektir.",
            "Sıfırla ve başlat",
            "Çıkış",
        ),
        "uk" => (
            "Конфлікт версій бази даних",
            "Базу даних історії завантажень було створено новішою версією Motrix Next, \
             яка несумісна з поточною.\n\n\
             Для продовження необхідно скинути історію завантажень.\n\
             Завантажені файли НЕ будуть порушені.",
            "Скинути та запустити",
            "Вихід",
        ),
        "vi" => (
            "Xung đột phiên bản cơ sở dữ liệu",
            "Cơ sở dữ liệu lịch sử tải xuống được tạo bởi phiên bản Motrix Next mới hơn \
             và không tương thích với phiên bản này.\n\n\
             Để tiếp tục, lịch sử tải xuống cần được đặt lại.\n\
             Các tệp đã tải xuống sẽ KHÔNG bị ảnh hưởng.",
            "Đặt lại và khởi động",
            "Thoát",
        ),
        // Default: English (covers en-US, en-GB, and any unrecognised locale)
        _ => (
            "Database Version Conflict",
            "The download history database was created by a newer version of Motrix Next \
             and is incompatible with this version.\n\n\
             To continue, the download history must be reset.\n\
             Your downloaded files will NOT be affected.",
            "Reset and Start",
            "Quit",
        ),
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Helper: create a temporary SQLite DB with the given migration versions.
    fn create_test_db(dir: &Path, versions: &[i64]) {
        let db_path = dir.join("history.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open test DB");
        conn.execute_batch(
            "CREATE TABLE _sqlx_migrations (
                version  BIGINT PRIMARY KEY,
                description TEXT NOT NULL DEFAULT '',
                installed_on TEXT NOT NULL DEFAULT '',
                success  BOOLEAN NOT NULL DEFAULT 1,
                checksum BLOB NOT NULL DEFAULT X'00',
                execution_time BIGINT NOT NULL DEFAULT 0
            )",
        )
        .expect("create migrations table");

        for &v in versions {
            conn.execute(
                "INSERT INTO _sqlx_migrations (version, success) VALUES (?1, 1)",
                [v],
            )
            .expect("insert version");
        }
    }

    #[test]
    fn fresh_install_no_db() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let result = find_unknown_versions(&dir.path().join("history.db"));
        assert!(result.is_err()); // File doesn't exist → error (handled by caller)
    }

    #[test]
    fn db_without_migrations_table() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let db_path = dir.path().join("history.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.execute_batch("CREATE TABLE dummy (id INTEGER)")
            .expect("create dummy");
        drop(conn);

        let unknown = find_unknown_versions(&db_path).expect("should succeed");
        assert!(unknown.is_empty());
    }

    #[test]
    fn all_versions_recognised() {
        let dir = tempfile::tempdir().expect("tmpdir");
        create_test_db(dir.path(), &[1, 2, 3]);

        let unknown =
            find_unknown_versions(&dir.path().join("history.db")).expect("should succeed");
        assert!(unknown.is_empty());
    }

    #[test]
    fn unknown_version_detected() {
        let dir = tempfile::tempdir().expect("tmpdir");
        create_test_db(dir.path(), &[1, 2, 3, 4]);

        let unknown =
            find_unknown_versions(&dir.path().join("history.db")).expect("should succeed");
        assert_eq!(unknown, vec![4]);
    }

    #[test]
    fn multiple_unknown_versions() {
        let dir = tempfile::tempdir().expect("tmpdir");
        create_test_db(dir.path(), &[1, 2, 3, 4, 5, 6]);

        let unknown =
            find_unknown_versions(&dir.path().join("history.db")).expect("should succeed");
        assert_eq!(unknown, vec![4, 5, 6]);
    }

    #[test]
    fn delete_removes_all_db_files() {
        let dir = tempfile::tempdir().expect("tmpdir");
        fs::write(dir.path().join("history.db"), b"data").expect("write db");
        fs::write(dir.path().join("history.db-wal"), b"wal").expect("write wal");
        fs::write(dir.path().join("history.db-shm"), b"shm").expect("write shm");

        delete_db_files(dir.path());

        assert!(!dir.path().join("history.db").exists());
        assert!(!dir.path().join("history.db-wal").exists());
        assert!(!dir.path().join("history.db-shm").exists());
    }

    #[test]
    fn locale_detection_from_config() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let config = r#"{"preferences":{"locale":"ja"}}"#;
        fs::write(dir.path().join("config.json"), config).expect("write config");

        let locale = detect_locale(dir.path());
        assert_eq!(locale, "ja");
    }

    #[test]
    fn locale_fallback_no_config() {
        let dir = tempfile::tempdir().expect("tmpdir");
        // No config.json → falls back to sys_locale or en-US.
        let locale = detect_locale(dir.path());
        assert!(!locale.is_empty());
    }

    #[test]
    fn locale_fallback_empty_locale() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let config = r#"{"preferences":{"locale":""}}"#;
        fs::write(dir.path().join("config.json"), config).expect("write config");

        let locale = detect_locale(dir.path());
        // Empty string → fallback to sys_locale, never returns "".
        assert!(!locale.is_empty());
    }

    #[test]
    fn all_27_locales_have_translations() {
        let locales = [
            "ar", "bg", "ca", "de", "el", "en-US", "es", "fa", "fr", "hu", "hi", "id", "it", "ja",
            "ko", "nb", "nl", "pl", "pt-BR", "ro", "ru", "th", "tr", "uk", "vi", "zh-CN", "zh-TW",
        ];
        for locale in locales {
            let (title, body, ok_label, cancel_label) = get_dialog_texts(locale);
            assert!(!title.is_empty(), "empty title for locale {locale}");
            assert!(!body.is_empty(), "empty body for locale {locale}");
            assert!(!ok_label.is_empty(), "empty ok_label for locale {locale}");
            assert!(
                !cancel_label.is_empty(),
                "empty cancel_label for locale {locale}"
            );
        }
    }
}
