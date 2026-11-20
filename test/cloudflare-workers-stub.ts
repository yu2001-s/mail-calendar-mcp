// Stands in for the workerd-only module that the Worker and the OAuth library
// import, so unit tests can run their real code. Like workerd, it keeps env.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env
  ) {}
}
