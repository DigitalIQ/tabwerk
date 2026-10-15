export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SessionTab {
  [key: string]: JsonValue;
  id: number;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  groupId: number;
}

export interface SessionGroup {
  [key: string]: JsonValue;
  id: number;
  title: string;
  color: string;
  collapsed: boolean;
}

export interface SessionWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  state: string;
  tabs: SessionTab[];
  groups: SessionGroup[];
}

export interface CodecOptions {
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxTabs?: number;
  maxGroups?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface WindowReference {
  version: 1;
  id: number;
  focused: boolean;
  incognito: boolean;
  state: string;
  /** Index in the block's tab array, or -1 if no tab is active. */
  active: number;
  /** Lowercase SHA-256 of the uncompressed UTF-8 block JSON. */
  block: string;
}

export interface WindowBlock {
  version: 1;
  encoding: 'gzip-base64';
  hash: string;
  data: string;
}

export interface EncodedWindow { ref: WindowReference; block: WindowBlock }

export const DEFAULT_LIMITS: Readonly<Required<CodecOptions>>;
export function encodeWindow(window: SessionWindow, options?: CodecOptions): Promise<EncodedWindow>;
export function decodeWindow(ref: WindowReference, block: WindowBlock, options?: CodecOptions): Promise<SessionWindow>;
