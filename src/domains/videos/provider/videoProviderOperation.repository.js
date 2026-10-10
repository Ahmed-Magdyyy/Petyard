import { videoProviderOperationStatusEnum } from "../../../shared/constants/enums.js";
import { VideoProviderOperationModel } from "./videoProviderOperation.model.js";

function dueFilter(now) {
  return {
    $or: [
      { status: { $in: [videoProviderOperationStatusEnum.PENDING, videoProviderOperationStatusEnum.NEEDS_ATTENTION] }, nextAttemptAt: { $lte: now } },
      { status: videoProviderOperationStatusEnum.RUNNING, leaseExpiresAt: { $lte: now } },
    ],
  };
}

export function createVideoProviderOperationRepository({ model = VideoProviderOperationModel } = {}) {
  return Object.freeze({
    findById(operationId) { return model.findById(operationId); },
    async listAdmin({ page, limit, status, type }) {
      const filter = { ...(status !== undefined ? { status } : {}), ...(type !== undefined ? { type } : {}) };
      const [totalResults, data] = await Promise.all([
        model.countDocuments(filter),
        model.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
          .select({ _id: 1, type: 1, status: 1, failedAttempts: 1, nextAttemptAt: 1,
            createdAt: 1, updatedAt: 1, leaseExpiresAt: 1, completedAt: 1, lastErrorCode: 1,
            lastErrorAt: 1, lastEnqueueErrorCode: 1, lastEnqueueErrorAt: 1 }).lean(),
      ]);
      return { totalResults, data };
    },
    insert(identity, timestamp, session) {
      return model.findOneAndUpdate(
        { dedupeKey: identity.dedupeKey },
        { $setOnInsert: { ...identity, status: videoProviderOperationStatusEnum.PENDING, failedAttempts: 0, nextAttemptAt: timestamp } },
        { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) },
      );
    },
    findByDedupe(identity, session) {
      return model.findOne(
        { dedupeKey: identity.dedupeKey }, null, session ? { session } : undefined,
      );
    },
    claim(operationId, timestamp, leaseMs, activeTargetKey, leaseToken) {
      return model.findOneAndUpdate(
        { _id: operationId, ...dueFilter(timestamp) },
        {
          $set: {
            status: videoProviderOperationStatusEnum.RUNNING,
            leaseToken,
            leaseExpiresAt: new Date(timestamp.getTime() + leaseMs),
            activeTargetKey,
          },
        },
        { new: true },
      );
    },
    complete(operationId, leaseToken, timestamp, purgeAt) {
      return model.findOneAndUpdate(
        { _id: operationId, status: videoProviderOperationStatusEnum.RUNNING, leaseToken, leaseExpiresAt: { $gt: timestamp } },
        {
          $set: {
            status: videoProviderOperationStatusEnum.COMPLETED,
            completedAt: timestamp,
            purgeAt,
          },
          $unset: { leaseToken: "", leaseExpiresAt: "", activeTargetKey: "", nextAttemptAt: "", lastErrorCode: "", lastErrorAt: "" },
        },
        { new: true },
      );
    },
    findRunning(operationId, leaseToken, timestamp) {
      return model.findOne({
        _id: operationId, status: videoProviderOperationStatusEnum.RUNNING, leaseToken, leaseExpiresAt: { $gt: timestamp },
      });
    },
    fail(operationId, leaseToken, timestamp, status, failures, nextAttemptAt, errorCode) {
      return model.findOneAndUpdate(
        { _id: operationId, status: videoProviderOperationStatusEnum.RUNNING, leaseToken, leaseExpiresAt: { $gt: timestamp } },
        {
          $set: {
            status,
            failedAttempts: failures,
            nextAttemptAt,
            lastErrorCode: errorCode,
            lastErrorAt: timestamp,
          },
          $unset: { leaseToken: "", leaseExpiresAt: "", activeTargetKey: "" },
        },
        { new: true },
      );
    },
    listDue(timestamp, limit) {
      return model.find(dueFilter(timestamp))
        .sort({ nextAttemptAt: 1, leaseExpiresAt: 1, _id: 1 })
        .limit(limit)
        .select({ _id: 1 })
        .lean();
    },
    retry(operationId, timestamp) {
      return model.findOneAndUpdate(
        { _id: operationId, status: videoProviderOperationStatusEnum.NEEDS_ATTENTION },
        { $set: { status: videoProviderOperationStatusEnum.PENDING, nextAttemptAt: timestamp } },
        { new: true },
      );
    },
    recordEnqueueFailure(operationId, timestamp, errorCode) {
      return model.findOneAndUpdate(
        { _id: operationId, status: { $in: [videoProviderOperationStatusEnum.PENDING, videoProviderOperationStatusEnum.NEEDS_ATTENTION] } },
        { $set: { lastEnqueueErrorCode: errorCode, lastEnqueueErrorAt: timestamp } },
        { new: true },
      );
    },
  });
}
