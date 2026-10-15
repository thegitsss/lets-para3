jest.mock("../utils/email", () => jest.fn(async () => ({ disabled: true })));
jest.mock("../services/caseLifecycle", () => ({
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("synthetic receipt")),
  uploadPdfToS3: jest.fn(async () => ({ key: "synthetic" })),
}));
const User = require("../models/User");
const { ObjectId } = require("mongoose").Types;
const { generateWithdrawalReceipts } = require("../services/withdrawalLifecycle");
const { uploadPdfToS3 } = require("../services/caseLifecycle");
const caseId = "650000000000000000008801", paralegalId = "650000000000000000008802";
test.each(["string", "object_id", "populated"])("withdrawal receipt storage retains the same payee identity for a %s reference", async shape => {
  uploadPdfToS3.mockClear();
  const reference = shape === "string" ? paralegalId : shape === "object_id" ? new ObjectId(paralegalId) : new User({ _id: paralegalId, firstName: "Synthetic", lastName: "Paralegal", role: "paralegal" });
  await generateWithdrawalReceipts({ _id: caseId, title: "Synthetic Matter", withdrawnParalegalId: reference }, { grossAmount: 0 });
  expect(uploadPdfToS3.mock.calls.map(([input]) => input.key)).toEqual([
    `cases/${caseId}/receipt-withdrawal-attorney.pdf`,
    `cases/${caseId}/receipt-withdrawal-paralegal-${paralegalId}.pdf`,
  ]);
});
