import { EventEmitter } from 'node:events';
import type { DocChangedEvent } from '@tessera/protocol';
import type { z } from 'zod';

/** A committed change to a stored document. */
export interface DocChange {
  appId: string;
  event: z.infer<typeof DocChangedEvent>;
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
