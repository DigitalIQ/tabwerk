/** Compatibility API for trusted Tabwerk v0 data. No v1 limits or validation. */
export type LegacyTab = { active?: boolean; [key: string]: unknown };
export interface LegacyWindow {
  id?: number;
  focused?: boolean;
  incognito?: boolean;
  state?: string;
  tabs: LegacyTab[];
  groups?: unknown;
}
export interface LegacyReference {
  id?: number;
  focused?: boolean;
  incognito?: boolean;
  state?: string;
  active: number;
  block: string;
}
export interface BlockIndexEntry { blocks?: string[] }
export interface RetentionEntry { t: number }

export const BLOCK_PREFIX: 'hwin:';
export function gzip(text: string): Promise<string>;
export function gunzip(text: string): Promise<string>;
export function contentKey(text: string): Promise<string>;
export function splitWindow(window: LegacyWindow): Promise<{ ref: LegacyReference; block: string; body: string }>;
export function joinWindow(ref: LegacyReference, data: string): Promise<LegacyWindow>;
export function orphanBlocks(keep: BlockIndexEntry[], drop: BlockIndexEntry[]): string[];
/** Input order is retained. The caller must supply newest entries first. */
export function planRetention<T extends RetentionEntry>(index: T[], now?: number): { keep: T[]; drop: T[] };
