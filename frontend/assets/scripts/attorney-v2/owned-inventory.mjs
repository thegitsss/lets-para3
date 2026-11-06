import {readMatterInventory} from './matter-inventory-model.mjs';
import {filtersFromQuery,id} from './read-model.mjs';
// Complete, owner-checked inventory for the selected role-owned projection.
export async function readOwnedInventory(api,ownerId,{signal,views=['active','applications']}={}) {
  const items=[],counts={};
  for(const view of views){
    let expectedTotal=null,expectedRevision=null,loaded=0;const seen=new Set();
    for(let page=1;;page++){
      signal?.throwIfAborted();
      const filters=filtersFromQuery(new URLSearchParams({view,page:String(page)}));
      const result=readMatterInventory(await api.readMatterInventory(filters,{ownerId,signal}),ownerId,filters);
      signal?.throwIfAborted();
      if(expectedRevision!==null&&expectedRevision!==result.revision)throw new Error('Matter inventory changed during review. Try again.');
      expectedRevision=result.revision;
      if(expectedTotal!==null&&expectedTotal!==result.total)throw new Error('Matter inventory changed during review. Try again.');
      expectedTotal=result.total;Object.assign(counts,result.counts);
      for(const item of result.items){if(seen.has(id(item)))throw new Error('Matter inventory changed during review. Try again.');seen.add(id(item));loaded++;items.push({...item,inventoryView:view});}
      if(page>=result.pages){if(loaded!==expectedTotal)throw new Error('Incomplete Matter inventory');break;}
      if(page>=1000)throw new Error('Matter inventory exceeds this review limit.');
    }
  }
  return {items,counts};
}
