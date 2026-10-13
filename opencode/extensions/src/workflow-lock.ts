/** In-process transition serialization for cooperating native workflows. */
const hosts = new WeakMap<object, Map<string, Promise<unknown>>>();
export function workflowTransition<T>(host: object, sessionID: string, action: () => Promise<T>): Promise<T> {
  let sessions = hosts.get(host);
  if (!sessions) {
    sessions = new Map();
    hosts.set(host, sessions);
  }
  const previous = sessions.get(sessionID) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(action);
  sessions.set(sessionID, operation);
  return operation.finally(() => {
    if (sessions.get(sessionID) === operation) sessions.delete(sessionID);
  });
}
