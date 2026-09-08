/**
 * Session/reload generation guard for asynchronous sidecar reads. A new
 * generation deliberately does not wait for an old in-flight operation.
 */
export class SnapshotPollGuard {
  private generation = 0;
  private active?: number;

  invalidate(): void {
    this.generation++;
    this.active = undefined;
  }
  begin(): number | undefined {
    if (this.active === this.generation) return undefined;
    this.active = this.generation;
    return this.generation;
  }
  isCurrent(token: number): boolean { return token === this.generation; }
  end(token: number): void {
    if (this.isCurrent(token) && this.active === token) this.active = undefined;
  }
}
