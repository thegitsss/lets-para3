const sharp=require('sharp');
const {renderStoredPhotoCrop}=require('../services/profilePhotoRender');
test('crop uses the requested region of stored bytes and strips metadata',async()=>{
 const data=Buffer.alloc(100*50*3);for(let y=0;y<50;y++)for(let x=0;x<100;x++) {const at=(y*100+x)*3;data[at]=x<50?255:0;data[at+2]=x>=50?255:0;}
 const source=await sharp(data,{raw:{width:100,height:50,channels:3}}).png().toBuffer();
 const output=await renderStoredPhotoCrop(source,{v:1,x:.5,y:0,width:.5,height:1});
 const {data:pixels,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});const center=(300*600+300)*info.channels;expect(pixels[center]).toBeLessThan(5);expect(pixels[center+2]).toBeGreaterThan(250);expect(info.width).toBe(600);expect((await sharp(output).metadata()).exif).toBeUndefined();
});
test('EXIF orientation is applied before crop coordinates',async()=>{
 const source=await sharp({create:{width:100,height:50,channels:3,background:'#4d70a8'}}).jpeg().withMetadata({orientation:6}).toBuffer();
 expect((await sharp(await renderStoredPhotoCrop(source,{v:1,x:0,y:.5,width:1,height:.5})).metadata()).width).toBe(600);
});
test('non-square source framing cannot distort the stored image',async()=>{
 const source=await sharp({create:{width:100,height:50,channels:3,background:'#4d70a8'}}).png().toBuffer();await expect(renderStoredPhotoCrop(source,{v:1,x:0,y:0,width:1,height:1})).rejects.toThrow('Non-square');
});
