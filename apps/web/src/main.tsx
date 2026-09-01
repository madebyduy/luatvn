import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("Root container is missing from the document");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
