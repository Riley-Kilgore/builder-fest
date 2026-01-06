import { Buffer } from "buffer";

if (!(globalThis as { global?: unknown }).global) {
  (globalThis as { global?: unknown }).global = globalThis;
}

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}
