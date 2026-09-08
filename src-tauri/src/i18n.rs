//! Compile-time embedded localization for native UI and background services.

use fluent_langneg::{negotiate_languages, LanguageIdentifier, NegotiationStrategy};
use std::sync::OnceLock;

const FALLBACK_LOCALE: &str = "en-US";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMessage {
    pub title: String,
    pub body: String,
}

fn available_language_ids() -> &'static Vec<LanguageIdentifier> {
    static AVAILABLE: OnceLock<Vec<LanguageIdentifier>> = OnceLock::new();
    AVAILABLE.get_or_init(|| {
        rust_i18n::available_locales!()
            .iter()
            .filter_map(|locale| LanguageIdentifier::try_from_bytes(locale.as_bytes()).ok())
            .collect()
    })
}

pub fn resolve_supported_locale(raw_locale: &str) -> String {
    let normalized = raw_locale.trim().replace('_', "-");
    let Ok(requested) = LanguageIdentifier::try_from_bytes(normalized.as_bytes()) else {
        return FALLBACK_LOCALE.to_string();
    };
    let available = available_language_ids();
    let Some(fallback) = available
        .iter()
        .find(|locale| locale.to_string() == FALLBACK_LOCALE)
    else {
        return FALLBACK_LOCALE.to_string();
    };
    negotiate_languages(
        &[requested],
        available,
        Some(fallback),
        NegotiationStrategy::Matching,
    )
    .first()
    .map_or_else(|| FALLBACK_LOCALE.to_string(), ToString::to_string)
}

pub fn resolve_preferred_locale(configured_locale: &str) -> String {
    let requested = if configured_locale.trim().is_empty() || configured_locale == "auto" {
        sys_locale::get_locale().unwrap_or_else(|| FALLBACK_LOCALE.to_string())
    } else {
        configured_locale.to_string()
    };
    resolve_supported_locale(&requested)
}

pub fn download_start(locale: &str, task_name: &str, remaining: usize) -> NativeMessage {
    let body = if remaining == 0 {
        rust_i18n::t!(
            "notification.download-start-body",
            locale = locale,
            task_name = task_name
        )
    } else {
        rust_i18n::t!(
            "notification.download-batch-start-body",
            locale = locale,
            task_name = task_name,
            count = remaining
        )
    };
    NativeMessage {
        title: rust_i18n::t!("notification.download-start-title", locale = locale).into_owned(),
        body: body.into_owned(),
    }
}

pub fn download_complete(locale: &str, task_name: &str) -> NativeMessage {
    NativeMessage {
        title: rust_i18n::t!("notification.download-complete-title", locale = locale).into_owned(),
        body: rust_i18n::t!(
            "notification.download-complete-body",
            locale = locale,
            task_name = task_name
        )
        .into_owned(),
    }
}

pub fn bt_complete(locale: &str, task_name: &str) -> NativeMessage {
    NativeMessage {
        title: rust_i18n::t!("notification.bt-complete-title", locale = locale).into_owned(),
        body: rust_i18n::t!(
            "notification.bt-complete-body",
            locale = locale,
            task_name = task_name
        )
        .into_owned(),
    }
}

pub fn ed2k_complete(locale: &str, task_name: &str) -> NativeMessage {
    NativeMessage {
        title: rust_i18n::t!("notification.ed2k-complete-title", locale = locale).into_owned(),
        body: rust_i18n::t!(
            "notification.ed2k-complete-body",
            locale = locale,
            task_name = task_name
        )
        .into_owned(),
    }
}

pub fn download_failed(locale: &str, task_name: &str, reason: Option<&str>) -> NativeMessage {
    let reason = reason
        .filter(|message| !message.trim().is_empty())
        .map_or_else(
            || rust_i18n::t!("notification.error-unknown", locale = locale).into_owned(),
            str::to_string,
        );
    NativeMessage {
        title: rust_i18n::t!("notification.download-failed-title", locale = locale).into_owned(),
        body: rust_i18n::t!(
            "notification.download-failed-body",
            locale = locale,
            task_name = task_name,
            reason = reason
        )
        .into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_supported_locales() {
        assert_eq!(resolve_supported_locale("zh-Hans-CN"), "zh-CN");
        assert_eq!(resolve_supported_locale("zh-HK"), "zh-TW");
        assert_eq!(resolve_supported_locale("en-AU"), "en-US");
        assert_eq!(resolve_supported_locale("pt-PT"), "pt-BR");
        assert_eq!(resolve_supported_locale("xx-YY"), "en-US");
    }

    #[test]
    fn embeds_all_supported_locales() {
        let locales = rust_i18n::available_locales!();
        assert_eq!(locales.len(), 27);
        for locale in locales {
            let notification = download_complete(&locale, "file.zip");
            assert!(!notification.title.is_empty());
            assert!(notification.body.contains("file.zip"));
        }
    }

    #[test]
    fn formats_native_message_arguments() {
        assert_eq!(
            download_start("en-US", "file.zip", 2).body,
            "Downloading: file.zip and 2 other task(s)"
        );
        assert_eq!(
            download_failed("en-US", "file.zip", Some("Network error")).body,
            "file.zip: Network error"
        );
        assert_eq!(ed2k_complete("zh-CN", "file.zip").body, "共享中：file.zip");
    }
}
