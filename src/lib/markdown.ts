// Markdown to sanitized HTML for the preview; loaded on first use, so the
// parser and sanitizer stay out of the startup bundle.
import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}
