/** Test-only IPC boundary. Unknown commands fail closed; never import real Tauri. */
export type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;
type Listener = (event: {
  payload: unknown;
  event: string;
  id: number;
}) => void;
const handlers = new Map<string, Handler>();
const listeners = new Map<string, Set<Listener>>();
export const calls: Array<{ command: string; args: Args }> = [];

export function handle(command: string, handler: Handler): void {
  handlers.set(command, handler);
}
export async function invoke<T>(command: string, args: Args = {}): Promise<T> {
  calls.push({ command, args });
  const handler = handlers.get(command);
  if (!handler) throw new Error(`Undeclared fixture IPC: ${command}`);
  return (await handler(args)) as T;
}
export class Channel<T> {
  onmessage: (message: T) => void = () => {};
}
export async function listen(
  event: string,
  listener: Listener,
): Promise<() => void> {
  const group = listeners.get(event) ?? new Set<Listener>();
  group.add(listener);
  listeners.set(event, group);
  return () => {
    group.delete(listener);
  };
}
export function emit<T>(event: string, payload: T): void {
  for (const listener of listeners.get(event) ?? [])
    listener({ payload, event, id: 1 });
}
export function listenerCount(event: string): number {
  return listeners.get(event)?.size ?? 0;
}
export function resetIpc(): void {
  handlers.clear();
  listeners.clear();
  calls.length = 0;
}
