import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./App";

if (!(globalThis as { global?: unknown }).global) {
  (globalThis as { global?: unknown }).global = globalThis;
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
