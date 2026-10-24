const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn(async recipient => ({accepted:[recipient]})));
const sendEmail = require('../utils/email');
const State = require('../models/OpsMonitorState');
const Alert = require('../models/AdminCommunicationAlert');
const {connect,clearDatabase,closeDatabase} = require('./helpers/db');
const {persistMonitorState} = require('../services/operationalNotifications');
const {processAlerts} = require('../services/adminAlertService');
const previousRecipients = process.env.OWNER_ALERT_EMAILS;
const summary = (ok=false,fingerprint='synthetic_failure') => ({ok,fingerprint,checkedAt:new Date().toISOString()});
beforeAll(connect);
afterAll(async () => {await closeDatabase(); if(previousRecipients===undefined)delete process.env.OWNER_ALERT_EMAILS;else process.env.OWNER_ALERT_EMAILS=previousRecipients;});
beforeEach(async () => {await clearDatabase(); jest.clearAllMocks(); process.env.OWNER_ALERT_EMAILS='owner@capture.invalid, second@capture.invalid';});
test('transition and one notice per owner commit together; repeated monitors cannot resend', async () => {
 await persistMonitorState(summary(),{noticeKind:'failure'});
 await persistMonitorState(summary(),{noticeKind:'failure'});
 expect(await Alert.countDocuments()).toBe(2);
 await processAlerts(); await processAlerts();
 expect(sendEmail).toHaveBeenCalledTimes(2);
 expect(await Alert.countDocuments({status:'accepted'})).toBe(2);
 expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('synthetic_failure');
});
test('enqueue failure rolls back transition so next monitor can retry', async () => {
 const service=require('../services/adminAlertService');
 const failure=jest.spyOn(service,'enqueueAlert').mockRejectedValueOnce(new Error('storage unavailable'));
 await expect(persistMonitorState(summary(),{noticeKind:'failure'})).rejects.toThrow('storage unavailable');
 failure.mockRestore(); expect(await State.countDocuments()).toBe(0); expect(await Alert.countDocuments()).toBe(0);
 await persistMonitorState(summary(),{noticeKind:'failure'}); expect(await Alert.countDocuments()).toBe(2);
});
test('lost SMTP acknowledgement is held unknown and never blindly resent', async () => {
 await persistMonitorState(summary(),{noticeKind:'failure'});
 sendEmail.mockRejectedValueOnce(Object.assign(new Error('lost DATA acknowledgement'),{code:'ECONNRESET',command:'DATA'}));
 await processAlerts(); await processAlerts();
 expect(sendEmail).toHaveBeenCalledTimes(2); expect(await Alert.countDocuments({status:'unknown'})).toBe(1);
});
test('a recovery supersedes unsent failures and retains the exact configured recipients', async () => {
 await persistMonitorState(summary(),{noticeKind:'failure'});
 await persistMonitorState(summary(true,''),{noticeKind:'recovery'});
 await processAlerts();
 expect(await Alert.countDocuments({status:'skipped'})).toBe(2);
 expect(sendEmail.mock.calls.map(call=>call[0]).sort()).toEqual(['owner@capture.invalid','second@capture.invalid']);
 expect(sendEmail.mock.calls.every(call=>call[1].includes('healthy again'))).toBe(true);
});
test('removed recipients cannot receive queued notices', async () => {
 await persistMonitorState(summary(),{noticeKind:'failure'});
 process.env.OWNER_ALERT_EMAILS='owner@capture.invalid'; await processAlerts();
 expect(sendEmail).toHaveBeenCalledTimes(1); expect(sendEmail.mock.calls[0][0]).toBe('owner@capture.invalid');
 expect(await Alert.countDocuments({status:'skipped'})).toBe(1);
});
test('no recipient means no acknowledged transition', async () => {
 process.env.OWNER_ALERT_EMAILS='invalid-address';
 await expect(persistMonitorState(summary(),{noticeKind:'fatal'})).rejects.toMatchObject({code:'MISSING_RECIPIENTS'});
 expect(await State.countDocuments()).toBe(0);
});
