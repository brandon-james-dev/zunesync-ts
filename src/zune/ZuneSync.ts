import type { Zune } from './Zune.js';

/**
 * A transactional upload session.
 *
 * `begin` tells the device a batch is starting (`SyncDeviceDB(1)`), every
 * created object handle is recorded, and `rollback` deletes them in
 * reverse order so a failed batch leaves no orphans in the library.
 */
export class ZuneSync {
  private readonly zune: Zune;
  private readonly created: number[] = [];
  private active = false;

  constructor(zune: Zune) {
    this.zune = zune;
  }

  /** Handles created during this session, in creation order. */
  get handles(): readonly number[] {
    return this.created;
  }

  /** True between {@link begin} and {@link commit}/{@link rollback}. */
  get isActive(): boolean {
    return this.active;
  }

  /** Start the batch. */
  async begin(): Promise<void> {
    if (this.active) throw new Error('ZuneSync session is already active');
    this.active = true;
    await this.zune.syncDeviceDB(1);
  }

  /** Record a handle created by an upload. */
  track(handle: number): void {
    if (handle) this.created.push(handle);
  }

  /** Flush the batch to the device database. */
  async commit(): Promise<void> {
    await this.zune.syncDeviceDB(1);
    this.active = false;
  }

  /** Delete every object created in this session, newest first. */
  async rollback(): Promise<void> {
    for (let i = this.created.length - 1; i >= 0; i--) {
      try {
        await this.zune.deleteObject(this.created[i]);
      } catch {
        // Keep rolling back even when one handle is already gone.
      }
    }
    this.created.length = 0;
    this.active = false;
  }

  /** Run `fn` inside a session, committing on success and rolling back on failure. */
  async run<T>(fn: (session: ZuneSync) => Promise<T>): Promise<T> {
    await this.begin();
    try {
      const result = await fn(this);
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }
}
