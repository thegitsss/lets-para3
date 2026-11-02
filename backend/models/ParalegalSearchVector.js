const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  profileHash: { type: String, required: true },
  model: { type: String, required: true },
  embedding: { type: [Number], required: true, select: false },
}, { timestamps: true });
module.exports = mongoose.model("ParalegalSearchVector", schema);
