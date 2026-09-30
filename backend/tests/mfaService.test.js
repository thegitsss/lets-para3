const { createTotpEnrollment, generateTotpToken, verifyTotp } = require("../services/mfaService");

describe("authenticator-app MFA service", () => {
  test("generates a valid enrollment URI and prevents time-step replay", async () => {
    const enrollment = await createTotpEnrollment("member@example.com");
    expect(enrollment.uri).toContain("otpauth://totp/");
    expect(enrollment.uri).toContain("issuer=Let%27s-ParaConnect");

    const token = generateTotpToken(enrollment.secret).token;
    const first = await verifyTotp({ encryptedSecret: enrollment.encryptedSecret, token });
    expect(first.valid).toBe(true);
    expect(Number.isInteger(first.timeStep)).toBe(true);

    const replay = await verifyTotp({
      encryptedSecret: enrollment.encryptedSecret,
      token,
      afterTimeStep: first.timeStep,
    });
    expect(replay.valid).toBe(false);
  });
});
