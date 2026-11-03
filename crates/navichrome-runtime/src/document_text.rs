//! Editor-tolerant text comparison for canvas-backed documents.
//!
//! Canvas editors paint their text and do not expose it through the DOM. The
//! proof path asks the editor to copy the selection into a page-owned
//! `DataTransfer` and passes that text here. This module only normalizes and
//! compares the result; it never reads or writes the user's system clipboard.

/// Normalize text for human-readable comparison: newlines, non-breaking
/// spaces, smart punctuation, and invisible bidi/zero-width marks vary between
/// what was typed and what an editor stores.
pub fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\u{00a0}' | '\u{202f}' => out.push(' '),
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => out.push('\''),
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => out.push('"'),
            '\u{2013}' | '\u{2014}' | '\u{2212}' => out.push('-'),
            '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}' => {}
            other => out.push(other),
        }
    }
    out
}

/// Canonical form used to prove insertion despite autocorrect: case, spacing,
/// and punctuation are editor policy, the letters and digits are the content.
pub fn canonical_alnum(text: &str) -> String {
    normalize_text(text)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Up to three evenly spaced 40-character windows of the typed text. Three
/// windows make a lucky substring collision unlikely; one is enough when the
/// inserted text is short.
pub fn verification_windows(typed: &str) -> Vec<String> {
    const WINDOW: usize = 40;
    const MIN: usize = 16;
    let canonical: Vec<char> = canonical_alnum(typed).chars().collect();
    if canonical.len() < MIN {
        return Vec::new();
    }
    let width = WINDOW.min(canonical.len());
    // Spread the windows over the start positions that exist. Anchoring on
    // fractions of the whole string collapses to one window as soon as the text
    // is barely longer than a window, which silently weakened verification.
    let max_start = canonical.len().saturating_sub(width);
    let mut starts: Vec<usize> = Vec::new();
    for start in [0, max_start / 2, max_start] {
        if !starts.contains(&start) {
            starts.push(start);
        }
    }
    let mut windows: Vec<String> = Vec::new();
    for start in starts {
        let window: String = canonical[start..start + width].iter().collect();
        if !windows.contains(&window) {
            windows.push(window);
        }
    }
    windows
}

/// Evidence that typed text is present in a copied document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextMatch {
    pub matched_windows: usize,
    pub sampled_windows: usize,
    pub exact_contains: bool,
}

impl TextMatch {
    pub fn proven(&self) -> bool {
        self.sampled_windows > 0 && self.matched_windows == self.sampled_windows
    }
}

/// Compare typed text with the document text a copy produced.
pub fn verify_typed_text(typed: &str, document: &str) -> TextMatch {
    let windows = verification_windows(typed);
    let canonical_document = canonical_alnum(document);
    let matched_windows = windows
        .iter()
        .filter(|window| canonical_document.contains(window.as_str()))
        .count();
    let normalized_document = normalize_text(document);
    let normalized_typed = normalize_text(typed).trim().to_owned();
    let exact_contains = !normalized_typed.is_empty()
        && normalized_document.contains(normalized_typed.lines().next().unwrap_or("").trim());
    TextMatch {
        matched_windows,
        sampled_windows: windows.len(),
        exact_contains,
    }
}

/// Stable non-cryptographic fingerprint for correlating two receipts without
/// exposing document contents.
pub fn text_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_is_editor_tolerant() {
        assert_eq!(normalize_text("a\r\nb\u{00a0}c\u{200b}"), "a\nb c");
        assert_eq!(
            normalize_text("\u{201c}hi\u{201d} \u{2014} ok"),
            "\"hi\" - ok"
        );
        assert_eq!(canonical_alnum("Hello, World!"), "helloworld");
        assert_eq!(canonical_alnum("CAFÉ"), "café");
    }

    #[test]
    fn windows_are_evenly_sampled_and_bounded() {
        let typed = "NaviChrome typed this into a fresh Google Doc. Each character arrived as a trusted key event, paced like a person typing.";
        let windows = verification_windows(typed);
        let canonical = canonical_alnum(typed);
        assert_eq!(windows.len(), 3);
        assert!(windows.iter().all(|window| window.len() == 40));
        assert!(
            windows
                .iter()
                .all(|window| canonical.contains(window.as_str()))
        );
        assert!(verification_windows("too short").is_empty());
    }

    #[test]
    fn autocorrect_punctuation_and_caps_still_match() {
        let typed = "General partner co-founder; it is \"necessary\" -- and it's 2026.";
        let document = "General Partner co-founder; it is “necessary” — and it’s 2026.";
        let result = verify_typed_text(typed, document);
        assert!(result.proven(), "{result:?}");
        assert_eq!(result.sampled_windows, 3);
    }

    #[test]
    fn absent_text_is_not_proven() {
        let typed = "NaviChrome typed this into a fresh Google Doc, and every character was paced.";
        let document = "An unrelated pre-existing paragraph with nothing in common.";
        let result = verify_typed_text(typed, document);
        assert!(!result.proven());
    }

    #[test]
    fn hash_is_stable() {
        assert_eq!(text_hash("abc"), text_hash("abc"));
        assert_ne!(text_hash("abc"), text_hash("abd"));
    }
}
