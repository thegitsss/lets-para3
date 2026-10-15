const {
  extractPersonalFileKey,
  validatePersonalFileKey,
} = require("../utils/personalFileReference");

const ownerId = "507f1f77bcf86cd799439011";
const options = {
  ownerId,
  type: "resume",
  bucket: "private-lpc-files",
  region: "us-east-1",
};

describe("personal file references", () => {
  test("accepts only the correct document class in the exact owner's protected folder", () => {
    const key = `paralegal-resumes/${ownerId}/resume-1760000000000.pdf`;
    expect(validatePersonalFileKey(key, options)).toBe(key);
    expect(validatePersonalFileKey(`paralegal-resumes/507f1f77bcf86cd799439012/resume.pdf`, options)).toBe("");
    expect(validatePersonalFileKey(`paralegal-certificates/${ownerId}/certificate.pdf`, options)).toBe("");
    expect(validatePersonalFileKey(`paralegal-resumes/${ownerId}/../other/resume.pdf`, options)).toBe("");
  });

  test("normalizes only trusted bucket URLs and rejects arbitrary external documents", () => {
    const key = `paralegal-resumes/${ownerId}/resume-1760000000000.pdf`;
    expect(extractPersonalFileKey(`https://private-lpc-files.s3.us-east-1.amazonaws.com/${key}`, options)).toBe(key);
    expect(extractPersonalFileKey(`https://evil.example/${key}`, options)).toBe("");
    expect(extractPersonalFileKey(`https://private-lpc-files.s3.us-east-1.amazonaws.com/${key}?download=1`, options)).toBe("");
  });
});
