# Prime Location API additions

Prime is geographic eligibility for delivery from the warehouse serving its own zone. It is available to guests and registered users. It is not a paid membership.

## Warehouse administration

The existing `POST /api/v1/warehouses` and `PATCH /api/v1/warehouses/:id` permissions remain unchanged.

Add these optional fields:

| Field | Meaning |
| --- | --- |
| `primeBoundaryGeometry` | GeoJSON `MultiPolygon` in `[longitude, latitude]` order, fully contained in `boundaryGeometry` |
| `primeShippingPrice` | Number from zero through `defaultShippingPrice`, inclusive |

Configure both together. Use a MultiPolygon even for a single area. Several separate polygons use the same prime price. Zero is an explicit valid price. Omitted PATCH fields preserve their previous values. Send both fields as null to disable Prime.

```json
{
  "primeBoundaryGeometry": {
    "type": "MultiPolygon",
    "coordinates": [
      [[[31.500, 29.950], [31.505, 29.950], [31.505, 29.955], [31.500, 29.955], [31.500, 29.950]]],
      [[[31.510, 29.960], [31.515, 29.960], [31.515, 29.965], [31.510, 29.965], [31.510, 29.960]]]
    ]
  },
  "primeShippingPrice": 20
}
```

The example requires an existing parent boundary containing both areas. Invalid geometry, a partially configured pair, a prime price exceeding the normal price, or a parent edit that excludes Prime returns 400. A conflicting concurrent delivery-configuration edit returns 409; reload the warehouse before retrying. Geometry is excluded from warehouse lists, as the existing delivery boundary already is; warehouse detail retains geometry.

## Customer response additions

Existing fields, types, identifiers, nesting, envelopes, and request requirements remain unchanged. These fields are additive:

| Response | New field |
| --- | --- |
| `POST /api/v1/locations/resolve` | `data.isPrimeLocation` |
| Resolver `warehouse` and `zoneWarehouse` summaries | `primeShippingPrice`, nullable when unconfigured |
| User and guest saved addresses, including lists/default selection/merge | `isPrimeLocation` on each address |
| Customer cart reads, address selection, item changes, and cart merge | `data.isPrimeLocation` |
| User and guest checkout summaries and coupon application service | `isPrimeLocation` on the returned result |
| Newly created orders | `isPrimeLocation`, locked at creation |

Resolver response excerpt:

```json
{
  "data": {
    "isPrimeLocation": true,
    "warehouse": { "id": "<id>", "defaultShippingPrice": 50, "primeShippingPrice": 20 },
    "delivery": { "effectiveShippingPrice": 20, "shippingFee": 20, "defaultShippingPrice": 50 }
  }
}
```

The excerpt omits unchanged fields. `defaultShippingPrice` always means normal warehouse shipping. Resolver fees are the geographic base price before cart subtotal or coupons. Cart GET, checkout, and final order use the prime fee when eligible; the existing free-shipping threshold and coupon/wallet calculations still apply. Cart mutation/merge paths that historically return zero shipping keep that legacy response behavior; refresh cart GET or checkout for the calculated fee.

Saved-address `warehouse` remains the geographic zone ID. Cart-level `warehouseId` remains the actual fulfillment warehouse ID. The server keeps source context internally in its cart address snapshot; the new internal source field is not added to the public cart address object.

## Eligibility and frontend use

- Use the selected location/address's boolean to choose the Prime theme.
- Points on prime edges, including hole-ring edges, qualify. Points inside holes, between separate prime areas, or outside warehouse coverage do not.
- Coarse governorate/area selection cannot establish Prime and returns false.
- Maintenance rerouting disables Prime, including when the fallback warehouse has a matching prime area. Closed/inactive warehouses keep their existing delivery rejection behavior.
- Saved-address response flags are refreshed from current warehouse configuration. Cart, checkout, and new orders determine eligibility on the server; submitted flags and prices do not grant benefits.
- Missing fields from older responses/cache mean false until refreshed. A zero fee alone is not proof of Prime.
- Prime themes belong to customer app runtime behavior; UI Builder targeting is unchanged.
- Historical orders created before the feature may omit the flag. Their original fee and settlement amounts remain unchanged. Do not infer their historic eligibility from today's geometry.

No numeric delivery-time promise is supplied. Existing clients do not need to send any new fields. Released-client parsing and end-to-end payment behavior require staging verification before production activation.
