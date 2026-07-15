export type DataMutationKind = 'import' | 'delete' | 'quit';

export interface BeginDataMutationOptions {
  readonly allowDuringShutdown?: boolean;
}

/** Serializes whole-database mutations against ordinary main-process data operations. */
export class DataOperationGate {
  readonly #activeOperations = new Set<Promise<unknown>>();
  #completeMutation: (() => void) | null = null;
  #mutationCompletion: Promise<void> = Promise.resolve();
  #mutationKind: DataMutationKind | null = null;
  #shuttingDown = false;

  public get mutationCompletion(): Promise<void> {
    return this.#mutationCompletion;
  }

  public get mutationInProgress(): boolean {
    return this.#mutationKind !== null;
  }

  public get mutationKind(): DataMutationKind | null {
    return this.#mutationKind;
  }

  public async run<Output>(operation: () => Output | Promise<Output>): Promise<Output> {
    this.#assertOrdinaryAdmission();
    const pending = Promise.resolve().then(operation);
    this.#activeOperations.add(pending);
    try {
      return await pending;
    } finally {
      this.#activeOperations.delete(pending);
    }
  }

  public async beginMutation(
    kind: DataMutationKind,
    options: BeginDataMutationOptions = {},
  ): Promise<void> {
    if (this.#shuttingDown && !options.allowDuringShutdown) {
      throw new Error('Forgeboard is shutting down.');
    }
    if (this.#mutationKind !== null) {
      throw new Error('Another local-data operation is in progress.');
    }
    this.#mutationKind = kind;
    this.#mutationCompletion = new Promise<void>((resolveCompletion) => {
      this.#completeMutation = resolveCompletion;
    });
    await Promise.allSettled([...this.#activeOperations]);
  }

  public finishMutation(): void {
    if (this.#mutationKind === null) return;
    this.#mutationKind = null;
    this.#completeMutation?.();
    this.#completeMutation = null;
  }

  /** Closes ordinary admissions before the application starts draining its services. */
  public beginShutdown(): void {
    this.#shuttingDown = true;
  }

  #assertOrdinaryAdmission(): void {
    if (this.#shuttingDown) throw new Error('Forgeboard is shutting down.');
    if (this.#mutationKind !== null) {
      throw new Error('Another local-data operation is in progress.');
    }
  }
}
