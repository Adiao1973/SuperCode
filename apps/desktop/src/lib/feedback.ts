/** Short success notices only. Never pass credentials, paths or operation payloads. */
let message = "";
let timer: ReturnType<typeof setTimeout> | undefined;
let paused = false;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const schedule = () => { clearTimeout(timer); if (!paused && message) timer = setTimeout(clearFeedback, 3000); };
export function notifySuccess(value: string): void {
  const changed = message !== value;
  message = value; schedule();
  if (changed) emit();
}
export function clearFeedback(): void { clearTimeout(timer); timer = undefined; message = ""; paused = false; emit(); }
export function pauseFeedback(): void { paused = true; clearTimeout(timer); }
export function resumeFeedback(): void { paused = false; schedule(); }
export const feedbackSnapshot = () => message;
export const subscribeFeedback = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
