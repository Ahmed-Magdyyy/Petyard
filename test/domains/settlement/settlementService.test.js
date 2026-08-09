import assert from 'node:assert/strict';
import test from 'node:test';

import { settlementOperationKindEnum } from '../../../src/shared/constants/enums.js';
import {
  assertSettlementInvariant,
  createOrFindSettlementLedger,
  createSettlementOperationId,
  validateSettlementInvariant,
} from '../../../src/domains/settlement/settlement.service.js';

function createLedgerModel() {
  const rows = new Map();
  return {
    findOne({ operationId }) {
      return Promise.resolve(rows.get(operationId) ?? null);
    },
    async create([operation]) {
      if (rows.has(operation.operationId)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      const row = { ...operation, _id: `ledger-${rows.size + 1}` };
      rows.set(operation.operationId, row);
      return [row];
    },
  };
}

test('settlement operation ids are deterministic and scoped', () => {
  const first = createSettlementOperationId({
    orderId: 'order-1',
    requestId: 'request-1',
    kind: settlementOperationKindEnum.WALLET_DEBIT,
    idempotencyKey: 'respond-1',
  });
  const repeated = createSettlementOperationId({
    orderId: 'order-1',
    requestId: 'request-1',
    kind: settlementOperationKindEnum.WALLET_DEBIT,
    idempotencyKey: 'respond-1',
  });
  const different = createSettlementOperationId({
    orderId: 'order-1',
    requestId: 'request-1',
    kind: settlementOperationKindEnum.WALLET_CREDIT,
    idempotencyKey: 'respond-1',
  });

  assert.equal(first, repeated);
  assert.notEqual(first, different);
  assert.match(first, /^settlement:[a-f0-9]{64}$/);
});

test('settlement ledger creation is idempotent and rejects reuse conflicts', async () => {
  const LedgerModel = createLedgerModel();
  const operationId = 'settlement:test';
  const input = {
    LedgerModel,
    operationId,
    orderId: 'order-1',
    requestId: 'request-1',
    kind: settlementOperationKindEnum.WALLET_DEBIT,
    amountPiastres: 2500,
    currency: 'egp',
  };

  const first = await createOrFindSettlementLedger(input);
  const second = await createOrFindSettlementLedger(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.ledger._id, first.ledger._id);

  await assert.rejects(
    createOrFindSettlementLedger({ ...input, amountPiastres: 2501 }),
    (error) => error.code === 'SETTLEMENT_OPERATION_CONFLICT',
  );
});

test('settlement invariant reports and rejects imbalance', () => {
  const balanced = validateSettlementInvariant({
    currentOrderValuePiastres: 10000,
    walletDebitedPiastres: 2500,
    cardCapturedPiastres: 7500,
  });
  assert.equal(balanced.valid, true);

  const unbalanced = validateSettlementInvariant({
    currentOrderValuePiastres: 10000,
    walletDebitedPiastres: 2500,
    cardCapturedPiastres: 7000,
  });
  assert.equal(unbalanced.valid, false);
  assert.equal(unbalanced.differencePiastres, 500);
  assert.throws(
    () => assertSettlementInvariant(unbalanced.components),
    (error) => error.code === 'SETTLEMENT_INVARIANT_FAILED',
  );
});
