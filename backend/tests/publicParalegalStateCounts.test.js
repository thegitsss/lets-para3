const User = require('../models/User');
const router = require('../routes/publicParalegalDirectory');
const express = require('express');
const request = require('supertest');
const publicRouter = require('../routes/public');
const handler = router.stack.find(layer => layer.route?.path === '/state-counts').route.stack.at(-1).handle;
afterEach(() => jest.restoreAllMocks());
test('the homepage URL reaches network counts before the public profile ID route', async () => {
 const app = express();
 app.use('/api/public/paralegals', router);
 app.use('/api/public', publicRouter);
 jest.spyOn(User, 'aggregate').mockResolvedValue([{ _id: { state: 'CA' }, count: 2 }]);
 const response = await request(app).get('/api/public/paralegals/state-counts');
 expect(response.status).toBe(200);
 expect(response.body).toMatchObject({ approvedTotal: 2, total: 2, states: { CA: 2 } });
 expect(response.body).not.toHaveProperty('error');
});
test('normalizes approved network home states without returning identities', async () => {
 const aggregate = jest.spyOn(User, 'aggregate').mockResolvedValue([
 { _id: { state: 'California', location: 'Austin, TX', stateExperience: ['NY'] }, count: 2 },
 { _id: { state: ' ca ' }, count: 3 },
 { _id: { state: '', location: 'Albany, NY', stateExperience: ['Texas', 'CA'] }, count: 1 },
 { _id: { state: 'District of Columbia' }, count: 1 },
 { _id: { state: 'Canada', location: 'New York', stateExperience: ['not a state', 'Georgia'] }, count: 9 }]);
 const res = { set: jest.fn(), json: jest.fn() }, next = jest.fn();
 await handler({}, res, next);
 expect(next).not.toHaveBeenCalled();
 const data = res.json.mock.calls[0][0];
 expect(data.states).toMatchObject({ CA: 5, NY: 0, DC: 1, TX: 1, GA: 9 });
 expect(data.total).toBe(16);
 expect(data.approvedTotal).toBe(16);
 expect(Object.keys(data.states)).toHaveLength(51);
 expect(aggregate.mock.calls[0][0][0].$match).toMatchObject({ role: 'paralegal', status: 'approved', disabled: { $ne: true }, deleted: { $ne: true } });
 expect(aggregate.mock.calls[0][0][0].$match).not.toHaveProperty('preferences.hideProfile');
 expect(aggregate.mock.calls[0][0][0].$match).not.toHaveProperty('$and');
 expect(Object.keys(data)).toEqual(['states', 'total', 'approvedTotal']);
});
test('database failures do not become zero counts', async () => {
 const error = new Error('unavailable');
 jest.spyOn(User, 'aggregate').mockRejectedValue(error);
 const res = { json: jest.fn() }, next = jest.fn();
 await handler({}, res, next);
 expect(next).toHaveBeenCalledWith(error);
 expect(res.json).not.toHaveBeenCalled();
});
