/** Controlled matchMedia; listeners observe changes, never patch real OS preferences. */
export function mediaFixture() {
  const entries = new Map<
    string,
    { value: boolean; listeners: Set<EventListenerOrEventListenerObject> }
  >();
  const entry = (query: string) => {
    let value = entries.get(query);
    if (!value) {
      value = { value: false, listeners: new Set() };
      entries.set(query, value);
    }
    return value;
  };
  return {
    matchMedia(query: string): MediaQueryList {
      const state = entry(query);
      return {
        get matches() {
          return state.value;
        },
        media: query,
        onchange: null,
        addEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject | null,
        ) => {
          if (listener) state.listeners.add(listener);
        },
        removeEventListener: (
          _type: string,
          listener: EventListenerOrEventListenerObject | null,
        ) => {
          if (listener) state.listeners.delete(listener);
        },
        addListener: (listener) => {
          if (listener) state.listeners.add(listener as EventListener);
        },
        removeListener: (listener) => {
          if (listener) state.listeners.delete(listener as EventListener);
        },
        dispatchEvent: () => true,
      } as MediaQueryList;
    },
    set(query: string, matches: boolean) {
      const state = entry(query);
      if (state.value === matches) return;
      state.value = matches;
      const event = Object.assign(new Event("change"), {
        matches,
        media: query,
      });
      for (const listener of state.listeners) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
    count(query: string) {
      return entry(query).listeners.size;
    },
  };
}
