import "./styles.css";

import { DashboardApp } from "./app";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

const application = new DashboardApp(root);
void application.start();
