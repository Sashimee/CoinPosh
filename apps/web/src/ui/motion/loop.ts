/** Returns true while it still needs frames. */
export type FrameTask = (dt: number) => boolean;

const tasks = new Set<FrameTask>();
let handle: number | null = null;
let last: number | null = null;

function tick(now: number): void {
  const dt = last === null ? 1 / 60 : (now - last) / 1000;
  last = now;
  for (const task of [...tasks]) {
    if (!task(dt)) tasks.delete(task);
  }
  if (tasks.size > 0) {
    handle = requestAnimationFrame(tick);
  } else {
    handle = null;
    last = null;
  }
}

/** One shared requestAnimationFrame loop for every UI animation; it sleeps when idle. */
export function schedule(task: FrameTask): () => void {
  tasks.add(task);
  handle ??= requestAnimationFrame(tick);
  return () => tasks.delete(task);
}
