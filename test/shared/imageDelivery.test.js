import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_DELIVERY_PRESETS, getImageDeliveryUrl, getImageObjectWithDeliveryUrl } from "../../src/shared/utils/imageDelivery.js";
const config={enabled:true,cloudName:"dxemmiorv"};
const original="https://res.cloudinary.com/dxemmiorv/image/upload/v1773192088/petyard/categories/category_cats_1773192088390.png";
const optimized="https://res.cloudinary.com/dxemmiorv/image/upload/c_limit,w_480,q_auto:good,f_webp/v1773192088/petyard/categories/category_cats_1773192088390.png";
const preset=IMAGE_DELIVERY_PRESETS.CATEGORY_TILE;
test("disabled leaves URL unchanged",()=>assert.equal(getImageDeliveryUrl(original,preset,{enabled:false,cloudName:"dxemmiorv"}),original));
test("eligible URLs transform once and preserve URL parts",()=>{
 assert.equal(getImageDeliveryUrl(original,preset,config),optimized);
 assert.equal(getImageDeliveryUrl(original.replace("/upload/v","/upload//v"),preset,config),optimized);
 assert.equal(getImageDeliveryUrl(original+"?a=1#x",preset,config),optimized+"?a=1#x");
 assert.equal(getImageDeliveryUrl(optimized,preset,config),optimized);
});
test("ineligible URLs fail closed",()=>{
 const values=["https://res.cloudinary.com/dxemmiorv/image/upload/c_fill,w_100/v1/a.png","https://res.cloudinary.com/dx5n4ekk2/image/upload/v1/a.png","https://petyard.b-cdn.net/a.png","https://res.cloudinary.com/dxemmiorv/video/upload/v1/a.mp4","https://res.cloudinary.com/dxemmiorv/raw/upload/v1/a.pdf","https://res.cloudinary.com/dxemmiorv/image/upload/a.png","not a URL","",null,undefined,42,{}];
 for(const value of values)assert.equal(getImageDeliveryUrl(value,preset,config),value);
 assert.equal(getImageDeliveryUrl(original,"unknown",config),original);
});
test("object helper preserves shape and does not mutate",()=>{
 const image={public_id:"petyard/categories/category_cats_1773192088390",url:original,extra:"fixture"};
 assert.deepEqual(getImageObjectWithDeliveryUrl(image,preset,config),{...image,url:optimized});
 assert.equal(image.url,original);
 const empty={};const noUrl={public_id:"x"};
 assert.equal(getImageObjectWithDeliveryUrl(null,preset,config),null);
 assert.equal(getImageObjectWithDeliveryUrl(undefined,preset,config),undefined);
 assert.equal(getImageObjectWithDeliveryUrl(empty,preset,config),empty);
 assert.equal(getImageObjectWithDeliveryUrl(noUrl,preset,config),noUrl);
});
test("object helper uses toObject",()=>{
 const image={public_id:"x",url:original,toObject(){return {public_id:this.public_id,url:this.url,extra:"serialized"};}};
 assert.deepEqual(getImageObjectWithDeliveryUrl(image,preset,config),{public_id:"x",url:optimized,extra:"serialized"});
 assert.equal(image.url,original);
});