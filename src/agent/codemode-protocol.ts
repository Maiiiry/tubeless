/** Script source and callable names supplied to one code-mode worker. */
export interface CodemodeWorkerData {
  readonly code: string;
  readonly tools: readonly string[];
  /** In-realm log bounds; the host enforces exact UTF-8 limits afterwards. */
  readonly maxLogLines: number;
  readonly maxLogCharacters: number;
}

/** Every value crossing the realm boundary is JSON text, so no host object reaches the script. */
export type CodemodeWorkerMessage =
  | { readonly type: "call"; readonly id: number; readonly name: string; readonly input: string }
  | {
      readonly type: "done";
      readonly ok: true;
      readonly result: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    }
  | {
      readonly type: "done";
      readonly ok: false;
      readonly message: string;
      readonly logs: readonly string[];
      readonly logsTruncated: boolean;
    };

/** JSON text of a `CodemodeReply`. */
export interface CodemodeHostMessage {
  readonly type: "reply";
  readonly id: number;
  readonly reply: string;
}

export type CodemodeReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };
