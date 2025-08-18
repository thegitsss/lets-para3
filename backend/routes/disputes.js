router.get('/open', verifyToken, async (req, res) => {
  const disputes = await Dispute.find({ status: 'open' })
    .populate('caseId', 'title')
    .populate('raisedBy', 'email');
  res.json(disputes);
});

router.post('/:id/resolve', verifyToken, async (req, res) => {
  await Dispute.findByIdAndUpdate(req.params.id, { status: 'resolved' });
  res.json({ msg: 'Dispute resolved' });
});

router.post('/:id/reject', verifyToken, async (req, res) => {
  await Dispute.findByIdAndUpdate(req.params.id, { status: 'rejected' });
  res.json({ msg: 'Dispute rejected' });
});
