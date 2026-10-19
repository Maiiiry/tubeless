import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { absUrl, href } from "./paths";

const image = readFileSync(join(__REPO_ROOT__, "website/public/og.jpg"));
const revision = createHash("sha256").update(image).digest("hex").slice(0, 12);
const path = `og.jpg?v=${revision}`;

export const SOCIAL_IMAGE_HREF = href(path);
export const SOCIAL_IMAGE_URL = absUrl(path);
export const SOCIAL_IMAGE_ALT = "Tubeless — Managed Agentic Workflows. Ivory tubes surround a large wordmark on warm paper, with the five-color brand stripe above.";
