import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validationResult } from "express-validator";

import {
  RestockSubscriptionModel,
  restockSubscriptionStatus,
} from "../../src/domains/restockSubscription/restockSubscription.model.js";
import {
  aggregateRestockDemandSubscribers,
  aggregateRestockDemandSummary,
} from "../../src/domains/restockSubscription/restockSubscription.repository.js";
import {
  getRestockDemandSubscribersService,
  getRestockDemandSummaryService,
} from "../../src/domains/restockSubscription/restockSubscription.service.js";
import {
  restockDemandSubscribersValidator,
  restockDemandSummaryValidator,
} from "../../src/domains/restockSubscription/restockSubscription.validators.js";
import restockSubscriptionRoutes from "../../src/domains/restockSubscription/restockSubscription.routes.js";

function id() {
  return new mongoose.Types.ObjectId();
}

async function validationErrors(validators, request) {
  for (const validator of validators.slice(0, -1)) {
    await validator.run(request);
  }
  return validationResult(request).array();
}

test("demand validators normalize pagination and reject invalid query values", async () => {
  const validRequest = { query: { warehouse: id().toString(), search: "  kibble  " } };
  assert.equal((await validationErrors(restockDemandSummaryValidator, validRequest)).length, 0);
  assert.equal(validRequest.query.page, 1);
  assert.equal(validRequest.query.limit, 20);
  assert.equal(validRequest.query.search, "kibble");

  const invalidRequest = { query: { page: "0", limit: "101" }, params: { productId: "invalid" } };
  const errors = await validationErrors(restockDemandSubscribersValidator, invalidRequest);
  assert.equal(errors.length, 3);
});

test("aggregate demand route is registered before guest customer routes", () => {
  const adminIndex = restockSubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/admin/demand",
  );
  const subscribersIndex = restockSubscriptionRoutes.stack.findIndex(
    (layer) =>
      layer.route?.path === "/admin/demand/:productId/subscribers",
  );
  const customerParameterIndex = restockSubscriptionRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/:productId",
  );

  assert.ok(adminIndex >= 0 && adminIndex < customerParameterIndex);
  assert.ok(
    subscribersIndex >= 0 && subscribersIndex < customerParameterIndex,
  );
  assert.ok(restockSubscriptionRoutes.stack[adminIndex].route.stack.length >= 7);
  assert.ok(
    restockSubscriptionRoutes.stack[subscribersIndex].route.stack.length >= 7,
  );
});

test("summary aggregation groups warehouse demand beneath one product and preserves orphan IDs", async (t) => {
  const warehouseId = id();
  let pipeline;
  t.mock.method(RestockSubscriptionModel, "aggregate", (nextPipeline) => {
    pipeline = nextPipeline;
    return [];
  });

  await aggregateRestockDemandSummary({
    warehouseScope: [warehouseId],
    searchRegex: /kibble/i,
    page: 2,
    limit: 10,
  });

  assert.deepEqual(pipeline[0].$match.status.$in, [
    restockSubscriptionStatus.ACTIVE,
    restockSubscriptionStatus.PROCESSING,
  ]);
  assert.deepEqual(pipeline[0].$match.warehouse.$in, [warehouseId]);
  const groups = pipeline.filter((stage) => stage.$group);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].$group._id, {
    product: "$product",
    warehouse: "$warehouse",
  });
  assert.equal(groups[1].$group._id, "$_id.product");
  assert.ok(groups[1].$group.warehouseDemand.$push);
  assert.ok(pipeline.find((stage) => stage.$facet));
  assert.ok(pipeline.find((stage) => stage.$facet?.data?.some((entry) => entry.$skip === 10)));

  const groupIndex = pipeline.findIndex((stage) => stage.$group);
  const facetIndex = pipeline.findIndex((stage) => stage.$facet);
  assert.ok(groupIndex < facetIndex);
  const summaryProjection = pipeline.find((stage) => stage.$facet)?.$facet.data.at(-1).$project;
  assert.equal(summaryProjection.product.id, "$_id");
  assert.equal(summaryProjection.warehouse, undefined);
  assert.equal(summaryProjection.warehouseDemand, 1);
});

test("summary service localizes names, escapes search, and derives total from safe identity counts", async (t) => {
  const productId = id();
  const warehouseId = id();
  let pipeline;
  t.mock.method(RestockSubscriptionModel, "aggregate", (nextPipeline) => {
    pipeline = nextPipeline;
    return [
      {
        metadata: [{ totalDemandGroups: 1 }],
        data: [
          {
            product: {
              id: productId,
              slug: "dry-kibble",
              name_en: "Dry kibble",
              name_ar: "دراي كيبل",
              image: null,
            },
            totalSubscribers: 5,
            registeredUserCount: 2,
            anonymousGuestCount: 3,
            oldestSubscribedAt: new Date("2026-08-01T00:00:00.000Z"),
            latestSubscribedAt: new Date("2026-08-02T00:00:00.000Z"),
            warehouseDemand: [
              {
                warehouse: { id: warehouseId, name: null, code: null },
                totalSubscribers: 3,
                registeredUserCount: 1,
                anonymousGuestCount: 2,
                oldestSubscribedAt: new Date("2026-08-01T00:00:00.000Z"),
                latestSubscribedAt: new Date("2026-08-02T00:00:00.000Z"),
              },
              {
                warehouse: { id: id(), name: "Cairo", code: "CAI" },
                totalSubscribers: 2,
                registeredUserCount: 1,
                anonymousGuestCount: 1,
                oldestSubscribedAt: new Date("2026-08-01T12:00:00.000Z"),
                latestSubscribedAt: new Date("2026-08-01T18:00:00.000Z"),
              },
            ],
          },
        ],
      },
    ];
  });

  const result = await getRestockDemandSummaryService({
    search: "dry.*",
    page: 1,
    limit: 20,
    warehouseScope: null,
    lang: "ar",
  });

  assert.equal(result.totalDemandGroups, 1);
  assert.equal(result.totalPages, 1);
  assert.equal(result.data[0].product.name, "دراي كيبل");
  assert.equal(result.data[0].totalSubscribers, 5);
  assert.equal(result.data[0].product.name_en, undefined);
  assert.equal(result.data[0].warehouse, undefined);
  assert.equal(result.data[0].warehouseDemand.length, 2);
  assert.equal(result.data[0].warehouseDemand[0].totalSubscribers, 3);
  const searchStage = pipeline.find((stage) => stage.$match?.$or);
  assert.equal(searchStage.$match.$or[0]["productDocument.name_en"].source, "dry\\.\\*");
});

test("subscriber aggregation has a minimal identity projection and service rejects disallowed warehouses", async (t) => {
  const productId = id();
  const allowedWarehouseId = id();
  const disallowedWarehouseId = id();
  let pipeline;
  t.mock.method(RestockSubscriptionModel, "aggregate", (nextPipeline) => {
    pipeline = nextPipeline;
    return [
      {
        counts: [{
          registeredUserCount: 1,
          unavailableRegisteredUserCount: 0,
          anonymousGuestCount: 2,
        }],
        data: [
          {
            id: id(),
            name: "Amina",
            image: "https://media.example/avatar.webp",
            warehouse: { id: allowedWarehouseId, name: "Nasr City", code: "NC" },
            subscribedAt: new Date("2026-08-01T00:00:00.000Z"),
            status: restockSubscriptionStatus.ACTIVE,
          },
        ],
      },
    ];
  });

  const result = await getRestockDemandSubscribersService({
    productId: productId.toString(),
    page: 1,
    limit: 20,
    warehouseScope: [allowedWarehouseId],
  });

  assert.equal(result.totalSubscribers, 3);
  assert.equal(result.registeredUserCount, 1);
  assert.equal(result.unavailableRegisteredUserCount, 0);
  assert.equal(result.anonymousGuestCount, 2);
  assert.deepEqual(Object.keys(result.data[0]).sort(), [
    "id",
    "image",
    "name",
    "status",
    "subscribedAt",
    "warehouse",
  ]);

  await assert.rejects(
    getRestockDemandSubscribersService({
      productId: productId.toString(),
      warehouseId: disallowedWarehouseId.toString(),
      page: 1,
      limit: 20,
      warehouseScope: [allowedWarehouseId],
    }),
    (error) => error.statusCode === 403,
  );

  await aggregateRestockDemandSubscribers({
    productId,
    warehouseScope: [allowedWarehouseId],
    page: 1,
    limit: 20,
  });
  assert.deepEqual(pipeline[0].$match.status.$in, [
    restockSubscriptionStatus.ACTIVE,
    restockSubscriptionStatus.PROCESSING,
  ]);
  const projection = pipeline.find((stage) => stage.$facet).$facet.data.at(-1).$project;
  assert.equal(projection.image, "$userDocument.image.url");
  assert.equal(Object.hasOwn(projection, "email"), false);
  assert.equal(Object.hasOwn(projection, "phone"), false);
});
