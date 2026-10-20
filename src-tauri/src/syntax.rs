//! Comment and string-literal regions, for "In comments / In string literals"
//! search filters. C# is parsed with tree-sitter; other languages report no
//! regions (so "In comments" finds nothing there and "Except…" finds everything).

use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct Regions {
    pub comments: Vec<(usize, usize)>,
    pub strings: Vec<(usize, usize)>,
}

const STRING_KINDS: &[&str] = &[
    "string_literal",
    "verbatim_string_literal",
    "raw_string_literal",
    "interpolated_string_expression",
    "character_literal",
];

pub fn regions(path: &Path, text: &str) -> Regions {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "cs" | "csx" => csharp(text).unwrap_or_default(),
        _ => Regions::default(),
    }
}

fn csharp(text: &str) -> Option<Regions> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(text, None)?;
    let mut out = Regions::default();
    let mut cursor = tree.walk();
    'walk: loop {
        let node = cursor.node();
        let kind = node.kind();
        let mut descend = true;
        if kind == "comment" {
            out.comments.push((node.start_byte(), node.end_byte()));
            descend = false;
        } else if STRING_KINDS.contains(&kind) {
            out.strings.push((node.start_byte(), node.end_byte()));
            descend = false;
        }
        if descend && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                continue 'walk;
            }
            if !cursor.goto_parent() {
                break 'walk;
            }
        }
    }
    Some(out)
}

/// True when `[start, end)` lies inside one of the sorted, disjoint `ranges`.
pub fn inside(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    let i = ranges.partition_point(|&(s, _)| s <= start);
    i > 0 && end <= ranges[i - 1].1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_comments_and_strings() {
        let src = "// head\nclass A { string s = \"Order\"; /* Order */ int Order; }\n";
        let r = regions(Path::new("A.cs"), src);
        let text = |(s, e): (usize, usize)| &src[s..e];
        assert_eq!(
            r.comments.iter().map(|&x| text(x)).collect::<Vec<_>>(),
            vec!["// head", "/* Order */"]
        );
        assert_eq!(
            r.strings.iter().map(|&x| text(x)).collect::<Vec<_>>(),
            vec!["\"Order\""]
        );
        let first = src.find("Order").unwrap();
        assert!(inside(&r.strings, first, first + 5));
        let last = src.rfind("Order").unwrap();
        assert!(!inside(&r.strings, last, last + 5) && !inside(&r.comments, last, last + 5));
    }

    #[test]
    fn other_languages_have_no_regions() {
        assert_eq!(
            regions(Path::new("a.json"), "{\"a\": 1}"),
            Regions::default()
        );
    }
}
