// Source coordinates are normalized to the upright original, independent of
// preview resolution, viewport dimensions and the 600px uploaded rendition.
export function cropFrame({naturalWidth,naturalHeight,size,zoom=1,x=0,y=0}) {
  const scale=size/Math.min(naturalWidth,naturalHeight)*zoom;
  const width=naturalWidth*scale,height=naturalHeight*scale;
  return {size,scale,width,height,x:Math.max((size-width)/2,Math.min((width-size)/2,x)),y:Math.max((size-height)/2,Math.min((height-size)/2,y))};
}
export function cropDescriptor(frame,naturalWidth,naturalHeight) {
  const side=frame.size/frame.scale;
  return {v:1,x:Math.max(0,(naturalWidth-side)/2-frame.x/frame.scale)/naturalWidth,y:Math.max(0,(naturalHeight-side)/2-frame.y/frame.scale)/naturalHeight,width:side/naturalWidth,height:side/naturalHeight};
}
export function restoreCrop(value,naturalWidth,naturalHeight,size) {
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return null;}}
  if(!value || value.v!==1 || ![value.x,value.y,value.width,value.height].every(Number.isFinite) || value.x<0 || value.y<0 || value.width<=0 || value.height<=0 || value.x+value.width>1.00000001 || value.y+value.height>1.00000001)return null;
  const side=value.width*naturalWidth;
  if(Math.abs(side-value.height*naturalHeight)>Math.max(1,side*.002))return null;
  const zoom=Math.min(naturalWidth,naturalHeight)/side;
  if(zoom<.99999 || zoom>2.50001)return null;
  const scale=size/side;
  return {zoom:Math.min(2.5,Math.max(1,zoom)),...cropFrame({naturalWidth,naturalHeight,size,zoom:Math.min(2.5,Math.max(1,zoom)),x:(naturalWidth/2-value.x*naturalWidth-side/2)*scale,y:(naturalHeight/2-value.y*naturalHeight-side/2)*scale})};
}
export async function imageDimensions(file) {
  const bytes=new DataView(await file.arrayBuffer());
  if(bytes.byteLength>=24 && bytes.getUint32(0)===0x89504e47 && bytes.getUint32(4)===0x0d0a1a0a)return {width:bytes.getUint32(16),height:bytes.getUint32(20)};
  if(bytes.byteLength>4 && bytes.getUint16(0)===0xffd8){
    let at=2;
    while(at+4<=bytes.byteLength){
      if(bytes.getUint8(at++)!==0xff)break;
      while(at<bytes.byteLength && bytes.getUint8(at)===0xff)at++;
      if(at>=bytes.byteLength)break;
      const marker=bytes.getUint8(at++);
      if(marker===0xda || marker===0xd9)break;
      if(marker===1 || marker>=0xd0&&marker<=0xd7)continue;
      if(at+2>bytes.byteLength)break;
      const length=bytes.getUint16(at);
      if(length<2 || at+length>bytes.byteLength)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length>=7)return {width:bytes.getUint16(at+5),height:bytes.getUint16(at+3)};
      at+=length;
    }
  }
  return null;
}
