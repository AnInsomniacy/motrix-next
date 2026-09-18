//! Apply desktop preferences to browser download intent.
use super::contracts::AddRequest;
use crate::error::AppError;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Preferences {
    #[serde(default = "enabled")]
    pub auto_submit_from_extension: bool,
    #[serde(default = "enabled")]
    pub silent_auto_submit_from_extension: bool,
    #[serde(default = "enabled")]
    use_independent_download_window: bool,
    dir: String,
    file_category_enabled: bool,
    file_categories: Vec<Category>,
    user_agent: String,
    user_agent_profiles: Vec<Profile>,
    user_agent_rules: Vec<Rule>,
}
fn enabled() -> bool {
    true
}
impl Preferences {
    pub(super) fn confirmation_route(&self) -> crate::services::external_input::ExternalInputRoute {
        use crate::services::external_input::ExternalInputRoute;
        if !self.auto_submit_from_extension && self.use_independent_download_window {
            ExternalInputRoute::DownloadConfirmation
        } else {
            ExternalInputRoute::MainWindow
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Category {
    directory: String,
    extensions: Vec<String>,
    #[serde(default)]
    url_patterns: Vec<String>,
    #[serde(default)]
    url_pattern_mode: String,
}
#[derive(Deserialize)]
struct Profile {
    id: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rule {
    enabled: bool,
    host_pattern: String,
    profile_id: String,
    override_plugin: bool,
}

pub(super) fn load(app: &AppHandle) -> Result<Preferences, AppError> {
    let value = app
        .store("config.json")
        .map_err(|error| AppError::Store(error.to_string()))?
        .get("preferences")
        .ok_or_else(|| AppError::Store("Preferences are unavailable".into()))?;
    Ok(serde_json::from_value(value)?)
}

fn matches(pattern: &str, value: &str, regex: bool) -> bool {
    let expression = if regex {
        pattern.to_owned()
    } else {
        format!("^{}$", regex::escape(pattern).replace("\\*", ".*"))
    };
    regex::RegexBuilder::new(&expression)
        .case_insensitive(true)
        .build()
        .is_ok_and(|matcher| matcher.is_match(value))
}

pub(super) fn options(prefs: &Preferences, request: &AddRequest) -> Result<Value, AppError> {
    let urls: Vec<&str> = [
        request.final_url.as_deref(),
        Some(request.url.as_str()),
        request.referer.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut options = json!({});
    if !prefs.dir.is_empty() {
        options["dir"] = prefs.dir.clone().into();
    }
    if let Some(name) = request.filename.as_ref().filter(|name| !name.is_empty()) {
        options["filename-hint"] = name.clone().into();
        options["filename-hint-source"] = serde_json::to_value(request.filename_source)?;
    }
    if prefs.file_category_enabled {
        let name = request.filename.clone().unwrap_or_else(|| {
            url::Url::parse(urls[0])
                .ok()
                .map(|url| {
                    urlencoding::decode(url.path())
                        .map(std::borrow::Cow::into_owned)
                        .unwrap_or_else(|_| url.path().to_owned())
                })
                .unwrap_or_default()
        });
        let extension = std::path::Path::new(&name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("");
        if let Some(category) = prefs.file_categories.iter().find(|category| {
            !(category.extensions.is_empty() && category.url_patterns.is_empty())
                && (category.extensions.is_empty()
                    || category
                        .extensions
                        .iter()
                        .any(|ext| ext.eq_ignore_ascii_case(extension)))
                && (category.url_patterns.is_empty()
                    || category.url_patterns.iter().any(|pattern| {
                        urls.iter()
                            .any(|url| matches(pattern, url, category.url_pattern_mode == "regex"))
                    }))
        }) {
            options["dir"] = std::path::Path::new(&prefs.dir)
                .join(&category.directory)
                .to_string_lossy()
                .into_owned()
                .into();
        }
    }
    let rule = prefs
        .user_agent_rules
        .iter()
        .filter(|rule| rule.enabled)
        .find_map(|rule| {
            let matched = urls
                .iter()
                .filter_map(|value| url::Url::parse(value).ok())
                .any(|url| {
                    url.host_str()
                        .is_some_and(|host| matches(&rule.host_pattern, host, false))
                });
            matched
                .then(|| {
                    prefs
                        .user_agent_profiles
                        .iter()
                        .find(|profile| profile.id == rule.profile_id)
                        .map(|profile| (rule, profile))
                })
                .flatten()
        });
    let user_agent = match rule {
        Some((rule, profile))
            if rule.override_plugin || request.user_agent.as_deref().is_none_or(str::is_empty) =>
        {
            &profile.value
        }
        _ => request
            .user_agent
            .as_ref()
            .filter(|value| !value.is_empty())
            .unwrap_or(&prefs.user_agent),
    };
    let mut headers = reqwest::header::HeaderMap::new();
    for header in &request.request_headers {
        let name = reqwest::header::HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|error| AppError::InvalidInput(error.to_string()))?;
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|error| AppError::InvalidInput(error.to_string()))?;
        headers.insert(name, value);
    }
    for (name, value) in [
        ("cookie", request.cookie.as_deref()),
        ("referer", request.referer.as_deref()),
        ("user-agent", Some(user_agent.as_str())),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            let value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|error| AppError::InvalidInput(error.to_string()))?;
            headers.insert(reqwest::header::HeaderName::from_static(name), value);
        }
    }
    if !headers.is_empty() {
        let lines = headers
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| format!("{name}: {value}"))
                    .map_err(|error| AppError::InvalidInput(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        options["header"] = lines.join("\n").into();
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_route_respects_independent_window_and_auto_submit_preferences() {
        use crate::services::external_input::ExternalInputRoute;
        for (auto_submit, independent, expected) in [
            (false, None, ExternalInputRoute::DownloadConfirmation),
            (false, Some(true), ExternalInputRoute::DownloadConfirmation),
            (false, Some(false), ExternalInputRoute::MainWindow),
            (true, Some(true), ExternalInputRoute::MainWindow),
            (true, Some(false), ExternalInputRoute::MainWindow),
        ] {
            let mut saved = json!({ "autoSubmitFromExtension": auto_submit });
            if let Some(enabled) = independent {
                saved["useIndependentDownloadWindow"] = enabled.into();
            }
            let prefs: Preferences = serde_json::from_value(saved).unwrap();
            assert_eq!(prefs.confirmation_route(), expected);
        }
    }

    #[test]
    fn browser_intent_uses_matching_preferences_and_one_value_per_header() {
        let prefs: Preferences = serde_json::from_value(json!({
            "dir":"downloads",
            "fileCategoryEnabled":true,
            "fileCategories":[{
                "directory":"documents", "extensions":["pdf"],
                "urlPatterns":["https://*.example.test/*"]
            }],
            "userAgentProfiles":[{"id":"site", "value":"Site agent"}],
            "userAgentRules":[{
                "enabled":true,"hostPattern":"*.example.test",
                "profileId":"site","overridePlugin":true
            }]
        }))
        .unwrap();
        let request: AddRequest = serde_json::from_value(json!({
            "id":"intent", "url":"https://cdn.example.test/download",
            "filename":"report%20.pdf", "filenameSource":"browser",
            "userAgent":"Browser agent", "cookie":"session=current",
            "requestHeaders":[
                {"name":"User-Agent","value":"Captured agent"},
                {"name":"Cookie","value":"session=old"},
                {"name":"X-Token","value":"opaque"}
            ]
        }))
        .unwrap();
        let options = options(&prefs, &request).unwrap();
        assert_eq!(options["filename-hint"], "report%20.pdf");
        assert_eq!(options["filename-hint-source"], "browser");
        assert_eq!(
            std::path::Path::new(options["dir"].as_str().unwrap()),
            std::path::Path::new("downloads").join("documents")
        );
        let headers: Vec<_> = options["header"].as_str().unwrap().lines().collect();
        assert_eq!(headers.len(), 3);
        assert!(headers.contains(&"user-agent: Site agent"));
        assert!(headers.contains(&"cookie: session=current"));
        assert!(headers.contains(&"x-token: opaque"));
    }

    #[test]
    fn invalid_browser_headers_cannot_inject_another_request_header() {
        let request: AddRequest = serde_json::from_value(json!({
            "id":"intent", "url":"https://example.test/file",
            "referer":"https://example.test/\r\nX-Injected: value"
        }))
        .unwrap();
        assert!(matches!(
            options(&Preferences::default(), &request),
            Err(AppError::InvalidInput(_))
        ));
    }
}
