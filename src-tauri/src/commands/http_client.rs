use reqwest::ClientBuilder;

fn proxy_server_has_scheme(server: &str) -> bool {
    let Some((scheme, _)) = server.split_once("://") else {
        return false;
    };
    scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Mirrors frontend `buildProxyUrlWithCredentials`: embed aria2-style split
/// credentials into a proxy URL suitable for reqwest.
pub(crate) fn build_proxy_url_with_credentials(
    server: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> String {
    let username = username.map(str::trim).unwrap_or("");
    let password = password.unwrap_or("");
    if username.is_empty() && password.is_empty() {
        return server.to_string();
    }

    let owned;
    let parse_target = if proxy_server_has_scheme(server) {
        server
    } else {
        owned = format!("http://{server}");
        owned.as_str()
    };

    match url::Url::parse(parse_target) {
        Ok(mut url) => {
            let _ = url.set_username(username);
            let _ = url.set_password(if password.is_empty() {
                None
            } else {
                Some(password)
            });
            url.to_string()
        }
        Err(_) => server.to_string(),
    }
}

pub(crate) fn apply_explicit_proxy(
    builder: ClientBuilder,
    proxy: &Option<String>,
    scope: &str,
) -> ClientBuilder {
    match proxy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(server) => match reqwest::Proxy::all(server) {
            Ok(proxy) => builder.proxy(proxy),
            Err(e) => {
                log::warn!("{scope}: invalid proxy config: {e}");
                builder.no_proxy()
            }
        },
        None => builder.no_proxy(),
    }
}
