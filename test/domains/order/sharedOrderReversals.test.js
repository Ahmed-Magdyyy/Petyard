import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { updateOrderStatusService } from "../../../src/domains/order/order.service.js";
import { createReturnRequestService, processReturnRequestService } from "../../../src/domains/return/return.service.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ReturnRequestModel } from "../../../src/domains/return/return.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { WalletTransactionModel } from "../../../src/domains/wallet/walletTransaction.model.js";
import { LoyaltyTransactionModel } from "../../../src/domains/loyalty/loyaltyTransaction.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { InventoryAuditModel } from "../../../src/domains/inventory/inventoryAudit.model.js";
import { RestockSubscriptionModel } from "../../../src/domains/restockSubscription/restockSubscription.model.js";
import { InAppNotificationModel } from "../../../src/domains/notification/inAppNotification.model.js";
import { NotificationDeviceModel } from "../../../src/domains/notification/notification.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import { SubstitutionRequestModel } from "../../../src/domains/substitution/substitutionRequest.model.js";
import { OrderPaymentAttemptModel } from "../../../src/domains/payment/orderPaymentAttempt.model.js";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";
import { buildBundleOrderMerchandise } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { bindPendingBundleSubstitution } from "../../../src/domains/bundle/bundle.substitution-pending.js";
import { presentOrder } from "../../../src/domains/order/order.presenter.js";

const U="111111111111111111111111", W="222222222222222222222222", P="333333333333333333333333";
const V="444444444444444444444444", B="555555555555555555555555", G="666666666666666666666666";
const O="777777777777777777777777", R="888888888888888888888888", A="999999999999999999999999";
const Q="aaaaaaaaaaaaaaaaaaaaaaaa", ELSEWHERE="bbbbbbbbbbbbbbbbbbbbbbbb", OTHER_VARIANT="cccccccccccccccccccccccc";
const clone=value=>mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
const query=read=>{ let session; return { session(value){session=value;return this;},select(){return this;},lean(){return this;},
  then(resolve,reject){return Promise.resolve().then(()=>read(session)).then(resolve,reject);} };};

async function fixture(t,{paymentMethod="card",ordinary=true,status="accepted",committed=true,loyalty=false,guest=false}={}) {
  const s={active:false,audits:[],stockWrites:[],ledger:[],loyaltyLedger:[],outbox:[],orderSaves:0,requestSaves:0,
    user:{walletBalance:100,loyaltyPoints:loyalty?10:0},returnRequest:null};
  const oldRedis=process.env.REDIS_URL; process.env.REDIS_URL="";
  t.after(()=>{if(oldRedis===undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL=oldRedis;});
  s.products=[{_id:P,type:"SIMPLE",isActive:true,price:10,name_en:"Food",images:[],warehouseStocks:[{warehouse:W,quantity:10,revision:2},{warehouse:ELSEWHERE,quantity:1000,revision:7}]},
    {_id:V,type:"VARIANT",isActive:true,name_en:"Toy",images:[],variants:[{_id:Q,price:20,options:[],images:[],warehouseStocks:[{warehouse:W,quantity:10,revision:3},{warehouse:ELSEWHERE,quantity:1000,revision:8}]},
      {_id:OTHER_VARIANT,price:20,warehouseStocks:[{warehouse:W,quantity:1000,revision:9}]}]}];
  const plan=buildBundleCartPurchasePlan({warehouseId:W,warehouse:{_id:W,active:true},products:s.products,
    bundles:[{groupId:G,expectedRevision:1,quantity:2,bundle:{_id:B,origin:"manual",status:"published",revision:1,name_en:"Kit",pricePiastres:1500,
      components:[{productId:P,productType:"SIMPLE",quantity:2},{productId:V,productType:"VARIANT",variantId:Q,quantity:1}]}}]});
  const items=ordinary?[{product:P,productType:"SIMPLE",productName:"Food",quantity:2,fulfillmentQuantity:2,finalizedUnavailableQuantity:0,
    lineId:"ordinary",lineKind:"original",itemPrice:10,itemPricePiastres:1000,lineTotal:20,lineTotalPiastres:2000}]:[];
  const identity=guest?{userId:null,guestId:"guest-reversal-fixture"}:{userId:U};
  const merchandise=buildBundleOrderMerchandise({plan,ordinaryItems:items,...identity});
  const subtotal=merchandise.subtotal,walletUsed=guest?0:10,total=subtotal+50-walletUsed;
  s.order=new OrderModel({_id:O,user:guest?null:U,guestId:identity.guestId,warehouse:W,orderNumber:"REVERSAL-FIXTURE",currency:"EGP",...merchandise,shippingFee:50,
    discountAmount:0,total,walletUsed,paymentMethod,paymentStatus:paymentMethod==="cod"||paymentMethod==="pos_on_delivery"?"pending":"paid",
    status,sideEffectsCommitted:committed,loyaltyPointsAwarded:loyalty?60:0,updatedAt:new Date(),history:[],
    settlement:{schemaVersion:1,revision:0,currency:"EGP",migrationState:"native",currentMerchandiseGrossPiastres:subtotal*100,
      originalCouponDiscountPiastres:0,preservedCouponDiscountPiastres:0,lockedNetShippingPiastres:5000,currentOrderValuePiastres:(subtotal+50)*100,
      walletDebitedPiastres:walletUsed*100,walletCreditedPiastres:0,cardCapturedPiastres:paymentMethod==="card"?total*100:0,cardRefundedPiastres:0,cardDuePiastres:0,
      instapaySubmittedPiastres:0,instapayConfirmedPiastres:paymentMethod==="instapay"?total*100:0,
      deliveryDuePiastres:paymentMethod==="cod"||paymentMethod==="pos_on_delivery"?total*100:0,pendingRefundLiabilityPiastres:0}}).toObject();
  await new OrderModel(s.order).validate();
  const assertSession=session=>{assert.equal(session,s.session);assert.equal(s.active,true);};
  s.session={inTransaction:()=>s.active,endSession(){},async withTransaction(callback){
    const snapshot=clone({order:s.order,products:s.products,user:s.user,audits:s.audits,ledger:s.ledger,loyaltyLedger:s.loyaltyLedger,returnRequest:s.returnRequest,substitution:s.substitution});
    s.active=true;try{return await callback();}catch(error){Object.assign(s,snapshot);throw error;}finally{s.active=false;}
  }};
  // This models a caller abort only; it does not prove native MongoDB rollback or retries.
  t.mock.method(mongoose,"startSession",async()=>s.session);
  t.mock.method(console,"warn",()=>{});
  t.mock.method(mongoose,"connect",()=>assert.fail("No database connections"));
  t.mock.method(mongoose.Connection.prototype,"openUri",()=>assert.fail("No database connections"));
  t.mock.method(globalThis,"fetch",()=>assert.fail("No provider calls"));
  t.mock.method(OrderModel,"findById",id=>query(session=>{
    assert.equal(String(id),O);if(session) assertSession(session);
    const doc=new OrderModel(s.order);doc.save=async({session})=>{assertSession(session);await doc.validate();s.order=doc.toObject();s.orderSaves++;return doc;};return doc;
  }));
  t.mock.method(ProductModel,"findById",id=>query(session=>{if(session)assertSession(session);return clone(s.products.find(p=>String(p._id)===String(id))??null);}));
  t.mock.method(ProductModel,"updateOne",async(filter,update,{session,arrayFilters}={})=>{
    assertSession(session);s.stockWrites.push({filter,update,arrayFilters});
    const product=s.products.find(p=>p._id===String(filter._id));
    const match=filter.type==="SIMPLE"?filter.warehouseStocks.$elemMatch:filter.variants.$elemMatch.warehouseStocks.$elemMatch;
    assert.equal(String(match.warehouse),W);
    const rows=filter.type==="SIMPLE"?product.warehouseStocks:product.variants.find(v=>v._id===String(filter.variants.$elemMatch._id)).warehouseStocks;
    const row=rows.find(row=>row.warehouse===String(match.warehouse)&&row.revision===match.revision);
    if(!row||s.forceStockConflict) return {modifiedCount:0};
    const amount=Object.entries(update.$inc).find(([key])=>key.endsWith("quantity"))[1];
    row.quantity+=amount;row.revision++;return {modifiedCount:1};
  });
  t.mock.method(InventoryAuditModel,"findOne",filter=>query(session=>{assertSession(session);return s.audits.find(a=>a.operationId===filter.operationId&&a.skuKey===filter.skuKey&&a.action===filter.action)??null;}));
  t.mock.method(InventoryAuditModel,"create",async([row],{session})=>{assertSession(session);const doc=new InventoryAuditModel(row);await doc.validate();s.audits.push(doc.toObject());return[doc];});
  t.mock.method(UserModel,"findById",()=>{assert.equal(guest,false,"Guest reversals must not read a user account");return query(session=>{if(session)assertSession(session);return clone(s.user);});});
  t.mock.method(UserModel,"updateOne",async(filter,update,{session})=>{assert.equal(guest,false,"Guest reversals must not write a user account");assertSession(session);assert.equal(String(filter._id),U);for(const[key,value]of Object.entries(update.$inc))s.user[key]+=value;return{matchedCount:1};});
  t.mock.method(UserModel,"find",()=>query(()=>[]));
  t.mock.method(WarehouseModel,"findById",()=>query(()=>({moderators:[]})));
  for(const[model,target]of [[WalletTransactionModel,"ledger"],[LoyaltyTransactionModel,"loyaltyLedger"],[NotificationOutboxModel,"outbox"]])
    t.mock.method(model,"create",async(rows,{session})=>{assertSession(session);const docs=rows.map(row=>new model(row));for(const doc of docs)await doc.validate();s[target].push(...docs.map(doc=>doc.toObject()));return docs;});
  t.mock.method(LoyaltySettingsModel,"findOne",()=>query(()=>({isActive:false,pointsRedeemRate:10,pointsEarnRate:1,minPointsToRedeem:500})));
  t.mock.method(RestockSubscriptionModel,"updateMany",async()=>({modifiedCount:0}));
  t.mock.method(RestockSubscriptionModel,"find",()=>query(()=>[]));
  t.mock.method(NotificationDeviceModel,"distinct",async()=>[]);
  t.mock.method(NotificationDeviceModel,"find",()=>query(()=>[]));
  t.mock.method(InAppNotificationModel,"create",async rows=>rows);
  t.mock.method(ReturnRequestModel,"findOne",()=>query(()=>s.returnRequest));
  t.mock.method(ReturnRequestModel,"create",async row=>{const doc=new ReturnRequestModel(row);await doc.validate();s.returnRequest=doc.toObject();return doc;});
  t.mock.method(ReturnRequestModel,"findById",()=>query(session=>{
    assertSession(session);if(!s.returnRequest)return null;const doc=new ReturnRequestModel(s.returnRequest);
    doc.save=async({session})=>{assertSession(session);await doc.validate();s.returnRequest=doc.toObject();s.requestSaves++;return doc;};return doc;
  }));
  t.mock.method(SubstitutionRequestModel,"findById",()=>query(session=>{
    assertSession(session);if(!s.substitution)return null;const doc=new SubstitutionRequestModel(s.substitution);
    doc.save=async({session})=>{assertSession(session);await doc.validate();s.substitution=doc.toObject();return doc;};return doc;
  }));
  t.mock.method(OrderPaymentAttemptModel,"find",()=>query(session=>{assertSession(session);return [];}));
  s.errors=[];t.mock.method(console,"error",(...values)=>s.errors.push(values));
  s.change=(newStatus,args={})=>updateOrderStatusService({orderId:O,newStatus,actorUserId:A,actorRole:"superAdmin",warehouseScope:[W],...args});
  s.createReturn=()=>createReturnRequestService({...identity,orderId:O,reason:"Return the whole order"});
  s.processReturn=(args={})=>processReturnRequestService({returnId:s.returnRequest._id,action:"approved",adminUserId:A,...args});
  s.flush=()=>new Promise(resolve=>setImmediate(resolve));
  return s;
}

function assertRestored(s,ordinary=true){
  assert.equal(s.products[0].warehouseStocks[0].quantity,ordinary?16:14);
  assert.equal(s.products[1].variants[0].warehouseStocks[0].quantity,12);
  assert.equal(s.products[0].warehouseStocks[1].quantity,1000);
  assert.equal(s.products[1].variants[0].warehouseStocks[1].quantity,1000);
  assert.equal(s.products[1].variants[1].warehouseStocks[0].quantity,1000);
  assert.equal(s.audits.length,2);assert.equal(s.stockWrites.length,2);
  assert.ok(s.audits.every(row=>String(row.warehouse)===W));
}

function guestCardRefundFixture(t,s){
  const previous=process.env.PAYMOB_API_KEY;process.env.PAYMOB_API_KEY="fixture-only";
  t.after(()=>{if(previous===undefined)delete process.env.PAYMOB_API_KEY;else process.env.PAYMOB_API_KEY=previous;});
  s.order.paymobTransactionId="fixture-capture";s.refunds=[];
  t.mock.method(globalThis,"fetch",async(url,options)=>{
    if(url==="https://accept.paymob.com/api/auth/tokens")return{ok:true,json:async()=>({token:"fixture-token"})};
    assert.equal(url,"https://accept.paymob.com/api/acceptance/void_refund/refund");
    const body=JSON.parse(options.body);assert.equal(body.transaction_id,"fixture-capture");
    s.refunds.push(body.amount_cents);return{ok:true,json:async()=>({success:true,id:"fixture-refund"})};
  });
  t.mock.method(OrderModel,"updateOne",async(filter,update)=>{
    assert.equal(String(filter._id),O);assert.equal(update.paymobRefundTransactionId,"fixture-refund");
    s.order.paymobRefundTransactionId=update.paymobRefundTransactionId;return{modifiedCount:1};
  });
  t.mock.method(ReturnRequestModel,"updateOne",async(filter,update)=>{
    assert.equal(String(filter._id),String(s.returnRequest._id));assert.equal(update.paymobRefundTransactionId,"fixture-refund");
    s.returnRequest.paymobRefundTransactionId=update.paymobRefundTransactionId;return{modifiedCount:1};
  });
}

for(const paymentMethod of ["cod","pos_on_delivery","instapay","card"])for(const ordinary of [false,true]){
  for(const mode of ["cancelled","returned","request"])test(`guest ${mode}: existing ${paymentMethod} refund rules, ${ordinary?"mixed":"bundle-only"}`,async t=>{
    const s=await fixture(t,{guest:true,paymentMethod,ordinary,status:mode==="cancelled"?"accepted":"delivered"});
    if(paymentMethod==="card")guestCardRefundFixture(t,s);
    if(mode==="request"){
      await s.createReturn();await s.flush();assert.equal(s.returnRequest.refundMethod,paymentMethod==="card"?"card":"manual");
      await s.processReturn();
    }else await s.change(mode);
    await s.flush();assertRestored(s,ordinary);assert.deepEqual(s.ledger,[]);assert.deepEqual(s.loyaltyLedger,[]);
    assert.equal(s.user.walletBalance,100);assert.deepEqual(s.errors,[]);
    if(paymentMethod==="card")assert.deepEqual(s.refunds,[(mode==="cancelled"?s.order.total:s.order.subtotal)*100]);
    if(mode==="request")await assert.rejects(s.processReturn(),{statusCode:400});else await s.change(mode);
    await s.flush();assertRestored(s,ordinary);if(paymentMethod==="card")assert.equal(s.refunds.length,1);
    assert.deepEqual(s.errors,[]);
  });
}

for(const paymentMethod of ["cod","pos_on_delivery","instapay","card"])for(const ordinary of [false,true]){
  test(`existing cancellation: ${paymentMethod}, ${ordinary?"mixed":"bundle-only"}`,async t=>{
    const s=await fixture(t,{paymentMethod,ordinary}),before=clone(s.order.bundleGroups?{groups:s.order.bundleGroups}:{});
    await s.change("cancelled");await s.flush();assertRestored(s,ordinary);
    assert.equal(s.user.walletBalance,100+10+(paymentMethod==="card"?s.order.total:0));
    assert.equal(s.ledger.length,paymentMethod==="card"?2:1);
    assert.equal(s.order.status,"cancelled");assert.deepEqual(s.order.bundleGroups,before.groups);
    assert.equal(s.order.paymentStatus,paymentMethod==="card"?"refunded":paymentMethod==="instapay"?"paid":"pending");
    await s.change("cancelled");await s.flush();assertRestored(s,ordinary);assert.equal(s.orderSaves,1);
    assert.equal(s.ledger.length,paymentMethod==="card"?2:1);assert.deepEqual(s.errors,[]);
  });
  test(`existing direct whole-order return: ${paymentMethod}, ${ordinary?"mixed":"bundle-only"}`,async t=>{
    const s=await fixture(t,{paymentMethod,ordinary,status:"delivered"});await s.change("returned");await s.flush();assertRestored(s,ordinary);
    assert.equal(s.user.walletBalance,100+(paymentMethod==="card"?s.order.subtotal:0));
    assert.equal(s.ledger.length,paymentMethod==="card"?1:0);assert.equal(s.order.status,"returned");
    await s.change("returned");await s.flush();assertRestored(s,ordinary);assert.equal(s.orderSaves,1);assert.deepEqual(s.errors,[]);
  });
  test(`existing return request and approval: ${paymentMethod}, ${ordinary?"mixed":"bundle-only"}`,async t=>{
    const s=await fixture(t,{paymentMethod,ordinary,status:"delivered"});await s.createReturn();await s.flush();
    assert.equal(s.returnRequest.refundMethod,"wallet");assert.equal(s.returnRequest.refundAmount,s.order.subtotal);assert.equal(s.stockWrites.length,0);
    await s.processReturn();await s.flush();assertRestored(s,ordinary);assert.equal(s.user.walletBalance,100+s.order.subtotal);
    assert.equal(s.ledger.length,1);assert.equal(s.returnRequest.status,"approved");assert.equal(s.order.status,"returned");
    const balance=s.user.walletBalance;await assert.rejects(s.processReturn(),{statusCode:400});
    assertRestored(s,ordinary);assert.equal(s.user.walletBalance,balance);assert.equal(s.ledger.length,1);assert.deepEqual(s.errors,[]);
  });
}

test("unpaid card skeleton cancellation does not restore stock or credit wallet",async t=>{
  const s=await fixture(t,{status:"awaiting_payment",committed:false});s.order.paymentStatus="pending";s.order.settlement.cardCapturedPiastres=0;s.order.settlement.cardDuePiastres=9000;
  await s.change("cancelled");await s.flush();assert.equal(s.stockWrites.length,0);assert.equal(s.user.walletBalance,100);assert.deepEqual(s.ledger,[]);assert.deepEqual(s.errors,[]);
});

test("existing cancellation authorization and warehouse scope reject before financial changes",async t=>{
  const s=await fixture(t);await assert.rejects(s.change("cancelled",{actorRole:"admin"}),{statusCode:403});
  await assert.rejects(s.change("cancelled",{warehouseScope:[ELSEWHERE]}),{statusCode:404});
  assert.equal(s.stockWrites.length,0);assert.equal(s.user.walletBalance,100);assert.equal(s.orderSaves,0);
});

test("existing restoration refuses a missing exact warehouse row without borrowing another pool",async t=>{
  const s=await fixture(t);s.products[1].variants[0].warehouseStocks.shift();
  await assert.rejects(s.change("cancelled"),{code:"INVENTORY_STOCK_CONFLICT"});assert.equal(s.order.status,"accepted");assert.equal(s.user.walletBalance,100);
  assert.equal(s.audits.length,0);assert.equal(s.products[0].warehouseStocks[0].quantity,10);
});

test("existing stock CAS failure stops cancellation before refunds",async t=>{
  const s=await fixture(t);s.forceStockConflict=true;
  await assert.rejects(s.change("cancelled"),{code:"INVENTORY_STOCK_CONFLICT"});assert.equal(s.user.walletBalance,100);assert.equal(s.orderSaves,0);assert.equal(s.audits.length,0);
});

for(const mode of ["cancelled","returned","request"])test(`existing loyalty-deficit rules are preserved for ${mode}`,async t=>{
  const s=await fixture(t,{loyalty:true,status:mode==="cancelled"?"accepted":"delivered"});
  if(mode==="request"){await s.createReturn();await s.processReturn();}else await s.change(mode);
  await s.flush();assertRestored(s);assert.equal(s.user.loyaltyPoints,0);assert.equal(s.loyaltyLedger.length,1);
  assert.equal(s.user.walletBalance,100+(mode==="cancelled"?95:45));assert.deepEqual(s.errors,[]);
});

test("whole-order cancellation closes an ordinary pending substitution and preserves bundle stock and refund rules",async t=>{
  const s=await fixture(t),line=s.order.items.find(row=>row.lineId==="ordinary");line.fulfillmentQuantity=1;line.finalizedUnavailableQuantity=1;
  const request=new SubstitutionRequestModel({_id:R,order:O,orderNumber:s.order.orderNumber,warehouse:W,user:U,paymentMethod:"card",requestSequence:1,
    status:"offered",isActive:true,offerExpiresAt:new Date(Date.now()+600000),offeredBy:A,offerIdempotencyKey:"reversal-test",
    shortages:[{shortageId:"shortage",lineId:line.lineId,product:P,productType:"SIMPLE",productName_en:"Food",productName_ar:"أكل",
      quantityBefore:2,deliverableOriginalQuantity:1,unavailableQuantity:1,finalizedUnavailableStart:0,finalizedUnavailableEnd:1,originalUnitPricePiastres:1000,
      expectedUnallocatedQuantity:10,expectedStockRevision:2,correctedUnallocatedQuantity:10,alternatives:[]}]});
  await request.validate();s.substitution=request.toObject();s.order.activeSubstitutionRequest=request._id;s.order.substitutionState="awaiting_customer";s.order.requiresCustomerAction=true;
  bindPendingBundleSubstitution(s.order,request);await new OrderModel(s.order).validate();
  await s.change("cancelled");await s.flush();assert.equal(s.order.status,"cancelled");assert.equal(s.substitution.status,"cancelled");assert.equal(s.substitution.isActive,false);
  assert.equal(s.order.activeSubstitutionRequest,null);assert.equal(s.order.requiresCustomerAction,false);assert.equal(s.order.substitutionState,"none");
  assert.equal(s.products[0].warehouseStocks[0].quantity,15);assert.equal(s.products[1].variants[0].warehouseStocks[0].quantity,12);
  assert.equal(s.user.walletBalance,200);assert.equal(s.ledger.length,2);assert.equal(presentOrder(s.order).bundlePendingSubstitution,undefined);
  assert.equal(s.outbox.length,1);assert.deepEqual(s.errors,[]);
});
