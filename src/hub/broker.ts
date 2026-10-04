import type { ServerMessage } from '@tessera-kit/protocol';
import type { Unsubscribe } from '../lib/events.js';

/** Receives a frame published to a room, plus the peer that must not get it back (the sender). */
export type RoomFrameHandler = (frame: ServerMessage, exceptPeerId?: string) => void;

/**
 * The scaling seam. Every room-wide frame goes through the broker, and each hub instance
 * subscribes only to rooms it has local peers in. With one process the in-memory broker is
 * enough; a Redis (or NATS) broker that republishes frames between instances is what would make
 * the hub horizontally scalable. Peer lists and presence stay per-instance (see docs/architecture.md).
 */
export interface Broker {
  publish(room: string, frame: ServerMessage, exceptPeerId?: string): void;
  subscribe(room: string, fn: RoomFrameHandler): Unsubscribe;
}

/** Single-process broker: a map of room → subscribers. */
export class InMemoryBroker implements Broker {
  private readonly subscribers = new Map<string, Set<RoomFrameHandler>>();

  publish(room: string, frame: ServerMessage, exceptPeerId?: string): void {
    // Copy so a handler that unsubscribes while being called cannot disturb the iteration.
    for (const fn of [...(this.subscribers.get(room) ?? [])]) fn(frame, exceptPeerId);
  }

  subscribe(room: string, fn: RoomFrameHandler): Unsubscribe {
    const set = this.subscribers.get(room) ?? new Set<RoomFrameHandler>();
    set.add(fn);
    this.subscribers.set(room, set);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.subscribers.get(room) === set) this.subscribers.delete(room);
    };
  }
}
