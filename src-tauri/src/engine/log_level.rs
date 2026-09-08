pub(crate) const DEFAULT_ARIA2_LOG_LEVEL: &str = "info";

pub(crate) fn valid_aria2_log_level(level: &str) -> bool {
    matches!(level, "error" | "warn" | "info" | "debug" | "trace")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_spdlog_levels() {
        for level in ["error", "warn", "info", "debug", "trace"] {
            assert!(valid_aria2_log_level(level));
        }
    }
}
