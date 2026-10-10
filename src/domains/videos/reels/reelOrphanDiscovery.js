import { videoOrphanRecoveryStatusEnum } from "../../../shared/constants/enums.js";
import { enqueueVideoProviderOperations, enqueueVideoProviderOperation } from "../provider/videoProvider.queue.js";
import { inspectBunnyOrphan } from "../provider/bunnyOrphanInspection.service.js";
const MARKER = /^petyard-reel-(?:session|recovery):[a-f\d]{24}$/;

// Inspection is read-only. Worker cleanup requires an explicit opt-in.
export function createReelOrphanDiscovery({ repository, provider, libraryId,
  enqueue = enqueueVideoProviderOperation, allowCleanup = false }) {
  if (typeof repository?.getOrphanSearchContext !== "function" ||
      typeof repository?.isGuidTracked !== "function" ||
      typeof provider?.searchReelReservation !== "function" ||
      typeof provider?.getVideo !== "function" ||
      typeof libraryId !== "string" || !/^\d+$/.test(libraryId) ||
      typeof allowCleanup !== "boolean" ||
      (allowCleanup && typeof repository?.commitOrphanCleanup !== "function")) {
    throw new TypeError("Reel orphan discovery dependencies are required");
  }

  async function inspectTarget(sessionId, recoveryId) {
    if (typeof sessionId !== "string" || !/^[a-f\d]{24}$/i.test(sessionId) ||
        (recoveryId !== undefined && (typeof recoveryId !== "string" || !/^[a-f\d]{24}$/i.test(recoveryId)))) {
      throw new TypeError("Invalid Reel upload session ID");
    }
    const context = recoveryId ? await repository.getResourceRecoveryOrphanContext({ sessionId, recoveryId }) :
      await repository.getOrphanSearchContext(sessionId);
    if (!context) return { result: { status: videoOrphanRecoveryStatusEnum.NOT_APPLICABLE } };
    const marker = recoveryId ? `petyard-reel-recovery:${recoveryId.toLowerCase()}` : `petyard-reel-session:${sessionId.toLowerCase()}`;
    if (!MARKER.test(context.providerTitle)) return { result: { status: videoOrphanRecoveryStatusEnum.AMBIGUOUS } };
    const result = await inspectBunnyOrphan({ context, marker, libraryId,
      search: (input) => provider.searchReelReservation(input),
      getVideo: (guid) => provider.getVideo(guid),
      isGuidTracked: (guid) => repository.isGuidTracked(guid) });
    return { context, result };
  }

  async function finishCommit(promise) {
    const result = await promise;
    await enqueueVideoProviderOperations([result?.operationId, ...(result?.operationIds ?? []),
      ...(result?.coverOperationIds ?? [])], enqueue);
    return result;
  }

  return Object.freeze({
    async inspect(sessionId, recoveryId) { return (await inspectTarget(sessionId, recoveryId)).result; },
    async recover(sessionId, recoveryId) {
      if (!allowCleanup) return { status: videoOrphanRecoveryStatusEnum.NOT_ENABLED };
      const { context, result } = await inspectTarget(sessionId, recoveryId);
      if (result.status !== videoOrphanRecoveryStatusEnum.CANDIDATE) return result;
      const committed = await finishCommit(recoveryId ? repository.commitResourceRecoveryOrphan({ sessionId, recoveryId,
        providerGuid: result.providerGuid, expectedContext: context }) : repository.commitOrphanCleanup({ sessionId,
        providerGuid: result.providerGuid }));
      return { status: committed ? videoOrphanRecoveryStatusEnum.CLEANUP_RECORDED : videoOrphanRecoveryStatusEnum.STALE };
    },
  });
}
