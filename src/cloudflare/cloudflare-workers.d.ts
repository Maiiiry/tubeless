declare module "cloudflare:workers" {
  /** Minimal shape of the Workers runtime base class used by src/cloudflare/cloudflare.ts. */
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
