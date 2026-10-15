// Bestehende hwin-Blöcke behalten ihr Format. Die Implementierung gehört zum Codec-Paket.
export {
  BLOCK_PREFIX, gzip, gunzip, contentKey, splitWindow, joinWindow, orphanBlocks,
} from '../../packages/session-codec/src/legacy.js';
