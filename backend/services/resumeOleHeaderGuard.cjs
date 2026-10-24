'use strict';
// MS-CFB 2.2: validate allocation-driving header declarations against the
// actual bounded Buffer before word-extractor can allocate sector tables.
const SIGNATURE=Buffer.from('d0cf11e0a1b11ae1','hex');
function assertBoundedOleHeader(buffer){
 const invalid=()=>{throw new Error('Invalid compound document');};
 if(!Buffer.isBuffer(buffer)||buffer.length<512||buffer.length>10*1024*1024||!buffer.subarray(0,8).equals(SIGNATURE))invalid();
 const major=buffer.readUInt16LE(26),shift=buffer.readUInt16LE(30);
 if(![3,4].includes(major)||buffer.readUInt16LE(28)!==0xfffe||shift!==(major===3?9:12)||buffer.readUInt16LE(32)!==6)invalid();
 const sectorSize=2**shift;
 if(buffer.length<sectorSize*2||buffer.length%sectorSize!==0||buffer.readUInt32LE(56)!==4096)invalid();
 const physicalSectors=buffer.length/sectorSize-1;
 const directorySectors=buffer.readUInt32LE(40),fatSectors=buffer.readUInt32LE(44),miniFatSectors=buffer.readUInt32LE(64),difatSectors=buffer.readUInt32LE(72);
 if((major===3&&directorySectors!==0)||directorySectors>physicalSectors||fatSectors===0||fatSectors>physicalSectors||miniFatSectors>physicalSectors||difatSectors>physicalSectors)invalid();
 const location=(offset,count)=>{const value=buffer.readUInt32LE(offset);if(count===0?value!==0xfffffffe:value>=physicalSectors)invalid();};
 if(buffer.readUInt32LE(48)>=physicalSectors)invalid();
 location(60,miniFatSectors);location(68,difatSectors);
 // v4's larger header sector has only 512 bytes of header data.
 if(major===4&&buffer.subarray(512,sectorSize).some(value=>value!==0))invalid();
 return {major,sectorSize,miniSectorSize:64,physicalSectors,fatSectors,miniFatSectors,difatSectors};
}
module.exports={assertBoundedOleHeader};
