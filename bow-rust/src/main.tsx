import React from "react";
import ReactDOM from "react-dom/client";
import InstanceManager from "./InstanceManager";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <InstanceManager />
  </React.StrictMode>,
);
