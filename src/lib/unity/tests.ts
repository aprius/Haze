// Unity Test Framework (NUnit) tests in C# source: which methods are tests,
// and the full names Unity's test runner matches ("Game.Tests.PlayerTests.Jumps").

/** A test method's attributes: [Test], [UnityTest], [TestCase(…)], [TestCaseSource(…)]. */
const TEST_ATTRIBUTE = /\[\s*(?:[\w.]+\.)?(?:Test|UnityTest|TestCase|TestCaseSource)(?:Attribute)?\s*[\](,]/;

/** Whether the attributes in `head` (the text from the declaration's first attribute to its name) mark a test. */
export function isTestHead(head: string): boolean {
  return TEST_ATTRIBUTE.test(head);
}

/** The namespace in effect at a line: the last block or file-scoped one declared before it. */
export function namespaceAt(text: string, offset: number): string {
  const re = /^\s*namespace\s+([\w.]+)/gm;
  let ns = "";
  for (let m = re.exec(text); m && m.index < offset; m = re.exec(text)) ns = m[1];
  return ns;
}

/** "Outer<T>" is "Outer": NUnit names generic fixtures by their arguments, which source does not know. */
export function typeName(symbolName: string): string {
  return symbolName.replace(/<.*$/, "").trim();
}

/** NUnit's full name of a class: nested classes are joined with "+". */
export function fixtureName(namespace: string, classes: string[]): string {
  const cls = classes.map(typeName).join("+");
  return namespace ? `${namespace}.${cls}` : cls;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regex Unity's test filter (groupNames) matches against full names: a fixture's tests, or one test and its cases. */
export function testPattern(fixture: string, method?: string): string {
  return method ? `^${escape(`${fixture}.${method}`)}(\\(.*\\))?$` : `^${escape(fixture)}\\.`;
}
