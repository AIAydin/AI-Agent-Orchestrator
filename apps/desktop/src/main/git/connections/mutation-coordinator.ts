export interface GitRemoteDeliveryMutationBoundary {
  pauseForDataMutation(): Promise<void>;
  pauseForGitHubRuntimeMutation(): void;
  resumeAfterPrivacyReset(): void;
}

type MutationKind = 'remote-configuration' | 'github-cli';

/**
 * Keeps the two Settings mutation domains from independently reopening remote delivery.
 * Admission is deliberately single-flight: a second window must retry after the active review.
 */
export class GitConnectionsMutationCoordinator {
  #active: MutationKind | null = null;

  public constructor(private readonly delivery: GitRemoteDeliveryMutationBoundary) {}

  public async withRemoteConfigurationMutation<Output>(
    operation: () => Promise<Output>,
  ): Promise<Output> {
    return await this.#run(
      'remote-configuration',
      async () => await this.delivery.pauseForDataMutation(),
      operation,
    );
  }

  public async withGitHubCliMutation<Output>(operation: () => Promise<Output>): Promise<Output> {
    return await this.#run(
      'github-cli',
      () => this.delivery.pauseForGitHubRuntimeMutation(),
      operation,
    );
  }

  async #run<Output>(
    kind: MutationKind,
    pause: () => void | Promise<void>,
    operation: () => Promise<Output>,
  ): Promise<Output> {
    if (this.#active !== null) {
      throw new Error(
        'Another Git connection or GitHub CLI change is still finishing. Try again when it completes.',
      );
    }
    this.#active = kind;
    let paused = false;
    try {
      await pause();
      paused = true;
      return await operation();
    } finally {
      try {
        if (paused) this.delivery.resumeAfterPrivacyReset();
      } finally {
        this.#active = null;
      }
    }
  }
}
