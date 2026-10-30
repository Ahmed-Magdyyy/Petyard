import { createHash } from "node:crypto";
import { feedGenerationKey, orderVideoFeed } from "./videoFeed.policy.js";
import { createVideoFeedSnapshotStore } from "./videoFeedSnapshot.store.js";

export function createVideoFeedService({ repository, snapshots = createVideoFeedSnapshotStore(),
  order = orderVideoFeed, now = Date.now } = {}) {
  return Object.freeze({
    async list({ page, limit, kind, identity, feedScope = "", includeReels, includeProducts }) {
      // Anonymous reads keep the public fallback; do not fingerprint visitors for a feed identity.
      if (!identity) return null;
      const scope = createHash("sha256").update(JSON.stringify([
        identity.type, identity.id, feedScope, kind, includeReels, includeProducts,
      ])).digest("hex");
      const key = `${process.env.BULLMQ_QUEUE_PREFIX || "petyard"}:videos:feed:v1:${scope}`;
      let candidates;
      const snapshot = await snapshots.resolve(key, { refresh: page === 1, build: async () => {
        candidates = await repository.listFeedCandidates({ includeReels, includeProducts });
        const seen = await repository.seenFeedGenerations({ identity, candidates, now: now() });
        return order(candidates, seen);
      } });
      if (!snapshot) return null;
      candidates ??= await repository.listFeedCandidates({ includeReels, includeProducts });
      const current = new Map(candidates.map(video => [feedGenerationKey(video), video]));
      // Recheck publication, flags, product and current media on every page; no cached DTOs.
      const eligible = snapshot.order.filter(key => current.has(key));
      const selected = eligible.slice((page - 1) * limit, page * limit).map(key => current.get(key));
      const rows = await repository.loadFeedRows({ candidates: selected, includeReels, includeProducts });
      const byKey = new Map(rows.map(video => [feedGenerationKey(video), video]));
      return { totalResults: eligible.length,
        data: selected.map(feedGenerationKey).map(key => byKey.get(key)).filter(Boolean) };
    },
  });
}
