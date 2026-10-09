import { EventEmitter } from 'node:events';
import type { ActivityEntry } from './devices/types.js';

/** In-memory audit log of every action (MCP tool calls and dashboard clicks). */
class ActivityLog extends EventEmitter {
  private entries: ActivityEntry[] = [];

  add(entry: Omit<ActivityEntry, 'at'>): ActivityEntry {
    const full = { ...entry, at: new Date().toISOString() };
    this.entries.unshift(full);
    this.entries.length = Math.min(this.entries.length, 200);
    this.emit('entry', full);
    return full;
  }

  recent(limit = 50): ActivityEntry[] {
    return this.entries.slice(0, limit);
  }
}

export const activity = new ActivityLog();
activity.setMaxListeners(100);
