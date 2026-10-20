import type { PipelineRunStudioCommand } from "./run-store-ui-protocol.js";

export function EmptyView({ copy, title }: { copy: string; title: string }) {
  return (
    <div class="empty">
      <div>
        <div class="empty-icon">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="M4 5.5h12M4 10h12M4 14.5h8" />
          </svg>
        </div>
        <strong>{title}</strong>
        <p>{copy}</p>
      </div>
    </div>
  );
}

export function commandDescription(command: PipelineRunStudioCommand): string {
  return command.description || "Run this typed pipeline command.";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || String(error) : String(error);
}

/** Smooth scrolling unless the user asked for reduced motion; CSS cannot override an explicit behavior. */
export function preferredScrollBehavior(
  matchMedia: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia
): ScrollBehavior {
  return matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
