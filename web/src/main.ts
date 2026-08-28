import "./styles.css";

import { DashboardApp } from "./app";
import { loadDashboard } from "./config/dashboard";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

const dashboard = await loadDashboard();
const application = new DashboardApp(root, dashboard);
await application.start();
