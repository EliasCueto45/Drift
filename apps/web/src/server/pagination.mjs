import { randomUUID } from 'node:crypto';
import { collection } from './database.mjs';
import { fail,requireThat } from './validation.mjs';

// One document per ranked ID / worker item avoids MongoDB's 16 MiB snapshot
// document limit. Cursor metadata and items expire together; reads check expiry.
export async function snapshotPage(db,binding,cursor,make,size=50){
  const snapshots=collection(db,'query_snapshots'),items=collection(db,'snapshot_items');
  let id,offset=0,meta,count;
  if(cursor){
    const parts=cursor.split('.');
    requireThat(parts.length===2&&/^[0-9]+$/.test(parts[1]),'Invalid cursor');
    [id]=parts;offset=Number(parts[1]);requireThat(Number.isSafeInteger(offset)&&offset>=0,'Invalid cursor');
    const row=await snapshots.findOne({_id:id,binding,expires_at:{$gt:db.now??new Date()}});
    if(!row)fail(409,'CURSOR_EXPIRED','Refresh this query');
    ({meta,count}=row);
  }else{
    const payload=await make();id=randomUUID();meta=payload.meta??null;count=payload.items.length;
    const expires_at=new Date((db.now??new Date()).getTime()+300000);
    await snapshots.insertOne({_id:id,binding,meta,count,expires_at});
    for(let start=0;start<count;start+=100){
      await items.insertMany(payload.items.slice(start,start+100).map((value,index)=>({_id:JSON.stringify([id,start+index]),snapshot_id:id,ordinal:start+index,value,expires_at})));
    }
  }
  requireThat(offset<=count,'Invalid cursor offset');
  const end=Math.min(offset+size,count);
  const rows=await items.find({snapshot_id:id,ordinal:{$gte:offset,$lt:end}}).sort({ordinal:1}).toArray();
  requireThat(rows.length===end-offset,'Refresh this query','CURSOR_EXPIRED',409);
  return {items:rows.map(r=>r.value),meta,nextCursor:end<count?`${id}.${end}`:null};
}
