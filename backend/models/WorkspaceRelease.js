const mongoose = require('mongoose');
const { Schema } = mongoose;
const cohortSchema = new Schema({
  basisPoints: { type: Number, min: 0, max: 10000, default: 0 },
  overrides: { type: Map, of: { type: String, enum: ['legacy', 'v2'] }, default: () => ({}) },
}, { _id: false });
const workspaceReleaseSchema = new Schema({
  _id: { type: String, default: 'workspaces', enum: ['workspaces'] },
  revision: { type: Number, required: true, min: 1 },
  enabled: { type: Boolean, required: true },
  killSwitch: { type: Boolean, required: true },
  attorney: { type: cohortSchema, required: true },
  paralegal: { type: cohortSchema, required: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true, versionKey: false, minimize: false });
module.exports = mongoose.model('WorkspaceRelease', workspaceReleaseSchema);
