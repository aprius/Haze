//! Comment and string-literal regions, for "In comments / In string literals"
//! search filters. C# is parsed with tree-sitter; other languages report no
//! regions (so "In comments" finds nothing there and "Except…" finds everything).
//!
//! Also the outline of a C# file (types and members), for Code Vision: at
//! once, where a language server answers only once its projects compiled.

use std::collections::HashMap;
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
    /// `x == null` and `x != null`, with the type `x` is declared with
    /// (lib/unity/perf.ts tells whether it is a UnityEngine.Object).
    pub null_checks: Vec<TypedSite>,
    /// `grid[x, y]` on a multidimensional array.
    pub array_access: Vec<Range>,
}

/// An expression and the declared type of what it works on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedSite {
    /// "Transform", "Enemy": no namespace, no type arguments.
    pub type_name: String,
    pub range: Range,
}

const FIND_ANYWHERE: &[&str] = &[
    "FindObjectOfType",
    "FindObjectsOfType",
    "FindObjectsOfTypeAll",
    "FindObjectsOfTypeIncludingAssets",
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
    "IsInvoking",
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
        if FIND_ANYWHERE.contains(&name)
            || (name == "Find" && matches!(receiver, Some("GameObject" | "transform")))
        {
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

    fn collect_calls(&self, n: tree_sitter::Node, m: &mut PerfMethod, scopes: &Scopes) {
        match n.kind() {
            "binary_expression" => {
                let op = n.child_by_field_name("operator").map(|o| self.text(o));
                if matches!(op, Some("==" | "!=")) {
                    let (l, r) = (
                        n.child_by_field_name("left"),
                        n.child_by_field_name("right"),
                    );
                    let other = match (l, r) {
                        (Some(l), Some(r)) if r.kind() == "null_literal" => Some(l),
                        (Some(l), Some(r)) if l.kind() == "null_literal" => Some(r),
                        _ => None,
                    };
                    if let Some(type_name) = other.and_then(|e| self.type_of(e, scopes)) {
                        m.null_checks.push(TypedSite {
                            type_name: simple_type(&type_name).to_string(),
                            range: self.range(n),
                        });
                    }
                }
            }
            "element_access_expression" => {
                let args = n
                    .child_by_field_name("subscript")
                    .map_or(0, |s| s.named_child_count());
                let array = n
                    .child_by_field_name("expression")
                    .and_then(|e| self.type_of(e, scopes));
                if args > 1 && array.is_some_and(|t| t.contains("[,")) {
                    m.array_access.push(self.range(n));
                }
            }
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
            self.collect_calls(child, m, scopes);
        }
    }

    fn perf_members(
        &self,
        parent: tree_sitter::Node,
        class: Option<&str>,
        scopes: &mut Scopes,
        out: &mut Vec<PerfMethod>,
    ) {
        let mut c = parent.walk();
        for n in parent.named_children(&mut c) {
            match n.kind() {
                "class_declaration" | "struct_declaration" | "record_declaration" => {
                    let name = n.child_by_field_name("name").map(|x| self.text(x));
                    if let Some(body) = n.child_by_field_name("body") {
                        scopes.push(self.members_scope(body));
                        self.perf_members(body, name, scopes, out);
                        scopes.pop();
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
                        null_checks: vec![],
                        array_access: vec![],
                    };
                    if let Some(body) = n.child_by_field_name("body") {
                        scopes.push(self.locals_scope(n));
                        self.collect_calls(body, &mut m, scopes);
                        scopes.pop();
                    }
                    out.push(m);
                }
                k if k.contains("namespace")
                    || k == "declaration_list"
                    || k.starts_with("preproc")
                    || k == "ERROR" =>
                {
                    self.perf_members(n, class, scopes, out)
                }
                _ => {}
            }
        }
    }
}

// ------------------------------------------------------------------ Unity scripts

/// What names in scope are declared as: type text without spaces ("Transform",
/// "int[,]", "List<Enemy>"), and for constants their string value. Innermost
/// scope last. No types are resolved: `var` takes what its initializer shows.
#[derive(Default)]
struct Scope {
    types: HashMap<String, String>,
    strings: HashMap<String, String>,
}

type Scopes = Vec<Scope>;

/// The innermost scope's answer.
fn lookup<'s>(
    scopes: &'s Scopes,
    f: impl Fn(&'s Scope) -> Option<&'s String>,
) -> Option<&'s String> {
    scopes.iter().rev().find_map(f)
}

/// `UnityEngine.Transform` → `Transform`, `List<Enemy>?` → `List`.
fn simple_type(t: &str) -> &str {
    let t = t.trim_end_matches('?');
    let t = t.split('<').next().unwrap_or(t);
    t.rsplit(['.', ':']).next().unwrap_or(t)
}

/// Generic methods whose type argument is what they return.
const RETURNS_TYPE_ARG: &[&str] = &[
    "GetComponent",
    "GetComponentInChildren",
    "GetComponentInParent",
    "AddComponent",
    "FindObjectOfType",
    "FindAnyObjectByType",
    "FindFirstObjectByType",
    "Instantiate",
    "Load",
    "CreateInstance",
];

/// A string a script passes to Unity that names something of the project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnityRef {
    /// "tag", "layer", "axis", "scene", "sceneIndex", "editorScene",
    /// "resource", "resourceFolder", "animatorState" or "shader".
    pub kind: &'static str,
    /// The string (or for "sceneIndex" the number).
    pub value: String,
    /// The literal, or the constant naming it.
    pub range: Range,
}

/// `Instantiate(prefab)` and the parent set right after, which Instantiate could have set.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentAfterInstantiate {
    /// The statement setting the parent.
    pub range: Range,
    pub instantiate: Range,
    /// What is instantiated, as written.
    pub original: String,
    /// The new parent, as written.
    pub parent: String,
    /// Whether the world position stays (`SetParent(p)`, `.parent = p`); None
    /// when an expression decides.
    pub world: Option<bool>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityCode {
    pub refs: Vec<UnityRef>,
    pub set_parent: Vec<ParentAfterInstantiate>,
}

/// Methods taking a tag, a layer, an input axis…: (receiver, name prefix or name, kind, every argument).
const NAMING: &[(Option<&str>, &str, &str, bool)] = &[
    (None, "CompareTag", "tag", false),
    (Some("GameObject"), "FindWithTag", "tag", false),
    (Some("GameObject"), "FindGameObjectWithTag", "tag", false),
    (Some("GameObject"), "FindGameObjectsWithTag", "tag", false),
    (Some("LayerMask"), "NameToLayer", "layer", false),
    (Some("LayerMask"), "GetMask", "layer", true),
    (Some("Input"), "GetAxis", "axis", false),
    (Some("Input"), "GetAxisRaw", "axis", false),
    (Some("Input"), "GetButton", "axis", false),
    (Some("Input"), "GetButtonDown", "axis", false),
    (Some("Input"), "GetButtonUp", "axis", false),
    (Some("SceneManager"), "LoadScene", "scene", false),
    (Some("SceneManager"), "LoadSceneAsync", "scene", false),
    (
        Some("EditorSceneManager"),
        "OpenScene",
        "editorScene",
        false,
    ),
    (Some("Resources"), "Load", "resource", false),
    (Some("Resources"), "LoadAsync", "resource", false),
    (Some("Resources"), "LoadAll", "resourceFolder", false),
    (Some("Shader"), "Find", "shader", false),
];

/// Animator methods taking a state name.
const ANIMATOR_STATE: &[&str] = &[
    "Play",
    "PlayInFixedTime",
    "CrossFade",
    "CrossFadeInFixedTime",
];

/// Members of a transform that a parent set after them would move: Instantiate
/// with the parent would not keep them the same way.
const PLACES: &[&str] = &[
    "position",
    "localPosition",
    "rotation",
    "localRotation",
    "localScale",
    "SetPositionAndRotation",
    "SetLocalPositionAndRotation",
    "Translate",
    "Rotate",
    "LookAt",
    "parent",
    "SetParent",
];

impl Outliner<'_> {
    /// The type a declaration's initializer shows, for `var`.
    fn initializer_type(&self, e: tree_sitter::Node) -> Option<String> {
        match e.kind() {
            "parenthesized_expression" => self.initializer_type(e.named_child(0)?),
            "cast_expression" => Some(self.type_text(e.child_by_field_name("type")?)),
            "as_expression" => Some(self.type_text(e.child_by_field_name("right")?)),
            "object_creation_expression" => Some(self.type_text(e.child_by_field_name("type")?)),
            "array_creation_expression" => Some(self.type_text(e.child_by_field_name("type")?)),
            "invocation_expression" => {
                let f = e.child_by_field_name("function")?;
                let name = match f.kind() {
                    "member_access_expression" => f.child_by_field_name("name")?,
                    _ => f,
                };
                if name.kind() != "generic_name" {
                    return None;
                }
                let method = self.text(name.named_child(0)?);
                let args = name.named_child(1)?;
                if !RETURNS_TYPE_ARG.contains(&method) || args.named_child_count() != 1 {
                    return None;
                }
                Some(self.type_text(args.named_child(0)?))
            }
            _ => self.known_member_type(e),
        }
    }

    /// `x.gameObject`, `transform`, `Camera.main`: what Unity's own members are.
    fn known_member_type(&self, e: tree_sitter::Node) -> Option<String> {
        let name = match e.kind() {
            "member_access_expression" => {
                let expr = e.child_by_field_name("expression").map(|x| self.text(x));
                let name = self.text(e.child_by_field_name("name")?);
                if name == "main" && expr.map(last_segment) == Some("Camera") {
                    return Some("Camera".into());
                }
                name
            }
            "identifier" => self.text(e),
            _ => return None,
        };
        match name {
            "gameObject" => Some("GameObject".into()),
            "transform" => Some("Transform".into()),
            _ => None,
        }
    }

    fn type_text(&self, t: tree_sitter::Node) -> String {
        self.text(t).split_whitespace().collect()
    }

    /// Declares the variables of a `variable_declaration` (a field or a local).
    fn declare_variables(&self, decl: tree_sitter::Node, scope: &mut Scope, constant: bool) {
        let Some(t) = decl.child_by_field_name("type") else {
            return;
        };
        let declared = (t.kind() != "implicit_type").then(|| self.type_text(t));
        let mut c = decl.walk();
        for v in decl.named_children(&mut c) {
            if v.kind() != "variable_declarator" {
                continue;
            }
            let Some(name) = v.child_by_field_name("name").or_else(|| v.named_child(0)) else {
                continue;
            };
            // The initializer is the declarator's last part (once inside `= …`).
            let init = v
                .named_child(v.named_child_count().saturating_sub(1) as u32)
                .filter(|i| i.id() != name.id())
                .map(|i| match i.kind() {
                    "equals_value_clause" => i.named_child(0).unwrap_or(i),
                    _ => i,
                });
            let name = self.text(name).to_string();
            if constant {
                if let Some(value) = init.and_then(|i| self.string_value(i)) {
                    scope.strings.insert(name.clone(), value);
                }
            }
            if let Some(t) = declared
                .clone()
                .or_else(|| init.and_then(|i| self.initializer_type(i)))
            {
                scope.types.insert(name, t);
            }
        }
    }

    /// The fields and properties of a type's body.
    fn members_scope(&self, body: tree_sitter::Node) -> Scope {
        let mut scope = Scope::default();
        let mut c = body.walk();
        for n in body.named_children(&mut c) {
            match n.kind() {
                "field_declaration" => {
                    let constant = self.is_const(n);
                    let mut d = n.walk();
                    for decl in n.named_children(&mut d) {
                        if decl.kind() == "variable_declaration" {
                            self.declare_variables(decl, &mut scope, constant);
                        }
                    }
                }
                "property_declaration" => {
                    if let (Some(t), Some(name)) =
                        (n.child_by_field_name("type"), n.child_by_field_name("name"))
                    {
                        scope
                            .types
                            .insert(self.text(name).into(), self.type_text(t));
                    }
                }
                _ => {}
            }
        }
        scope
    }

    /// The parameters and locals of a method (nested types left out).
    fn locals_scope(&self, member: tree_sitter::Node) -> Scope {
        let mut scope = Scope::default();
        self.collect_locals(member, &mut scope);
        scope
    }

    fn collect_locals(&self, n: tree_sitter::Node, scope: &mut Scope) {
        match n.kind() {
            "parameter" => {
                if let (Some(t), Some(name)) =
                    (n.child_by_field_name("type"), n.child_by_field_name("name"))
                {
                    scope
                        .types
                        .insert(self.text(name).into(), self.type_text(t));
                }
            }
            "variable_declaration" => {
                let constant = n.parent().is_some_and(|p| self.is_const(p));
                self.declare_variables(n, scope, constant);
            }
            "foreach_statement" => {
                if let (Some(t), Some(name)) =
                    (n.child_by_field_name("type"), n.child_by_field_name("left"))
                {
                    if t.kind() != "implicit_type" && name.kind() == "identifier" {
                        scope
                            .types
                            .insert(self.text(name).into(), self.type_text(t));
                    }
                }
            }
            _ => {}
        }
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            if matches!(
                child.kind(),
                "class_declaration"
                    | "struct_declaration"
                    | "record_declaration"
                    | "interface_declaration"
            ) {
                continue;
            }
            self.collect_locals(child, scope);
        }
    }

    /// `const string Tag = "Enemy";`: a field or local declaration with the `const` modifier.
    fn is_const(&self, decl: tree_sitter::Node) -> bool {
        let mut c = decl.walk();
        let found = decl
            .children(&mut c)
            .any(|k| k.kind() == "modifier" && self.text(k) == "const");
        found
    }

    /// The declared type of what an expression names: a local, parameter,
    /// field or property of the file, or one of Unity's well-known members.
    fn type_of(&self, e: tree_sitter::Node, scopes: &Scopes) -> Option<String> {
        let name = match e.kind() {
            "identifier" => self.text(e),
            "member_access_expression" => {
                let expr = e.child_by_field_name("expression")?;
                let name = e.child_by_field_name("name")?;
                if expr.kind() != "this_expression" && expr.kind() != "this" {
                    return self.known_member_type(e);
                }
                self.text(name)
            }
            "parenthesized_expression" => return self.type_of(e.named_child(0)?, scopes),
            "invocation_expression" => return self.initializer_type(e),
            _ => return None,
        };
        lookup(scopes, |s| s.types.get(name))
            .cloned()
            .or_else(|| self.known_member_type(e))
    }

    /// The value of a string literal, or of a constant naming one.
    fn string_value(&self, n: tree_sitter::Node) -> Option<String> {
        let t = self.text(n);
        match n.kind() {
            "string_literal" => {
                let inner = t.strip_prefix('"')?;
                let inner = inner
                    .strip_suffix("\"u8")
                    .or_else(|| inner.strip_suffix('"'))?;
                Some(unescape(inner))
            }
            "verbatim_string_literal" => Some(
                t.strip_prefix("@\"")?
                    .strip_suffix('"')?
                    .replace("\"\"", "\""),
            ),
            _ => None,
        }
    }

    fn constant_value(&self, n: tree_sitter::Node, scopes: &Scopes) -> Option<String> {
        if n.kind() != "identifier" {
            return self.string_value(n);
        }
        let name = self.text(n);
        lookup(scopes, |s| s.strings.get(name)).cloned()
    }

    /// The expressions of an invocation's arguments, named ones included.
    fn arguments<'n>(&self, call: tree_sitter::Node<'n>) -> Vec<tree_sitter::Node<'n>> {
        let Some(list) = call.child_by_field_name("arguments") else {
            return vec![];
        };
        let mut c = list.walk();
        list.named_children(&mut c)
            .filter(|a| a.kind() == "argument")
            .filter_map(|a| a.named_child(a.named_child_count().saturating_sub(1) as u32))
            .collect()
    }

    fn unity_invocation(&self, call: tree_sitter::Node, scopes: &Scopes, out: &mut UnityCode) {
        let Some(f) = call.child_by_field_name("function") else {
            return;
        };
        let Some((receiver, name)) = self.callee(f) else {
            return;
        };
        let receiver_node = (f.kind() == "member_access_expression")
            .then(|| f.child_by_field_name("expression"))
            .flatten();
        let args = self.arguments(call);
        let mut push = |kind: &'static str, arg: tree_sitter::Node| {
            let value = match kind {
                "sceneIndex" => Some(self.text(arg).to_string()),
                _ => self.constant_value(arg, scopes),
            };
            if let Some(value) = value {
                out.refs.push(UnityRef {
                    kind,
                    value,
                    range: self.range(arg),
                });
            }
        };
        for &(on, method, kind, all) in NAMING {
            let receiver_ok = match on {
                None => true,
                Some(t) => receiver.map(last_segment) == Some(t),
            };
            if !receiver_ok || name != method {
                continue;
            }
            for (i, arg) in args.iter().enumerate() {
                if i > 0 && !all {
                    break;
                }
                if kind == "scene" && arg.kind() == "integer_literal" {
                    push("sceneIndex", *arg);
                } else {
                    push(kind, *arg);
                }
            }
            return;
        }
        if ANIMATOR_STATE.contains(&name) {
            let animator = receiver_node
                .and_then(|r| self.type_of(r, scopes))
                .is_some_and(|t| simple_type(&t) == "Animator");
            if let (true, Some(first)) = (animator, args.first()) {
                push("animatorState", *first);
            }
        }
    }

    /// `x.tag == "Enemy"`, `x.tag = "Enemy"`.
    fn unity_tag_comparison(&self, n: tree_sitter::Node, scopes: &Scopes, out: &mut UnityCode) {
        let op = n.child_by_field_name("operator").map(|o| self.text(o));
        if !matches!(op, Some("==" | "!=" | "=")) {
            return;
        }
        let (Some(l), Some(r)) = (
            n.child_by_field_name("left"),
            n.child_by_field_name("right"),
        ) else {
            return;
        };
        let is_tag = |e: tree_sitter::Node| {
            e.kind() == "member_access_expression"
                && e.child_by_field_name("name")
                    .is_some_and(|x| self.text(x) == "tag")
        };
        let literal = if is_tag(l) {
            r
        } else if is_tag(r) && op != Some("=") {
            l
        } else {
            return;
        };
        if let Some(value) = self.constant_value(literal, scopes) {
            out.refs.push(UnityRef {
                kind: "tag",
                value,
                range: self.range(literal),
            });
        }
    }

    /// The single-argument `Instantiate(x)` an expression is, through casts and `as`.
    fn instantiate_call<'n>(&self, e: tree_sitter::Node<'n>) -> Option<tree_sitter::Node<'n>> {
        match e.kind() {
            "parenthesized_expression" => self.instantiate_call(e.named_child(0)?),
            "cast_expression" => self.instantiate_call(e.child_by_field_name("value")?),
            "as_expression" => self.instantiate_call(e.child_by_field_name("left")?),
            "invocation_expression" => {
                let (receiver, name) = self.callee(e.child_by_field_name("function")?)?;
                let receiver_ok = receiver
                    .is_none_or(|r| matches!(last_segment(r), "Object" | "GameObject" | "this"));
                (name == "Instantiate" && receiver_ok && self.arguments(e).len() == 1).then_some(e)
            }
            _ => None,
        }
    }

    /// `v.transform.SetParent(p)`, `v.SetParent(p, false)`, `v.transform.parent = p`.
    fn parent_set(&self, stmt: tree_sitter::Node, v: &str) -> Option<(String, Option<bool>)> {
        if stmt.kind() != "expression_statement" {
            return None;
        }
        let e = stmt.named_child(0)?;
        let target_ok = |t: tree_sitter::Node| {
            let t = self.text(t);
            t == v || t == format!("{v}.transform")
        };
        match e.kind() {
            "invocation_expression" => {
                let f = e.child_by_field_name("function")?;
                if f.kind() != "member_access_expression"
                    || self.text(f.child_by_field_name("name")?) != "SetParent"
                    || !target_ok(f.child_by_field_name("expression")?)
                {
                    return None;
                }
                let args = self.arguments(e);
                let world = match args.get(1).map(|a| self.text(*a)) {
                    None | Some("true") => Some(true),
                    Some("false") => Some(false),
                    Some(_) => None,
                };
                Some((self.text(*args.first()?).to_string(), world))
            }
            "assignment_expression" => {
                let l = e.child_by_field_name("left")?;
                if self.text(e.child_by_field_name("operator")?) != "="
                    || l.kind() != "member_access_expression"
                    || self.text(l.child_by_field_name("name")?) != "parent"
                    || !target_ok(l.child_by_field_name("expression")?)
                {
                    return None;
                }
                Some((
                    self.text(e.child_by_field_name("right")?).to_string(),
                    Some(true),
                ))
            }
            _ => None,
        }
    }

    /// Whether a statement mentions `v` near a member that places it.
    fn moves(&self, stmt: tree_sitter::Node, v: &str) -> bool {
        let text = self.text(stmt);
        let words: Vec<&str> = text
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .collect();
        words.contains(&v) && words.iter().any(|w| PLACES.contains(w))
    }

    fn unity_block(&self, block: tree_sitter::Node, out: &mut UnityCode) {
        let mut c = block.walk();
        let stmts: Vec<_> = block.named_children(&mut c).collect();
        for (i, s) in stmts.iter().enumerate() {
            // `var v = Instantiate(x);` or `v = Instantiate(x);`
            let (v, call) = match s.kind() {
                "local_declaration_statement" => {
                    let Some(decl) = s.named_child(0) else {
                        continue;
                    };
                    let mut d = decl.walk();
                    let declarators: Vec<_> = decl
                        .named_children(&mut d)
                        .filter(|n| n.kind() == "variable_declarator")
                        .collect();
                    let [v] = declarators[..] else { continue };
                    let Some(name) = v.child_by_field_name("name").or_else(|| v.named_child(0))
                    else {
                        continue;
                    };
                    let init = v
                        .named_child(v.named_child_count().saturating_sub(1) as u32)
                        .map(|i| match i.kind() {
                            "equals_value_clause" => i.named_child(0).unwrap_or(i),
                            _ => i,
                        });
                    let Some(call) = init.and_then(|i| self.instantiate_call(i)) else {
                        continue;
                    };
                    (self.text(name).to_string(), call)
                }
                "expression_statement" => {
                    let Some(e) = s
                        .named_child(0)
                        .filter(|e| e.kind() == "assignment_expression")
                    else {
                        continue;
                    };
                    let (Some(l), Some(r)) = (
                        e.child_by_field_name("left"),
                        e.child_by_field_name("right"),
                    ) else {
                        continue;
                    };
                    let Some(call) = self.instantiate_call(r) else {
                        continue;
                    };
                    if l.kind() != "identifier" {
                        continue;
                    }
                    (self.text(l).to_string(), call)
                }
                _ => continue,
            };
            for next in &stmts[i + 1..] {
                if let Some((parent, world)) = self.parent_set(*next, &v) {
                    let original = self
                        .arguments(call)
                        .first()
                        .map(|a| self.text(*a).to_string())
                        .unwrap_or_default();
                    out.set_parent.push(ParentAfterInstantiate {
                        range: self.range(*next),
                        instantiate: self.range(call),
                        original,
                        parent,
                        world,
                    });
                    break;
                }
                if self.moves(*next, &v) {
                    break;
                }
            }
        }
    }

    fn unity_walk(&self, n: tree_sitter::Node, scopes: &mut Scopes, out: &mut UnityCode) {
        let pushed = match n.kind() {
            "class_declaration" | "struct_declaration" | "record_declaration" => {
                let body = n.child_by_field_name("body");
                body.map(|b| scopes.push(self.members_scope(b))).is_some()
            }
            "method_declaration"
            | "constructor_declaration"
            | "local_function_statement"
            | "property_declaration"
            | "indexer_declaration"
            | "operator_declaration" => {
                scopes.push(self.locals_scope(n));
                true
            }
            _ => false,
        };
        match n.kind() {
            "invocation_expression" => self.unity_invocation(n, scopes, out),
            "binary_expression" | "assignment_expression" => {
                self.unity_tag_comparison(n, scopes, out)
            }
            "block" => self.unity_block(n, out),
            _ => {}
        }
        let mut c = n.walk();
        for child in n.named_children(&mut c) {
            self.unity_walk(child, scopes, out);
        }
        if pushed {
            scopes.pop();
        }
    }
}

/// C# escapes in a regular string literal.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

/// The strings a script passes to Unity that name tags, layers, scenes…, and
/// `Instantiate` calls followed by setting the parent.
pub fn csharp_unity(text: &str) -> UnityCode {
    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .is_err()
    {
        return UnityCode::default();
    }
    let Some(tree) = parser.parse(text, None) else {
        return UnityCode::default();
    };
    let line_starts = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let o = Outliner { text, line_starts };
    let mut out = UnityCode::default();
    o.unity_walk(tree.root_node(), &mut vec![], &mut out);
    out
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
    o.perf_members(tree.root_node(), None, &mut vec![], &mut out);
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
    fn finds_null_checks_and_multidimensional_arrays() {
        let src = r#"
class Grid : MonoBehaviour {
  [SerializeField] Transform target;
  int[,] cells;
  int[][] jagged;
  int count;
  void Update() {
    var body = GetComponent<Rigidbody>();
    if (target == null || null != body) {}
    if (count == null) {}
    if (gameObject != null && this.target != null) {}
    var a = cells[1, 2] + jagged[1][2];
    transform.Find("Child");
  }
}
"#;
        let m = &csharp_perf(src)[0];
        let nulls: Vec<_> = m.null_checks.iter().map(|n| n.type_name.as_str()).collect();
        assert_eq!(
            nulls,
            ["Transform", "Rigidbody", "int", "GameObject", "Transform"]
        );
        assert_eq!(m.array_access.len(), 1);
        assert_eq!(m.array_access[0].start.line, 11);
        let costly: Vec<_> = m.expensive.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(costly, ["GetComponent", "Find"]);
    }

    #[test]
    fn finds_strings_naming_unity_things() {
        let src = r#"
using UnityEngine.SceneManagement;
class Player : MonoBehaviour {
  const string EnemyTag = "Enemy";
  static readonly int Ground = LayerMask.NameToLayer("Ground");
  Animator anim;
  void OnTriggerEnter(Collider other) {
    if (other.CompareTag(EnemyTag) || other.tag == "Boss" || CompareTag(@"Pick""up")) {}
    other.gameObject.tag = "Dead";
    var mask = LayerMask.GetMask("Water", "UI");
    float h = Input.GetAxis("Horizontal") + (Input.GetButtonDown("Jump") ? 1 : 0);
    SceneManager.LoadScene("Level\t2");
    SceneManager.LoadSceneAsync(3);
    UnityEditor.SceneManagement.EditorSceneManager.OpenScene("Assets/Test.unity");
    var icon = Resources.Load<Sprite>("UI/Icon");
    Resources.LoadAll("Levels");
    anim.Play("Run");
    GetComponent<Animator>().CrossFade(stateName: "Jump", 0.1f);
    audio.Play("NotAState");
    var s = Shader.Find("Custom/Water");
    var dynamic = Resources.Load(path);
    GameObject.FindWithTag(nameTag);
  }
}
"#;
        let got = csharp_unity(src);
        let refs: Vec<_> = got
            .refs
            .iter()
            .map(|r| format!("{}:{}", r.kind, r.value))
            .collect();
        assert_eq!(
            refs,
            [
                "layer:Ground",
                "tag:Enemy",
                "tag:Boss",
                "tag:Pick\"up",
                "tag:Dead",
                "layer:Water",
                "layer:UI",
                "axis:Horizontal",
                "axis:Jump",
                "scene:Level\t2",
                "sceneIndex:3",
                "editorScene:Assets/Test.unity",
                "resource:UI/Icon",
                "resourceFolder:Levels",
                "animatorState:Run",
                "animatorState:Jump",
                "shader:Custom/Water",
            ]
        );
        // The constant is reported where it is used.
        let enemy = &got.refs[1].range;
        let line = src.lines().nth(enemy.start.line as usize).unwrap();
        assert_eq!(
            &line[enemy.start.character as usize..enemy.end.character as usize],
            "EnemyTag"
        );
    }

    #[test]
    fn finds_the_parent_set_after_instantiate() {
        let src = r#"
class Spawner : MonoBehaviour {
  void Spawn(GameObject prefab, Transform root) {
    var a = Instantiate(prefab);
    a.name = "A";
    a.transform.SetParent(root);

    var b = (GameObject)Object.Instantiate(prefab);
    b.transform.SetParent(root, false);

    GameObject c;
    c = Instantiate(prefab) as GameObject;
    c.transform.parent = root;

    var d = Instantiate(prefab);
    d.transform.position = Vector3.zero;
    d.transform.SetParent(root);

    var e = Instantiate(prefab, root);
    e.transform.SetParent(root);

    var f = Instantiate(prefab);
    if (root) { f.transform.SetParent(root); }
  }
}
"#;
        let got = csharp_unity(src).set_parent;
        let found: Vec<_> = got
            .iter()
            .map(|p| (p.range.start.line, p.parent.as_str(), p.world))
            .collect();
        assert_eq!(
            found,
            [
                (5, "root", Some(true)),
                (8, "root", Some(false)),
                (12, "root", Some(true))
            ]
        );
        assert_eq!(got[0].instantiate.start.line, 3);
        assert_eq!(got[0].original, "prefab");
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
