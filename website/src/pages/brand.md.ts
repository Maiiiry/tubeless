import type { APIRoute } from "astro";
import { absUrl } from "../lib/paths";
import { SOCIAL_IMAGE_URL } from "../lib/social-image";

export const GET: APIRoute = () => new Response(`# Tubeless brand

Brand assets for referring to Tubeless in articles, integrations, and community projects.

- [Wordmark for light backgrounds](${absUrl("wordmark.svg")})
- [Wordmark for dark backgrounds](${absUrl("wordmark-inverse.svg")})
- [Square app icon](${absUrl("logo.svg")})

## Social share image

Managed Agentic Workflows. Use this 1200 × 630 JPEG when sharing Tubeless on social media.

- [Download the social share image](${SOCIAL_IMAGE_URL})
`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
