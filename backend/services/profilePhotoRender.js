const sharp = require("sharp");
// Normalize orientation before applying the browser's normalized source coordinates.
async function renderStoredPhotoCrop(bytes,crop) {
  const oriented=await sharp(bytes,{limitInputPixels:64000000,animated:false}).rotate().toBuffer({resolveWithObject:true});
  const {width,height}=oriented.info;
  if(Math.abs(crop.width*width-crop.height*height)>Math.max(2,Math.min(width,height)*.002)) throw new Error("Non-square crop");
  const left=Math.max(0,Math.min(width-1,Math.round(crop.x*width))),top=Math.max(0,Math.min(height-1,Math.round(crop.y*height)));
  const size=Math.max(1,Math.min(width-left,height-top,Math.round(crop.width*width)));
  return sharp(oriented.data,{limitInputPixels:64000000}).extract({left,top,width:size,height:size}).resize(600,600).flatten({background:'#ffffff'}).jpeg({quality:92}).toBuffer();
}
module.exports={renderStoredPhotoCrop};
