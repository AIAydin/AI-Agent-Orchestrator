/**
 * Tracks, per preview webview partition, the external origin the renderer has
 * configured (URL mode) — or nothing, meaning loopback/dev-server mode. This
 * is the security-critical channel by which the (trusted) main Forgeboard
 * renderer tells the main process which origin a given preview node's guest
 * is allowed to load and pin, keyed by the exact partition string the
 * `<webview>` element uses.
 *
 * Guest `WebContents` objects have no public API exposing their own partition
 * name, so `webview-security.ts` cannot look this map up by partition
 * directly from a guest's `web-contents-created` handler. Instead this
 * registry is queried by *session identity*: `session.fromPartition(name)`
 * always returns the same `Session` instance for a given partition string for
 * the life of the app, so re-resolving each registered partition's session
 * and comparing it against the guest's `contents.session` reliably identifies
 * which (if any) registered origin applies — with no dependency on the
 * ordering of concurrent `<webview>` attach events (e.g. side-by-side
 * comparison mounts two partitions at once).
 */
export interface PreviewOriginRegistry {
  setConfiguration(
    partition: string,
    configuration: { origin: string | null; authenticationEnabled: boolean } | null,
  ): void;
  /** Direct partition lookup — used at `will-attach-webview` time, when the partition string is already known. */
  allowedOriginForPartition(partition: string): string | null;
  /** Session-identity lookup — used from a guest's own handlers, which have no public API for their partition name. */
  allowedOriginForGuestSession(guestSession: unknown): string | null;
  authenticationEnabledForGuestSession(guestSession: unknown): boolean;
  partitionForGuestSession(guestSession: unknown): string | null;
}

export function createPreviewOriginRegistry(
  resolvePartitionSession: (partition: string) => unknown,
): PreviewOriginRegistry {
  const configurations = new Map<
    string,
    { origin: string | null; authenticationEnabled: boolean }
  >();
  return {
    setConfiguration(partition, configuration) {
      if (configuration === null) configurations.delete(partition);
      else configurations.set(partition, configuration);
    },
    allowedOriginForPartition(partition) {
      return configurations.get(partition)?.origin ?? null;
    },
    allowedOriginForGuestSession(guestSession) {
      for (const [partition, configuration] of configurations) {
        if (resolvePartitionSession(partition) === guestSession) return configuration.origin;
      }
      return null;
    },
    authenticationEnabledForGuestSession(guestSession) {
      for (const [partition, configuration] of configurations) {
        if (resolvePartitionSession(partition) === guestSession) {
          return configuration.authenticationEnabled;
        }
      }
      return false;
    },
    partitionForGuestSession(guestSession) {
      for (const partition of configurations.keys()) {
        if (resolvePartitionSession(partition) === guestSession) return partition;
      }
      return null;
    },
  };
}
