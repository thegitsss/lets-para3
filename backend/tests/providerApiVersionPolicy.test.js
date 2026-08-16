jest.mock("axios");

const axios = require("axios");
const { LINKEDIN_API_VERSION } = require("../services/marketing/linkedinApiPolicy");
const { publishLinkedInCompanyPost } = require("../services/marketing/linkedinPublisher");

describe("provider API version policy", () => {
  beforeEach(() => {
    axios.post.mockReset();
  });

  test("publishing always uses LPC's supported LinkedIn version, not stored input", async () => {
    axios.post.mockResolvedValue({
      status: 201,
      statusText: "Created",
      headers: { "x-restli-id": "urn:li:share:123" },
      data: { id: "urn:li:share:123" },
    });

    await publishLinkedInCompanyPost({
      connection: {
        accessToken: "test-access-token",
        organizationUrn: "urn:li:organization:123",
        apiVersion: "202503",
      },
      packet: { channelDraft: { body: "A real LPC update." } },
    });

    expect(LINKEDIN_API_VERSION).toBe("202607");
    expect(axios.post).toHaveBeenCalledWith(
      "https://api.linkedin.com/rest/posts",
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ "Linkedin-Version": LINKEDIN_API_VERSION }),
      })
    );
  });
});
