import { createHash } from 'node:crypto';

import { ApiError } from '../../shared/utils/ApiError.js';
import {
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
} from '../../shared/constants/enums.js';
import { assertPiastres, normalizeCurrency } from '../../shared/utils/money.js';
import { SettlementLedgerModel } from './settlementLedger.model.js';

const SETTLEMENT_COMPONENTS = Object.freeze({
  walletDebitedPiastres: 1,
  walletCreditedPiastres: -1,
  cardCapturedPiastres: 1,
  cardRefundedPiastres: -1,
  cardDuePiastres: 1,
  instapaySubmittedPiastres: 1,
  instapayConfirmedPiastres: 1,
  deliveryDuePiastres: 1,
  pendingRefundLiabilityPiastres: -1,
});

function settlementError(message, statusCode, code) {
  const error = new ApiError(message, statusCode);
  error.code = code;
  return error;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw settlementError(`${field} is required`, 400, 'SETTLEMENT_INVALID_OPERATION');
  }
  return value.trim();
}

function normalizeId(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return undefined;
    throw settlementError(`${field} is required`, 400, 'SETTLEMENT_INVALID_OPERATION');
  }
  return String(value);
}

function normalizeOperation(input) {
  const operationId = requireNonEmptyString(input.operationId, 'operationId');
  const order = normalizeId(input.order ?? input.orderId, 'order');
  const request = normalizeId(input.request ?? input.requestId, 'request', { required: false });
  const kind = input.kind;
  const status = input.status ?? settlementOperationStatusEnum.PENDING;

  if (!Object.values(settlementOperationKindEnum).includes(kind)) {
    throw settlementError('Invalid settlement operation kind', 400, 'SETTLEMENT_INVALID_OPERATION');
  }
  if (!Object.values(settlementOperationStatusEnum).includes(status)) {
    throw settlementError('Invalid settlement operation status', 400, 'SETTLEMENT_INVALID_OPERATION');
  }

  try {
    assertPiastres(input.amountPiastres, 'amountPiastres');
  } catch (error) {
    throw settlementError(error.message, 400, 'SETTLEMENT_INVALID_AMOUNT');
  }

  let currency;
  try {
    currency = normalizeCurrency(input.currency ?? 'EGP');
  } catch (error) {
    throw settlementError(error.message, 400, 'SETTLEMENT_INVALID_CURRENCY');
  }

  return {
    operationId,
    order,
    request,
    kind,
    status,
    amountPiastres: input.amountPiastres,
    currency,
    actor: input.actor ?? input.actorId,
    providerReference: input.providerReference,
    metadata: input.metadata,
  };
}

export function createSettlementOperationId({ orderId, requestId, kind, idempotencyKey }) {
  const order = normalizeId(orderId, 'orderId');
  const request = normalizeId(requestId, 'requestId', { required: false }) ?? 'order';
  const operationKind = requireNonEmptyString(kind, 'kind');
  const key = requireNonEmptyString(idempotencyKey, 'idempotencyKey');
  const digest = createHash('sha256')
    .update(JSON.stringify(['settlement-v1', order, request, operationKind, key]))
    .digest('hex');
  return `settlement:${digest}`;
}

function compareExistingOperation(existing, expected) {
  const mismatches = ['order', 'request', 'kind', 'amountPiastres', 'currency']
    .filter((field) => {
      const stored = existing[field] == null ? undefined : String(existing[field]);
      const wanted = expected[field] == null ? undefined : String(expected[field]);
      return stored !== wanted;
    });

  if (mismatches.length) {
    throw settlementError(
      'Settlement operation id was already used with different data',
      409,
      'SETTLEMENT_OPERATION_CONFLICT',
    );
  }
}

async function findByOperationId({ LedgerModel, operationId, session }) {
  let query = LedgerModel.findOne({ operationId });
  if (session && typeof query.session === 'function') query = query.session(session);
  return query;
}

export async function findSettlementLedgerByOperationId({
  operationId,
  session,
  LedgerModel = SettlementLedgerModel,
}) {
  return findByOperationId({
    LedgerModel,
    operationId: requireNonEmptyString(operationId, 'operationId'),
    session,
  });
}

export async function createOrFindSettlementLedger(input) {
  const { LedgerModel = SettlementLedgerModel, session } = input;
  const operation = normalizeOperation(input);
  const existing = await findByOperationId({
    LedgerModel,
    operationId: operation.operationId,
    session,
  });
  if (existing) {
    compareExistingOperation(existing, operation);
    return { ledger: existing, created: false };
  }

  try {
    const created = await LedgerModel.create([operation], session ? { session } : undefined);
    return { ledger: Array.isArray(created) ? created[0] : created, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const concurrent = await findByOperationId({
      LedgerModel,
      operationId: operation.operationId,
      session,
    });
    if (!concurrent) throw error;
    compareExistingOperation(concurrent, operation);
    return { ledger: concurrent, created: false };
  }
}

export function validateSettlementInvariant(summary = {}) {
  const components = {};
  let actualPiastres = 0;

  for (const [field, sign] of Object.entries(SETTLEMENT_COMPONENTS)) {
    try {
      components[field] = assertPiastres(summary[field] ?? 0, field);
    } catch (error) {
      return { valid: false, reason: error.message, components };
    }
    actualPiastres += sign * components[field];
  }

  let expectedPiastres;
  try {
    expectedPiastres = assertPiastres(
      summary.currentOrderValuePiastres,
      'currentOrderValuePiastres',
    );
  } catch (error) {
    return { valid: false, reason: error.message, components, actualPiastres };
  }

  return {
    valid: actualPiastres === expectedPiastres,
    expectedPiastres,
    actualPiastres,
    differencePiastres: expectedPiastres - actualPiastres,
    components,
  };
}

export function assertSettlementInvariant(summary) {
  const result = validateSettlementInvariant(summary);
  if (!result.valid) {
    throw settlementError(
      result.reason || 'Settlement invariant does not balance',
      409,
      'SETTLEMENT_INVARIANT_FAILED',
    );
  }
  return result;
}
