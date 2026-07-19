/** Revokes confirmations that were already open when lifecycle state was cleared. */
export class GitApprovalAuthority {
  #epoch = 0;

  public bind(assertCurrent: () => void): () => void {
    const expectedEpoch = this.#epoch;
    return () => {
      assertCurrent();
      if (this.#epoch !== expectedEpoch) {
        throw new Error('The Git approval was revoked. Review the current operation again.');
      }
    };
  }

  public revokeAll(): void {
    this.#epoch += 1;
  }
}
