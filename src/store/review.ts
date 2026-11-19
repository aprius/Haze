// Review comments not sent to an agent yet, and the hunks marked accepted.
// Kept for the session only: both are about changes you are looking at now.
import { create } from "zustand";
import { sameTarget, type ReviewComment, type ReviewTarget } from "../lib/review";

interface ReviewState {
  comments: ReviewComment[];
  /** Hunk keys (`hunkKey`) marked accepted. */
  accepted: Record<string, true>;
}

export const useReview = create<ReviewState>(() => ({ comments: [], accepted: {} }));

let nextId = 0;

export function addComment(target: ReviewTarget, startLine: number, endLine: number, code: string, text: string): void {
  const c: ReviewComment = { ...target, id: `c${Date.now()}-${nextId++}`, startLine, endLine, code, text, createdAt: Date.now() };
  useReview.setState((s) => ({ comments: [...s.comments, c] }));
}

export function editComment(id: string, text: string): void {
  useReview.setState((s) => ({ comments: s.comments.map((c) => (c.id === id ? { ...c, text } : c)) }));
}

export function removeComment(id: string): void {
  useReview.setState((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
}

/** Drops the comments of the repository at `root` (sent or discarded). */
export function clearComments(root: string): void {
  useReview.setState((s) => ({ comments: s.comments.filter((c) => c.root !== root) }));
}

export const commentsIn = (comments: readonly ReviewComment[], root: string) => comments.filter((c) => c.root === root);
export const commentsOn = (comments: readonly ReviewComment[], target: ReviewTarget) => comments.filter((c) => sameTarget(c, target));

export function setAccepted(keys: readonly string[], on: boolean): void {
  useReview.setState((s) => {
    const accepted = { ...s.accepted };
    for (const k of keys) {
      if (on) accepted[k] = true;
      else delete accepted[k];
    }
    return { accepted };
  });
}
