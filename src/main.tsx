import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./App";
import { Buffer } from "buffer";

if (!(globalThis as { global?: unknown }).global) {
  (globalThis as { global?: unknown }).global = globalThis;
}
if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
