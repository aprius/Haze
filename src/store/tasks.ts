// Background tasks in progress (git commands, builds, the C# server loading…),
// listed in the status bar like Rider's background-process indicator.
import { create } from "zustand";

export interface Task {
  key: string;
  /** Project the task belongs to; `null` = shown in every project. */
  projectId: string | null;
  label: string;
  started: number;
  cancel?: () => void;
}

export const useTasks = create<{ tasks: Task[] }>(() => ({ tasks: [] }));

/** Starts, relabels (keeping its start time) or, with `null`, ends the task under `key`. */
export function setTask(key: string, task: Omit<Task, "key" | "started"> | null): void {
  useTasks.setState((s) => {
    const cur = s.tasks.find((t) => t.key === key);
    if (!task) return cur ? { tasks: s.tasks.filter((t) => t !== cur) } : s;
    if (cur && cur.label === task.label && cur.projectId === task.projectId) return s;
    const next: Task = { ...task, key, started: cur?.started ?? Date.now() };
    return { tasks: cur ? s.tasks.map((t) => (t === cur ? next : t)) : [...s.tasks, next] };
  });
}

let seq = 0;

/** Shows `label` as a task while `work` runs. */
export async function withTask<T>(projectId: string | null, label: string, work: () => Promise<T>): Promise<T> {
  const key = `task:${++seq}`;
  setTask(key, { projectId, label });
  try {
    return await work();
  } finally {
    setTask(key, null);
  }
}
