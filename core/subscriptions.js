/**
 * In-process event bus for message subscriptions.
 *
 * Deliberately holds no persistent state: the message archive is the durable
 * log, and each consumer owns its own cursor. A subscriber that disconnects
 * resumes by asking for everything after the last id it handled, which makes
 * reconnecting the same code path as connecting for the first time.
 */

/** Event types a caller may subscribe to. */
export const SUBSCRIBABLE_TYPES = Object.freeze(['message.new', 'message.edit']);

/** Does this event pass a subscriber's channel + type filter? */
export function matchesFilter(event, filter) {
  if (!filter.channels.has(event.channelId)) {
    return false;
  }
  return filter.types.has(event.type);
}

export class SubscriptionHub {
  constructor() {
    this.subscribers = new Set();
  }

  /** Register a handler; returns an idempotent unsubscribe function. */
  subscribe(filter, handler) {
    const entry = { filter, handler };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  /**
   * Fan an event out to matching subscribers. A throwing subscriber must not
   * break its peers, and must never propagate into the ingest path that called
   * publish() — losing an archived message to a misbehaving consumer would be
   * far worse than dropping one delivery.
   */
  publish(event) {
    for (const entry of this.subscribers) {
      if (!matchesFilter(event, entry.filter)) {
        continue;
      }
      try {
        entry.handler(event);
      } catch (error) {
        console.error(`[subscriptions] subscriber failed: ${error?.message ?? error}`);
      }
    }
  }

  get size() {
    return this.subscribers.size;
  }
}
