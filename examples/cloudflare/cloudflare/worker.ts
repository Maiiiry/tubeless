import { createCloudflareApp } from "tubeless/cloudflare";
import project from "../tubeless.project.ts";

const app = createCloudflareApp(project);

export default app.worker;
export const { TubelessStudio, TubelessRun } = app.durableObjects;
