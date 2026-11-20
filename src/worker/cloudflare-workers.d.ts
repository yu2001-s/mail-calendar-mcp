// The part of workerd's built-in module the Worker uses. Unit tests replace the
// module with test/cloudflare-workers-stub.ts.
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
