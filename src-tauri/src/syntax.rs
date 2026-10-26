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

// ------------------------------------------------------------------ Unity performance

/// A call in a method body, for Unity's performance-critical context.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PerfCall {
    /// A method of the same class (`Move`, `this.Move`), or for an expensive
    /// operation what it is: "GetComponent", "Camera.main", "Debug.Log",
    /// "SendMessage", "string-invoke".
    pub name: String,
    pub range: Range,
}

/// A method of a class, with what it calls.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfMethod {
    /// The class declaring it (the innermost one).
    pub class: String,
    pub name: String,
    /// The whole declaration, attributes included.
    pub range: Range,
    pub name_range: Range,
    /// Returns `IEnumerator`: a coroutine when started.
    pub coroutine: bool,
    /// Calls that may be to methods of the same class.
    pub calls: Vec<PerfCall>,
    /// Well-known expensive operations.
    pub expensive: Vec<PerfCall>,
}

const FIND_ANYWHERE: &[&str] = &[
    "FindObjectOfType",
    "FindObjectsOfType",
    "FindAnyObjectByType",
    "FindFirstObjectByType",
    "FindObjectsByType",
    "FindWithTag",
    "FindGameObjectWithTag",
    "FindGameObjectsWithTag",
];
const MESSAGES: &[&str] = &["SendMessage", "SendMessageUpwards", "BroadcastMessage"];
const BY_NAME: &[&str] = &[
    "Invoke",
    "InvokeRepeating",
    "CancelInvoke",
    "StartCoroutine",
    "StopCoroutine",
];

/// The last segment of a dotted name: `UnityEngine.Debug` → `Debug`.
fn last_segment(s: &str) -> &str {
    s.rsplit('.').next().unwrap_or(s).trim()
}

impl Outliner<'_> {
    /// The receiver (if any) and the name of an invocation's callee.
    fn callee<'n>(&self, f: tree_sitter::Node<'n>) -> Option<(Option<&str>, &str)> {
        let name_of = |n: tree_sitter::Node| match n.kind() {
            "identifier" => Some(self.text(n)),
            "generic_name" => n.named_child(0).map(|i| self.text(i)),
            _ => None,
        };
        match f.kind() {
            "identifier" | "generic_name" => Some((None, name_of(f)?)),
            "member_access_expression" => {
                let receiver = f.child_by_field_name("expression").map(|e| self.text(e));
                Some((receiver, name_of(f.child_by_field_name("name")?)?))
            }
            _ => None,
        }
    }

    /// What an invocation costs in a performance-critical context, if it is known to be expensive.
    fn expensive_call(
        &self,
        call: tree_sitter::Node,
        receiver: Option<&str>,
        name: &str,
    ) -> Option<&'static str> {
        let receiver = receiver.map(last_segment);
        if name.starts_with("GetComponent") {
            return Some("GetComponent");
        }
        if name == "AddComponent" {
            return Some("AddComponent");
        }
        if FIND_ANYWHERE.contains(&name) || (name == "Find" && receiver == Some("GameObject")) {
            return Some("Find");
        }
        if (receiver == Some("Debug") && name.starts_with("Log"))
            || (receiver.is_none() && name == "print")
        {
            return Some("Debug.Log");
        }
        if MESSAGES.contains(&name) {
            return Some("SendMessage");
        }
        if BY_NAME.contains(&name) && (receiver.is_none() || receiver == Some("this")) {
            let first = call
                .child_by_field_name("arguments")
                .and_then(|a| a.named_child(0))
                .and_then(|a| a.named_child(0));
            if first.is_some_and(|e| e.kind() == "string_literal") {
                return Some("string-invoke");
            }
        }
        None
    }

    fn collect_calls(&self, n: tree_sitter::Node, m: &mut PerfMethod) {
        match n.kind() {
            "invocation_expression" => {
                if let Some(f) = n.child_by_field_name("function") {
                    if let Some((receiver, name)) = self.callee(f) {
                        let at = match f.kind() {
                            "member_access_expression" => {
                                f.child_by_field_name("name").unwrap_or(f)
                            }
                            _ => f,
                        };
                        if let Some(what) = self.expensive_call(n, receiver, name) {
                            m.expensive.push(PerfCall {
                                name: what.into(),
                                range: self.range(at),
                            });
                        } else if receiver.is_none() || receiver == Some("this") {
                            m.calls.push(PerfCall {
                                name: name.into(),
                                range: self.range(at),
                            });
                        }
                    }
                }
            }
            "member_access_expression" => {
                let expr = n
                    .child_by_field_name("expression")
                    .map(|e| last_segment(self.text(e)));
                let name = n.child_by_field_name("name").map(|e| self.text(e));
                if expr == Some("Camera") && name == Some("main") {
                    m.expensive.push(PerfCall {
                        name: "Camera.main".into(),
                        range: self.range(n),
                    });
                }
            }
            _ => {}
        }
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            self.collect_calls(child, m);
        }
    }

    fn perf_members(
        &self,
        parent: tree_sitter::Node,
        class: Option<&str>,
        out: &mut Vec<PerfMethod>,
    ) {
        let mut c = parent.walk();
        for n in parent.named_children(&mut c) {
            match n.kind() {
                "class_declaration" | "struct_declaration" | "record_declaration" => {
                    let name = n.child_by_field_name("name").map(|x| self.text(x));
                    if let Some(body) = n.child_by_field_name("body") {
                        self.perf_members(body, name, out);
                    }
                }
                "method_declaration" => {
                    let (Some(class), Some(name)) = (class, n.child_by_field_name("name")) else {
                        continue;
                    };
                    let returns = n
                        .child_by_field_name("returns")
                        .or_else(|| n.child_by_field_name("type"));
                    let mut m = PerfMethod {
                        class: class.into(),
                        name: self.text(name).into(),
                        range: self.range(n),
                        name_range: self.range(name),
                        coroutine: returns
                            .is_some_and(|t| last_segment(self.text(t)) == "IEnumerator"),
                        calls: vec![],
                        expensive: vec![],
                    };
                    if let Some(body) = n.child_by_field_name("body") {
                        self.collect_calls(body, &mut m);
                    }
                    out.push(m);
                }
                k if k.contains("namespace")
                    || k == "declaration_list"
                    || k.starts_with("preproc")
                    || k == "ERROR" =>
                {
                    self.perf_members(n, class, out)
                }
                _ => {}
            }
        }
    }
}

/// Every method of the classes in C# source, with its calls, for Unity's
/// performance-critical context (lib/unity/perf.ts follows the calls).
pub fn csharp_perf(text: &str) -> Vec<PerfMethod> {
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
    o.perf_members(tree.root_node(), None, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_calls_and_expensive_operations() {
        let src = r#"
namespace Game {
  public class Player : MonoBehaviour {
    void Update() {
      Move();
      this.Aim(1);
      var rb = GetComponent<Rigidbody>();
      var cam = Camera.main;
      UnityEngine.Debug.Log("x");
      Invoke("Fire", 1f);
      Invoke(nameof(Fire), 1f);
      items.Find(i => i > 0);
      GameObject.Find("Boss");
      other.SendMessage("Hit");
    }
    IEnumerator Spawn() { yield return null; }
    void Move() {}
  }
}
"#;
        let methods = csharp_perf(src);
        let names: Vec<_> = methods
            .iter()
            .map(|m| (m.class.as_str(), m.name.as_str(), m.coroutine))
            .collect();
        assert_eq!(
            names,
            [
                ("Player", "Update", false),
                ("Player", "Spawn", true),
                ("Player", "Move", false)
            ]
        );
        let update = &methods[0];
        let calls: Vec<_> = update.calls.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(calls, ["Move", "Aim", "Invoke", "nameof"]);
        let costly: Vec<_> = update.expensive.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            costly,
            [
                "GetComponent",
                "Camera.main",
                "Debug.Log",
                "string-invoke",
                "Find",
                "SendMessage"
            ]
        );
        let get = update.expensive[0].range;
        assert_eq!(
            (get.start.line, get.start.character, get.end.character),
            (6, 15, 38)
        );
    }

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
