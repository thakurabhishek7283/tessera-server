import { EventEmitter } from 'node:events';

/** A committed change to a stored document. */
export interface DocChange {
  appId: string;
  /** Shape of the `doc.changed` broadcast (`DocChangedEvent`). */
  event: { collection: string; id: string; version: number; deleted?: boolean; by?: string };
}

/** Callback removal handle. */
export type Unsubscribe = () => void;

/**
 * In-process events that decouple HTTP routes from the realtime hub: routes announce what
 * happened, the hub decides who hears about it.
 */
export class AppEvents {
  private readonly emitter = new EventEmitter();

  onDocChanged(fn: (change: DocChange) => void): Unsubscribe {
    this.emitter.on('doc.changed', fn);
    return () => this.emitter.off('doc.changed', fn);
  }

  emitDocChanged(change: DocChange): void {
    this.emitter.emit('doc.changed', change);
  }
}
