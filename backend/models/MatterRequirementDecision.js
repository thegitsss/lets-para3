const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  matterKey:{type:String,required:true},
  paralegalId:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
  requirements:{type:[String],required:true},
  confirmedAt:{type:Date,default:Date.now},
});
schema.index({matterKey:1,paralegalId:1},{unique:true});
module.exports=mongoose.model('MatterRequirementDecision',schema);
