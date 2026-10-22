//! Comment and string-literal regions, for "In comments / In string literals"
//! search filters. C# is parsed with tree-sitter; other languages report no
//! regions (so "In comments" finds nothing there and "Except…" finds everything).
//!
//! Also the outline of a C# file (types and members), for Code Vision: at
//! once, where a language server answers only once its projects compiled.

use std::path::Path;

use serde::Serialize;

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

// ---------------------------------------------------------------- outline

/// A 0-based line and UTF-16 column, as in LSP.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// A type or member, shaped like LSP's DocumentSymbol.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    /// The plain name: "Jump", "IFoo.Bar" (explicit implementation), "this[]".
    pub name: String,
    /// LSP SymbolKind.
    pub kind: u8,
    /// The whole declaration, attributes included.
    pub range: Range,
    /// The name.
    pub selection_range: Range,
    pub children: Vec<OutlineSymbol>,
}

// LSP SymbolKind.
const NAMESPACE: u8 = 3;
const CLASS: u8 = 5;
const METHOD: u8 = 6;
const PROPERTY: u8 = 7;
const CONSTRUCTOR: u8 = 9;
const ENUM: u8 = 10;
const INTERFACE: u8 = 11;
const STRUCT: u8 = 23;
const EVENT: u8 = 24;

struct Outliner<'a> {
    text: &'a str,
    line_starts: Vec<usize>,
}

impl Outliner<'_> {
    fn position(&self, p: tree_sitter::Point) -> Position {
        let start = self
            .line_starts
            .get(p.row)
            .copied()
            .unwrap_or(self.text.len());
        let before = self.text.get(start..start + p.column).unwrap_or("");
        Position {
            line: p.row as u32,
            character: before.encode_utf16().count() as u32,
        }
    }

    fn range(&self, n: tree_sitter::Node) -> Range {
        Range {
            start: self.position(n.start_position()),
            end: self.position(n.end_position()),
        }
    }

    fn text(&self, n: tree_sitter::Node) -> &str {
        &self.text[n.byte_range()]
    }

    fn symbol(
        &self,
        decl: tree_sitter::Node,
        kind: u8,
        name: String,
        at: tree_sitter::Node,
    ) -> OutlineSymbol {
        OutlineSymbol {
            name,
            kind,
            range: self.range(decl),
            selection_range: self.range(at),
            children: vec![],
        }
    }

    /// The symbols declared by the members of a namespace, type or file.
    fn members(&self, parent: tree_sitter::Node, out: &mut Vec<OutlineSymbol>) {
        let mut cursor = parent.walk();
        let children: Vec<_> = parent.children(&mut cursor).collect();
        for (i, n) in children.iter().enumerate() {
            // `namespace A.B;` holds the rest of the file.
            if n.kind() == "file_scoped_namespace_declaration" {
                if let Some(name) = n.child_by_field_name("name") {
                    let mut ns = self.symbol(*n, NAMESPACE, self.text(name).to_string(), name);
                    ns.range.end = self.position(parent.end_position());
                    for rest in &children[i + 1..] {
                        self.member(*rest, &mut ns.children);
                    }
                    out.push(ns);
                    return;
                }
            }
            self.member(*n, out);
        }
    }

    fn member(&self, n: tree_sitter::Node, out: &mut Vec<OutlineSymbol>) {
        let name = n.child_by_field_name("name");
        let kind = match n.kind() {
            "namespace_declaration" => NAMESPACE,
            "class_declaration" => CLASS,
            "record_declaration" if has_child(n, "struct") => STRUCT,
            "record_declaration" => CLASS,
            "struct_declaration" => STRUCT,
            "interface_declaration" => INTERFACE,
            "enum_declaration" => ENUM,
            "method_declaration" => METHOD,
            "constructor_declaration" => CONSTRUCTOR,
            "property_declaration" => PROPERTY,
            "event_declaration" => EVENT,
            "indexer_declaration" => {
                let mut c = n.walk();
                if let Some(this) = n.children(&mut c).find(|c| c.kind() == "this") {
                    out.push(self.symbol(n, PROPERTY, "this[]".into(), this));
                }
                return;
            }
            // `event Action A, B;`: one event per name.
            "event_field_declaration" => {
                let mut c = n.walk();
                for decl in n
                    .children(&mut c)
                    .filter(|c| c.kind() == "variable_declaration")
                {
                    let mut d = decl.walk();
                    for v in decl
                        .children(&mut d)
                        .filter(|c| c.kind() == "variable_declarator")
                    {
                        if let Some(name) = v.child_by_field_name("name") {
                            out.push(self.symbol(n, EVENT, self.text(name).to_string(), name));
                        }
                    }
                }
                return;
            }
            // `#if`/`#region` blocks and code the parser could not make sense of (mid-edit) hold members too.
            k if k.starts_with("preproc") || k == "ERROR" => {
                self.members(n, out);
                return;
            }
            _ => return,
        };
        let Some(name) = name else { return };
        let mut label = self.text(name).to_string();
        let mut c = n.walk();
        if let Some(iface) = n
            .children(&mut c)
            .find(|c| c.kind() == "explicit_interface_specifier")
        {
            label = format!(
                "{}{label}",
                self.text(iface).split_whitespace().collect::<String>()
            );
        }
        let mut symbol = self.symbol(n, kind, label, name);
        if let Some(body) = n.child_by_field_name("body") {
            if body.kind() == "declaration_list" {
                self.members(body, &mut symbol.children);
            }
        }
        out.push(symbol);
    }
}

fn has_child(n: tree_sitter::Node, kind: &str) -> bool {
    let mut c = n.walk();
    let found = n.children(&mut c).any(|c| c.kind() == kind);
    found
}

/// Namespaces, types and their methods, properties, constructors and events.
pub fn csharp_outline(text: &str) -> Vec<OutlineSymbol> {
    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .is_err()
    {
        return vec![];
    }
    let Some(tree) = parser.parse(text, None) else {
        return vec![];
    };
    let line_starts = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let o = Outliner { text, line_starts };
    let mut out = vec![];
    o.members(tree.root_node(), &mut out);
    out
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

    fn names(symbols: &[OutlineSymbol]) -> Vec<String> {
        symbols
            .iter()
            .flat_map(|s| {
                std::iter::once(format!("{}:{}", s.kind, s.name)).chain(
                    names(&s.children)
                        .into_iter()
                        .map(move |c| format!("{}/{c}", s.name)),
                )
            })
            .collect()
    }

    #[test]
    fn outlines_types_and_members() {
        let src = r#"namespace Game.Core;
[Serializable]
public sealed partial class Pool<T> : MonoBehaviour where T : Component
{
    public event Action Changed, Other;
    int this[int i] => i;
    [Test] public void Jump(int h) { void Local() {} }
    void IFoo.Bar() {}
    public int Size { get; set; }
    Pool() {}
    ~Pool() {}
#if UNITY_EDITOR
    void OnValidate() {}
#endif
    enum E { X, Y }
    record struct RS(int X);
    interface I { void M(); }
}
"#;
        let got = csharp_outline(src);
        assert_eq!(
            names(&got),
            [
                "3:Game.Core",
                "Game.Core/5:Pool",
                "Game.Core/Pool/24:Changed",
                "Game.Core/Pool/24:Other",
                "Game.Core/Pool/7:this[]",
                "Game.Core/Pool/6:Jump",
                "Game.Core/Pool/6:IFoo.Bar",
                "Game.Core/Pool/7:Size",
                "Game.Core/Pool/9:Pool",
                "Game.Core/Pool/6:OnValidate",
                "Game.Core/Pool/10:E",
                "Game.Core/Pool/23:RS",
                "Game.Core/Pool/11:I",
                "Game.Core/Pool/I/6:M",
            ]
        );
        let pool = &got[0].children[0];
        let col =
            |line: usize, word: &str| src.lines().nth(line).unwrap().find(word).unwrap() as u32;
        // The declaration starts at its attributes; the name is where usages are asked.
        assert_eq!(
            pool.range.start,
            Position {
                line: 1,
                character: 0
            }
        );
        assert_eq!(
            pool.selection_range.start,
            Position {
                line: 2,
                character: col(2, "Pool")
            }
        );
        let jump = &pool.children[3];
        assert_eq!(
            jump.range.start,
            Position {
                line: 6,
                character: 4
            }
        );
        assert_eq!(
            jump.selection_range.start,
            Position {
                line: 6,
                character: col(6, "Jump")
            }
        );
    }

    #[test]
    fn outline_columns_count_utf16() {
        // "é" is 2 bytes and 1 UTF-16 unit, "😀" 4 bytes and 2 units.
        let src = "namespace N { /* é😀 */ class A { } }";
        let a = &csharp_outline(src)[0].children[0];
        assert_eq!(
            a.selection_range.start.character,
            src[..src.find(" A").unwrap() + 1].encode_utf16().count() as u32
        );
        assert_eq!(a.selection_range.start.character, 30);
    }

    #[test]
    fn other_languages_have_no_regions() {
        assert_eq!(
            regions(Path::new("a.json"), "{\"a\": 1}"),
            Regions::default()
        );
    }
}
