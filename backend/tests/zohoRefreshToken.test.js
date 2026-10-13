jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require("axios");
const mailImportService = require("../services/director/mailImportService");

describe("Zoho refresh-token authentication", () => {
  const profile = {
    email: "skyler@lets-paraconnect.com",
    zohoEmail: "skyler@lets-paraconnect.com",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mailImportService.clearZohoAccessTokenCache();
    delete process.env.DIRECTOR_ZOHO_SKYLER_TOKEN;
    delete process.env.DIRECTOR_ZOHO_SKYLER_REFRESH_TOKEN;
    delete process.env.DIRECTOR_ZOHO_SKYLER_CLIENT_ID;
    delete process.env.DIRECTOR_ZOHO_SKYLER_CLIENT_SECRET;
    delete process.env.ZOHO_MAIL_REFRESH_TOKEN;
    delete process.env.ZOHO_MAIL_CLIENT_ID;
    delete process.env.ZOHO_MAIL_CLIENT_SECRET;
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
  });

  test("uses a director refresh token to fetch and cache a Zoho access token", async () => {
    process.env.DIRECTOR_ZOHO_SKYLER_REFRESH_TOKEN = "refresh-token";
    process.env.DIRECTOR_ZOHO_SKYLER_CLIENT_ID = "client-id";
    process.env.DIRECTOR_ZOHO_SKYLER_CLIENT_SECRET = "client-secret";

    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: "fresh-access-token",
        expires_in: 3600,
      },
    });

    const config = mailImportService.getDirectorZohoConfig(profile);
    const firstToken = await mailImportService.refreshZohoAccessToken(config);
    const secondToken = await mailImportService.refreshZohoAccessToken(config);

    expect(firstToken).toBe("fresh-access-token");
    expect(secondToken).toBe("fresh-access-token");
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "https://accounts.zoho.com/oauth/v2/token",
      expect.stringContaining("grant_type=refresh_token"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      })
    );
  });

  test("falls back to the static access token while refresh-token env vars are missing", async () => {
    process.env.DIRECTOR_ZOHO_SKYLER_TOKEN = "temporary-token";

    const config = mailImportService.getDirectorZohoConfig(profile);
    const token = await mailImportService.refreshZohoAccessToken(config);

    expect(token).toBe("temporary-token");
    expect(axios.post).not.toHaveBeenCalled();
  });
});
