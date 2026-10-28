import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { readAssistantCatalog } from "../../../src/domains/assistant/products/assistant.catalog-read.js";
import { buildCatalogSnapshot, catalogSnapshot, storedCatalogDto } from "../../../src/domains/assistant/products/assistant.product-cards.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { BrandModel } from "../../../src/domains/brand/brand.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const W="111111111111111111111111", OTHER="222222222222222222222222", P="333333333333333333333333", B="444444444444444444444444";
const V="555555555555555555555555", N="666666666666666666666666", F="777777777777777777777777";
const query=read=>({populate(){return this;},select(){return this;},lean(){return this;},limit(){return this;},sort(){return this;},maxTimeMS(){return this;},then(resolve,reject){return Promise.resolve().then(read).then(resolve,reject);}});
function fixture(t){
 const s={products:[{_id:P,type:"SIMPLE",isActive:true,name_en:"Brush",name_ar:"فرشة",price:10,images:[],category:N,warehouseStocks:[{warehouse:W,quantity:4},{warehouse:OTHER,quantity:1000}]}],
  bundles:[{_id:B,origin:"manual",status:"published",revision:2,name_en:"Care kit",name_ar:"باكدج عناية",pricePiastres:1500,components:[{productId:P,productType:"SIMPLE",quantity:2}]}],reads:[],bundleReads:0};
 s.config={...testConfig({catalogClassification:{version:"test",foodCategoryIds:[F],nonFoodCategoryIds:[N],foodSubcategoryIds:[],nonFoodSubcategoryIds:[]}}),bundleCartEnabled:true};
 s.warehouses=[{_id:W,active:true},{_id:OTHER,active:true}];
 const db=ManualBundle.db.db;ManualBundle.db.db={listCollections:()=>({toArray:async()=>[{type:"collection",options:{}}]})};t.after(()=>{ManualBundle.db.db=db;});
 t.mock.method(ManualBundle.collection,"indexes",async()=>[{name:"_id_",key:{_id:1}},{name:"manual_bundle_catalog_v1",key:{origin:1,status:1,_id:-1}}]);
 t.mock.method(WarehouseModel,"findById",async id=>s.warehouses.find(row=>String(row._id)===String(id))??null);
 t.mock.method(BrandModel,"find",()=>query(()=>[]));t.mock.method(CollectionModel,"find",()=>query(()=>[]));
 t.mock.method(ManualBundle,"find",filter=>query(()=>{s.bundleReads++;assert.deepEqual(filter.origin,{$in:["manual","ai"]});assert.equal(filter.status,"published");
  return s.bundles.filter(row=>filter.origin.$in.includes(row.origin)&&row.status==="published"&&filter.$or.some(branch=>branch.$and.every(term=>Object.entries(term).every(([key,value])=>new RegExp(value.$regex,"i").test(row[key]??"")))));
 }));
 t.mock.method(ProductModel,"find",filter=>query(()=>{s.reads.push(filter);if(filter.$and)return[];
  assert.equal(filter.isActive,true);assert.deepEqual(filter.$or[0].warehouseStocks.$elemMatch.quantity,{$gt:0});
  assert.equal(String(filter.$or[0].warehouseStocks.$elemMatch.warehouse),s.selected??W);
  return s.products.filter(row=>filter._id.$in.some(id=>String(id)===String(row._id)));
 }));
 for(const model of [ManualBundle,ProductModel])for(const method of ["create","updateOne","deleteOne"])t.mock.method(model,method,()=>assert.fail("Search must not write"));
 t.mock.method(mongoose,"connect",()=>assert.fail("No database connections"));t.mock.method(globalThis,"fetch",()=>assert.fail("No provider calls"));
 s.read=(changes={})=>readAssistantCatalog({query:"care kit",warehouseId:s.selected??W,language:"en",subject:null,warnings:[],...changes},s.config);
 s.snapshot=outcome=>buildCatalogSnapshot(outcome,{constrained:false},{warehouseId:s.selected??W},null,"en");return s;
}

test("search publishes the existing product-shaped bundle card without private prices or stock rows",async t=>{
 const s=fixture(t),outcome=await s.read();assert.equal(outcome.status,"results");assert.equal(outcome.products.length,1);
 const snapshot=s.snapshot(outcome),card=snapshot.products[0];assert.equal(card.type,"BUNDLE");assert.equal(card.id,B);assert.equal(card.slug,null);
 assert.equal(card.price,20);assert.equal(card.discountedPrice,15);assert.equal(card.revision,2);assert.equal(card.warehouseId,W);assert.equal(card.components[0].quantity,2);
 for(const key of ["stock","sellingPricePiastres","originalPricePiastres","warehouseStocks"])assert.equal(card[key],undefined);
 assert.deepEqual(storedCatalogDto(JSON.stringify(snapshot)),snapshot);
});

test("an approved AI-origin bundle uses the same customer card while evidence stays private",async t=>{
 const s=fixture(t);Object.assign(s.bundles[0],{origin:"ai",aiEvidenceJson:JSON.stringify({version:"petyard-bundle-selection-v1",runId:B,
  signature:"a".repeat(64),facts:{products:[{productId:P},{productId:V}]},modelExplanation:{fit_ar:"منتجات بتكمل بعض",benefit_ar:"سهولة الشراء"}})});
 const result=await s.read();assert.equal(result.products[0].type,"BUNDLE");assert.equal(result.products[0].id,B);
 const card=s.snapshot(result).products[0];for(const key of["origin","aiEvidenceJson","aiEvidence","modelExplanation","source"])assert.equal(card[key],undefined);
 s.bundles[0].status="draft";assert.equal((await s.read()).products.length,0);
});

test("a missing component or selected-warehouse shortage never borrows another warehouse",async t=>{
 const s=fixture(t);s.products[0].warehouseStocks[0].quantity=1;assert.equal((await s.read()).products.length,0);
 s.products=[];assert.equal((await s.read()).products.length,0);
});

test("each of the four warehouse stock pools is evaluated separately",async t=>{
 const s=fixture(t),warehouses=[W,OTHER,V,N];s.warehouses=warehouses.map(_id=>({_id,active:true}));
 s.products[0].warehouseStocks=warehouses.map((warehouse,index)=>({warehouse,quantity:index===1||index===3?2:1}));
 for(const[index,warehouse]of warehouses.entries()){s.selected=warehouse;const result=await s.read();assert.equal(result.products.length,[1,3].includes(index)?1:0);}
});

test("paused definitions and inactive components cannot become assistant suggestions",async t=>{
 const s=fixture(t);s.bundles[0].status="paused";assert.equal((await s.read()).products.length,0);
 s.bundles[0].status="published";s.products[0].isActive=false;assert.equal((await s.read()).products.length,0);
});

test("dietary caution checks every component including unclassified components",async t=>{
 const s=fixture(t),subject={id:`pet:${OTHER}`,saved:true,profile:{chronicConditions:["allergy"],temporaryIssues:[]}};
 s.products[0].category=F;assert.equal((await s.read({subject})).products.length,0);
 delete s.products[0].category;assert.equal((await s.read({subject})).products.length,0);
 s.products[0].category=N;assert.equal((await s.read({subject})).products.length,1);
});

test("bundle suggestions remain off by default and never satisfy unverified attribute filters",async t=>{
 const s=fixture(t);s.config.bundleCartEnabled=false;await s.read();assert.equal(s.bundleReads,0);
 s.config.bundleCartEnabled=true;await s.read({filters:{minimumPackageWeightGrams:2000,maximumPriceMinor:null,options:[]}});assert.equal(s.bundleReads,0);
});

test("exact bundle variants cannot use stock from a different variant",async t=>{
 const s=fixture(t);Object.assign(s.products[0],{type:"VARIANT",variants:[{_id:V,price:10,options:[],images:[],warehouseStocks:[{warehouse:W,quantity:1}]},{_id:OTHER,price:10,warehouseStocks:[{warehouse:W,quantity:1000}]}]});
 s.bundles[0].components=[{productId:P,productType:"VARIANT",variantId:V,quantity:2}];assert.equal((await s.read()).products.length,0);
 s.products[0].variants[0].warehouseStocks[0].quantity=2;assert.equal(s.snapshot(await s.read()).products[0].components[0].variantId,V);
});

test("saved bundle card parsing rejects wrong warehouse, bad revision and malformed composition",async t=>{
 const s=fixture(t),snapshot=s.snapshot(await s.read());
 for(const change of [card=>card.warehouseId=OTHER,card=>card.revision=0,card=>card.components[0].quantity=0,card=>card.hasVariants=true]){
  const altered=structuredClone(snapshot);change(altered.products[0]);assert.throws(()=>catalogSnapshot(altered),{code:"invalid_catalog_snapshot"});
 }
});
