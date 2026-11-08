import test from "node:test";
import assert from "node:assert/strict";
import { messageInput,location,radius,outlineVertices } from "../validation.mjs";
import { skyFreshness } from "../discovery.mjs";
test('live freshness uses acquisition time and confidence, never receipt time',()=>{
  const now=Date.parse('2026-11-08T00:40:00.000Z');
  const dataset={mode:'live',observed_at:new Date(now-300000),received_at:new Date(now)};
  const cloud={kind:'observed',status:'active',confidence:0.8,observedAt:new Date(now-300000).toISOString()};
  assert.equal(skyFreshness(dataset,[cloud],now),'live');
  assert.equal(skyFreshness({...dataset,observed_at:new Date(now-2400000)},[cloud],now),'stale');
  assert.equal(skyFreshness(dataset,[{...cloud,status:'uncertain'}],now),'estimated');
  assert.equal(skyFreshness(dataset,[{...cloud,confidence:0}],now),'estimated');
  assert.equal(skyFreshness(dataset,[{...cloud,observedAt:new Date(now-1200000).toISOString()}],now),'estimated');
  assert.equal(skyFreshness({...dataset,observed_at:new Date(now+60000)},[cloud],now),'estimated');
  assert.equal(skyFreshness({...dataset,mode:'replay',observed_at:new Date(now-86400000)},[cloud],now),'replay');
});

const text={kind:'text',body:'hello',anchor:{longitude:-73.7,latitude:42.7},expectedCloudVersion:1};
test('message validation rejects forged identity, wrong payload, blank text and unsafe links',()=>{
  assert.equal(messageInput(text),text);
  for(const value of [{...text,authorId:'forged'},{...text,body:' '},{...text,assetId:'wrong'},{...text,anchor:{longitude:NaN,latitude:42}},{...text,body:'x'.repeat(2001)}]) assert.throws(()=>messageInput(value));
  for(const songUrl of ['https://example.com/song','https://open.spotify.com.evil.test/a','https://user:pass@open.spotify.com/a','http://open.spotify.com/a']) assert.throws(()=>messageInput({...text,body:undefined,kind:'song',songUrl}));
  assert.doesNotThrow(()=>messageInput({kind:'song',songUrl:'https://open.spotify.com/track/123',anchor:text.anchor,expectedCloudVersion:1}));
});
test('query bounds and polygons reject malformed coordinates',()=>{
  for(const query of ['lat=91&lng=0','lat=&lng=0','lng=0','lat=NaN&lng=0']) assert.throws(()=>location(new URLSearchParams(query)));
  assert.equal(radius(new URLSearchParams()),25000);
  assert.throws(()=>radius(new URLSearchParams('radiusM=50001')));
  assert.throws(()=>outlineVertices({type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]}));
});
test('drawing point limits count points across all strokes',()=>{
  const drawing={kind:'drawing',assetId:'owned',artworkTransform:{widthM:10,heightM:10,rotationDeg:0},anchor:text.anchor,expectedCloudVersion:1,strokes:[[[0,0],[1,1]]]};
  assert.doesNotThrow(()=>messageInput(drawing));
  assert.throws(()=>messageInput({...drawing,strokes:[Array(6000).fill([0,0]),Array(6000).fill([1,1])]}));
  assert.throws(()=>messageInput({...drawing,strokes:[[[1.1,0]]]}));
});
