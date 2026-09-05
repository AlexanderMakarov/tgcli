import { describe, it, expect, vi } from 'vitest';
import { SubscriptionHub, matchesFilter, parseSubscribeQuery, SUBSCRIBABLE_TYPES } from '../core/subscriptions.js';

const event = (over = {}) => ({
  type: 'message.new',
  channelId: '-1003713035210',
  messageId: 155,
  message: { messageId: 155, text: 'hi' },
  ...over,
});

describe('matchesFilter', () => {
  it('matches when channel and type are both in the filter', () => {
    const filter = { channels: new Set(['-1003713035210']), types: new Set(['message.new']) };
    expect(matchesFilter(event(), filter)).toBe(true);
  });

  it('rejects a channel outside the filter', () => {
    const filter = { channels: new Set(['-1009999999999']), types: new Set(['message.new']) };
    expect(matchesFilter(event(), filter)).toBe(false);
  });

  it('rejects a type outside the filter', () => {
    const filter = { channels: new Set(['-1003713035210']), types: new Set(['message.edit']) };
    expect(matchesFilter(event(), filter)).toBe(false);
  });
});

describe('SubscriptionHub', () => {
  it('delivers a matching event to a subscriber', () => {
    const hub = new SubscriptionHub();
    const handler = vi.fn();
    hub.subscribe({ channels: new Set(['-1003713035210']), types: new Set(['message.new']) }, handler);

    hub.publish(event());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].messageId).toBe(155);
  });

  it('does not deliver a non-matching event', () => {
    const hub = new SubscriptionHub();
    const handler = vi.fn();
    hub.subscribe({ channels: new Set(['-1000000000000']), types: new Set(['message.new']) }, handler);

    hub.publish(event());

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and drops the subscriber', () => {
    const hub = new SubscriptionHub();
    const handler = vi.fn();
    const unsubscribe = hub.subscribe(
      { channels: new Set(['-1003713035210']), types: new Set(['message.new']) },
      handler,
    );

    expect(hub.size).toBe(1);
    unsubscribe();
    expect(hub.size).toBe(0);

    hub.publish(event());
    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscriber from the others and from the publisher', () => {
    const hub = new SubscriptionHub();
    const filter = { channels: new Set(['-1003713035210']), types: new Set(['message.new']) };
    const good = vi.fn();
    hub.subscribe(filter, () => {
      throw new Error('boom');
    });
    hub.subscribe(filter, good);

    expect(() => hub.publish(event())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

const params = (qs) => new URL(`http://x/subscribe?${qs}`).searchParams;

describe('parseSubscribeQuery', () => {
  it('parses channels, types and since', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210&types=message.new&since=154'));
    expect(result.ok).toBe(true);
    expect([...result.filter.channels]).toEqual(['-1003713035210']);
    expect([...result.filter.types]).toEqual(['message.new']);
    expect(result.since).toBe(154);
  });

  it('passes ids through as trimmed strings without guessing a prefix', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210 , -1009999999999'));
    expect([...result.filter.channels]).toEqual(['-1003713035210', '-1009999999999']);
  });

  it('defaults to every subscribable type when types is omitted', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210'));
    expect([...result.filter.types].sort()).toEqual([...SUBSCRIBABLE_TYPES].sort());
  });

  it('defaults since to null when omitted, meaning live-only', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210'));
    expect(result.since).toBeNull();
  });

  it('rejects a missing channels param', () => {
    const result = parseSubscribeQuery(params('types=message.new'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/channels/);
  });

  it('rejects an unknown event type', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210&types=message.burped'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/message.burped/);
  });

  it('rejects a non-numeric since', () => {
    const result = parseSubscribeQuery(params('channels=-1003713035210&since=abc'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/since/);
  });
});
