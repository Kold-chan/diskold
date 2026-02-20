const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 20 },
  password:     { type: String, required: true },
  avatar:       { type: String, default: null },
  status:       { type: String, enum: ['online','away','dnd','offline'], default: 'offline' },
  customStatus: { type: String, default: '' },
  servers:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'Server' }],
  friends:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [{
    from:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: String,
    avatar:   { type: String, default: null },
    sentAt:   { type: Date, default: Date.now },
  }],
  sentRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt:    { type: Date, default: Date.now },
  lastSeen:     { type: Date, default: Date.now },
});
UserSchema.index({ username: 1 });

const ServerSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 50 },
  icon:        { type: String, default: null },
  description: { type: String, default: '', maxlength: 200 },
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{
    user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role:     { type: String, enum: ['owner','admin','member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  }],
  channels:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Channel' }],
  invites: [{
    code:      String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: Date,
    uses:      { type: Number, default: 0 },
    maxUses:   { type: Number, default: 0 },
  }],
  createdAt: { type: Date, default: Date.now },
});

const ChannelSchema = new mongoose.Schema({
  server:    { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
  name:      { type: String, required: true, trim: true, maxlength: 30 },
  type:      { type: String, enum: ['text','voice'], default: 'text' },
  position:  { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

const AttachmentSchema = {
  fileId:   String,
  filename: String,
  mimetype: String,
  size:     Number,
};

const MessageSchema = new mongoose.Schema({
  channel:      { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },
  server:       { type: mongoose.Schema.Types.ObjectId, ref: 'Server' },
  author:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName:   String,
  authorAvatar: { type: String, default: null },
  content:      { type: String, maxlength: 2000, default: '' },
  type:         { type: String, enum: ['text','system','bot'], default: 'text' },
  edited:       { type: Boolean, default: false },
  editedAt:     Date,
  deleted:      { type: Boolean, default: false },
  replyTo:      { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  replyPreview: { type: String, default: null },
  reactions:    [{ emoji: String, users: [{ type: mongoose.Schema.Types.ObjectId }] }],
  attachments:  [AttachmentSchema],
  createdAt:    { type: Date, default: Date.now },
});
MessageSchema.index({ channel: 1, createdAt: -1 });

const DMSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  messages: [{
    author:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorName:   String,
    authorAvatar: String,
    content:      { type: String, maxlength: 2000, default: '' },
    edited:       { type: Boolean, default: false },
    deleted:      { type: Boolean, default: false },
    reactions:    [{ emoji: String, users: [mongoose.Schema.Types.ObjectId] }],
    attachments:  [AttachmentSchema],
    createdAt:    { type: Date, default: Date.now },
  }],
  lastMessage: { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now },
});
DMSchema.index({ participants: 1 });

module.exports = {
  User:    mongoose.model('User',    UserSchema),
  Server:  mongoose.model('Server',  ServerSchema),
  Channel: mongoose.model('Channel', ChannelSchema),
  Message: mongoose.model('Message', MessageSchema),
  DM:      mongoose.model('DM',      DMSchema),
};
