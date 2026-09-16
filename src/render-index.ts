/**
 * On-disk index of rendered formulas, keyed by render key.
 *
 * The service re-renders a formula whenever its in-process cache is cold, and
 * that cache dies with the process, which is every render for a `spawnSync`
 * client. This index records the PNG produced for a render key, so a formula is
 * rendered once per (source, colours, geometry) and then never again, including
 * across pi restarts.
 *
 * The version tag belongs to the caller: a renderer whose output changed bumps
 * it, and every entry written under the old tag is ignored on load.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One rendered formula on disk. */
export interface RenderEntry {
  key: string;
  path: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Key to entry mapping persisted as JSON.
 *
 * Writes are atomic (temp file + rename) because a crash mid-write would
 * otherwise discard the whole cache.
 */
export class RenderIndex {
  private readonly file: string;
  private readonly version: string;
  private entries: Map<string, RenderEntry> | undefined;
  private dirty = false;

  constructor(file: string, version: string) {
    this.file = file;
    this.version = version;
  }

  /** Entries whose PNG no longer exists are dropped. */
  get(key: string): RenderEntry | undefined {
    const entry = this.load().get(key);
    if (!entry) return undefined;
    if (existsSync(entry.path)) return entry;
    this.entries?.delete(key);
    this.dirty = true;
    return undefined;
  }

  set(entry: RenderEntry): void {
    this.load().set(entry.key, entry);
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    const entries = this.load();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const payload = JSON.stringify({ version: this.version, entries: [...entries.values()] });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, payload, "utf8");
      renameSync(temp, this.file);
      this.dirty = false;
    } catch {
      // A cache write failure must never break rendering.
    }
  }

  private load(): Map<string, RenderEntry> {
    if (this.entries) return this.entries;
    const entries = new Map<string, RenderEntry>();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as {
        version?: string;
        entries?: RenderEntry[];
      };
      if (raw.version === this.version && Array.isArray(raw.entries)) {
        for (const entry of raw.entries) {
          if (entry && typeof entry.key === "string" && typeof entry.path === "string") {
            entries.set(entry.key, entry);
          }
        }
      }
    } catch {
      // Missing or corrupt index: start empty.
    }
    this.entries = entries;
    return entries;
  }
}
