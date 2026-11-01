import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { mergeGuestCartService, getCartService, updateCartItemQuantityService, updateCartBundleService, removeCartItemService,
  previewCartAdditionService } from "../../../src/domains/cart/cart.service.js";
import { getCheckoutSummaryService } from "../../../src/domains/checkout/checkout.service.js";
import { buildOrderItemsWithPromotions } from "../../../src/domains/order/order.service.js";
import { combineGuestCartContents } from "../../../src/domains/cart/cart.guest-merge.js";

const U="111111111111111111111111", W="222222222222222222222222", P="333333333333333333333333";
const B="444444444444444444444444", OTHER="777777777777777777777777", GUEST="guest-merge-fixture";
const clone=value=>mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
const oid=value=>new mongoose.Types.ObjectId(value);
function setup(t,{account=true,bundles=true,stock=100}={}){
 const s={active:false,user:{_id:oid(U),role:"user",active:true,phoneVerified:true,deletedAt:null,account_status:"confirmed",__v:1},
  warehouse:{_id:oid(W),active:true,defaultShippingPrice:50},
  products:[{_id:oid(P),isActive:true,type:"SIMPLE",name_en:"Food",name_ar:"أكل",price:10,images:[],warehouseStocks:[{warehouse:oid(W),quantity:stock},{warehouse:oid(OTHER),quantity:10000}]}],
  definitions:[{_id:oid(B),origin:"manual",status:"published",revision:2,name_en:"Pair",name_ar:"باكدج",pricePiastres:1500,components:[{productId:oid(P),productType:"SIMPLE",quantity:2}]}],writes:0,saveCalls:0,deleteConflict:false};
 const make=(owner,quantity,groupQuantity)=>new CartModel({...owner,warehouse:W,items:quantity?[{product:P,productType:"SIMPLE",quantity,itemPrice:9}]:[],
  bundles:bundles?[{id:String(new mongoose.Types.ObjectId()),bundleId:B,bundleRevision:2,quantity:groupQuantity,unitPricePiastres:1500}]:undefined,
  totalCartPrice:quantity*9+(bundles?groupQuantity*15:0),checkoutKey:owner.user?"account-key":"guest-key",__v:3}).toObject();
 s.carts=[make({user:null,guestId:GUEST},3,2),...(account?[make({user:U},2,1)]:[])];
 s.guestId=String(s.carts[0]._id);s.accountId=account?String(s.carts[1]._id):null;
 const matches=(row,filter)=>Object.entries(filter).every(([key,value])=>key==="$expr"?mongoose.mongo.BSON.serialize(row).equals(mongoose.mongo.BSON.serialize(value.$eq[1].$literal)):
  value===null?row[key]==null:String(row[key])===String(value));
 const query=read=>{let lean=false;return {select(){return this;},maxTimeMS(){return this;},session(value){assert.equal(value,s.session);return this;},lean(){lean=true;return this;},
  then(resolve,reject){return Promise.resolve().then(()=>{const value=read();return value&&value.__cart?(lean?clone(value.row):CartModel.hydrate(clone(value.row))):value;}).then(resolve,reject);}};};
 s.session={inTransaction:()=>s.active,async endSession(){},async withTransaction(work){
  const before=clone({carts:s.carts,user:s.user});s.active=true;
  try{return await work();}catch(error){s.carts=before.carts;s.user=before.user;throw error;}finally{s.active=false;}
 }};
 const old=process.env.ASSISTANT_BUNDLE_CART_ENABLED;process.env.ASSISTANT_BUNDLE_CART_ENABLED="true";
 t.after(()=>{if(old===undefined)delete process.env.ASSISTANT_BUNDLE_CART_ENABLED;else process.env.ASSISTANT_BUNDLE_CART_ENABLED=old;});
 t.mock.method(mongoose,"startSession",async()=>s.session);
 t.mock.method(mongoose.Connection.prototype,"openUri",()=>assert.fail("No DB connections"));
 t.mock.method(globalThis,"fetch",()=>assert.fail("No provider calls"));
 t.mock.method(CartModel,"findOne",filter=>query(()=>{const row=s.carts.find(c=>matches(c,filter));return row?{__cart:true,row}:null;}));
 t.mock.method(UserModel,"findById",()=>query(()=>clone(s.user)));
 t.mock.method(UserModel.collection,"updateOne",async(filter,_update,{session})=>{assert.equal(session,s.session);assert.equal(s.active,true);assert.equal(String(filter._id),U);s.onFence?.();s.user.__v++;return {matchedCount:1,modifiedCount:1};});
 t.mock.method(CartModel.collection,"indexes",async()=>[{key:{user:1},unique:true,partialFilterExpression:{user:{$type:"objectId"}}}]);
 t.mock.method(CartModel.collection,"updateOne",async(filter,update,{session})=>{
  assert.equal(session,s.session);assert.equal(s.active,true);const row=s.carts.find(c=>matches(c,filter));if(!row)return {matchedCount:0,modifiedCount:0};
  Object.assign(row,clone(update.$set));for(const key of Object.keys(update.$unset??{}))delete row[key];row.__v=(row.__v??0)+update.$inc.__v;s.writes++;return {matchedCount:1,modifiedCount:1};
 });
 t.mock.method(CartModel.collection,"deleteOne",async(filter,{session})=>{
  assert.equal(session,s.session);assert.equal(s.active,true);const index=s.carts.findIndex(c=>matches(c,filter));if(index<0||s.deleteConflict)return {deletedCount:0};s.carts.splice(index,1);return {deletedCount:1};
 });
 t.mock.method(CartModel.prototype,"save",async function(){s.saveCalls++;const index=s.carts.findIndex(c=>String(c._id)===String(this._id));assert.ok(index>=0);s.carts[index]=this.toObject();return this;});
 t.mock.method(ProductModel,"find",()=>query(()=>clone({rows:s.products}).rows));
 t.mock.method(ProductModel,"findById",id=>query(()=>s.products.find(row=>String(row._id)===String(id))));
 t.mock.method(WarehouseModel,"findById",()=>query(()=>clone(s.warehouse)));
 t.mock.method(ManualBundle,"find",()=>query(()=>clone({rows:s.definitions}).rows));
 t.mock.method(CollectionModel,"findOne",()=>query(()=>null));
 t.mock.method(CollectionModel,"updateMany",async()=>({modifiedCount:0}));
 s.merge=()=>mergeGuestCartService({userId:U,guestId:GUEST,warehouseId:W});
 return s;
}

test("mixed carts combine product and bundle quantities once; user checkout/order reuse the merged cart",async t=>{
 const s=setup(t),result=await s.merge();
 assert.equal(String(result.id),s.accountId);assert.equal(String(result.userId),U);assert.equal(result.items[0].quantity,5);assert.equal(result.bundles[0].quantity,3);
 assert.equal(result.totalCartPrice,95);assert.equal(result.checkoutSupported,true);assert.equal(s.carts.length,1);assert.equal(s.carts[0].checkoutKey,"account-key");assert.equal(s.saveCalls,0);
 const snapshot=clone({rows:s.carts});assert.equal((await s.merge()).bundles[0].quantity,3);assert.deepEqual(clone({rows:s.carts}),snapshot);
 const built=await s.session.withTransaction(()=>buildOrderItemsWithPromotions({session:s.session,cart:CartModel.hydrate(s.carts[0])}));
 assert.equal(built.bundleGroups[0].quantity,3);assert.equal(built.subtotal,95);
});

test("guest bundle-only cart is adopted with its ID and address pointer intact",async t=>{
 const s=setup(t,{account:false});s.carts[0].items=[];s.carts[0].deliveryAddress={guestAddressId:oid(OTHER),name:"Guest",location:{lat:31,lng:29}};
 const result=await s.merge();assert.equal(String(result.id),s.guestId);assert.equal(result.bundles[0].quantity,2);assert.equal(s.carts.length,1);
 assert.equal(String(s.carts[0].deliveryAddress.guestAddressId),OTHER);assert.equal(s.carts[0].deliveryAddress.userAddressId,undefined);
 assert.equal(s.carts[0].checkoutKey,"guest-key");
});

test("ordinary overstock quantities survive merge and subsequent cart reads; checkout is blocked",async t=>{
 const s=setup(t,{bundles:false,stock:4}),merged=await s.merge();
 assert.equal(merged.items[0].quantity,5);assert.equal(merged.checkoutSupported,false);assert.equal(merged.stockIssues[0].requestedQuantity,5);assert.equal(merged.stockIssues[0].availableQuantity,4);
 const refreshed=await getCartService({userId:U,warehouseId:W});assert.equal(refreshed.items[0].quantity,5);assert.equal(s.carts[0].items[0].quantity,5);
 await assert.rejects(getCheckoutSummaryService({userId:U,warehouseId:W}),error=>error.statusCode===409&&error.errors[0].code==="CART_STOCK_REVIEW_REQUIRED");
 await assert.rejects(s.session.withTransaction(()=>buildOrderItemsWithPromotions({session:s.session,cart:CartModel.hydrate(s.carts[0])})),error=>error.statusCode===409);
});

test("combined component stock uses only selected warehouse; unavailable bundles remain visible",async t=>{
 const s=setup(t,{stock:6}),result=await s.merge();assert.equal(result.items[0].quantity,5);assert.equal(result.bundles[0].quantity,3);
 assert.equal(result.checkoutSupported,false);assert.equal(result.pricingStatus,"unavailable");assert.ok(result.reason);assert.equal(s.carts[0].bundles[0].quantity,3);
 await assert.rejects(getCheckoutSummaryService({userId:U,warehouseId:W}),error=>error.statusCode===409);
});

test("failed guest-source consumption rolls back the target merge; retry never duplicates additions",async t=>{
 const s=setup(t),before=clone({carts:s.carts});s.deleteConflict=true;await assert.rejects(s.merge(),error=>error.statusCode===409);assert.deepEqual({carts:s.carts},before);
 s.deleteConflict=false;assert.equal((await s.merge()).bundles[0].quantity,3);assert.equal((await s.merge()).bundles[0].quantity,3);
});

test("unrelated owner carts are untouched",async t=>{
 const s=setup(t),other=clone(s.carts[0]);other._id=new mongoose.Types.ObjectId();other.guestId="another-guest";s.carts.push(other);
 await s.merge();assert.deepEqual(s.carts.find(c=>c.guestId==="another-guest"),other);
});

for(const staleSide of [0,1])test(`a stale ${staleSide===0?"guest":"account"} bundle snapshot remains a review requirement after merge`,async t=>{
 const s=setup(t);s.carts[staleSide].bundles[0].bundleRevision=1;s.carts[staleSide].bundles[0].unitPricePiastres=1200;
 const result=await s.merge();assert.equal(result.bundles[0].quantity,3);assert.equal(result.checkoutSupported,false);assert.equal(result.pricingStatus,"unavailable");
 assert.equal(s.carts[0].bundles[0].bundleRevision,1);
});

test("customers can decrease/remove several unavailable lines one by one without losing other lines",async t=>{
 const s=setup(t,{stock:4});let result=await s.merge();const itemId=String(result.items[0].id),groupId=result.bundles[0].id;
 await assert.rejects(updateCartItemQuantityService({userId:U,warehouseId:W,itemId,quantity:6}),error=>error.statusCode===409);
 result=await updateCartBundleService({userId:U,warehouseId:W,groupId,quantity:2});assert.equal(result.bundles[0].quantity,2);assert.equal(result.items[0].quantity,5);assert.equal(result.checkoutSupported,false);
 result=await updateCartItemQuantityService({userId:U,warehouseId:W,itemId,quantity:2});assert.equal(result.items[0].quantity,2);assert.equal(result.checkoutSupported,false);
 result=await removeCartItemService({userId:U,warehouseId:W,itemId});assert.equal(result.items.length,0);assert.equal(result.bundles[0].quantity,2);assert.equal(result.checkoutSupported,true);assert.equal(result.totalCartPrice,30);
});

test("a concurrent completed merge still returns ordinary stock warnings",async t=>{
 const s=setup(t,{bundles:false,stock:4});s.onFence=()=>{s.carts=s.carts.filter(c=>c.user);s.carts[0].items[0].quantity=5;};
 const result=await s.merge();assert.equal(result.items[0].quantity,5);assert.equal(result.stockIssues[0].availableQuantity,4);assert.equal(result.checkoutSupported,false);
});

test("assistant cart previews cannot silently omit an unavailable existing line",async t=>{
 const s=setup(t,{bundles:false,stock:4});await s.merge();const before=clone({rows:s.carts});
 await assert.rejects(previewCartAdditionService({userId:U,warehouseId:W,productId:P,productType:"SIMPLE",quantity:1}),error=>error.statusCode===409);
 assert.deepEqual({rows:s.carts},before);
});

test("coalescing preserves different variants and avoids line/group ID collisions",()=>{
 const product=oid(P),line=oid(OTHER),variant=oid(W),variant2=oid(U);
 const one={items:[{_id:line,product,productType:"VARIANT",variantId:variant,quantity:2,itemPrice:10}],bundles:[{id:OTHER,bundleId:B,bundleRevision:2,quantity:1,unitPricePiastres:1500}]};
 const two={items:[{_id:line,product,productType:"VARIANT",variantId:variant2,quantity:3,itemPrice:20}],bundles:[{id:OTHER,bundleId:P,bundleRevision:1,quantity:2,unitPricePiastres:500}]};
 const merged=combineGuestCartContents(one,two);assert.equal(merged.items.length,2);assert.notEqual(String(merged.items[0]._id),String(merged.items[1]._id));assert.equal(merged.bundles.length,2);assert.notEqual(merged.bundles[0].id,merged.bundles[1].id);
 assert.equal(two.bundles[0].id,OTHER);
});
