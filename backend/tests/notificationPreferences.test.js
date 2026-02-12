const User = require("../models/User");
const Notification = require("../models/Notification");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn());

const sendEmail = require("../utils/email");
const { notifyUser } = require("../utils/notifyUser");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  sendEmail.mockClear();
});

describe("Notification preferences", () => {
  test("Email off for messages still creates in-app notification", async () => {
    // Description: User disables message emails but keeps in-app on.
    // Input values: emailMessages=false, inAppMessages=true, type="message".
    // Expected result: Notification created, sendEmail not called.

    const user = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "priya.ng@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      notificationPrefs: {
        email: true,
        emailMessages: false,
        inApp: true,
        inAppMessages: true,
      },
    });

    await notifyUser(user._id, "message", { message: "New message" });

    const notif = await Notification.findOne({ userId: user._id, type: "message" }).lean();
    expect(notif).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("Email off for case updates still creates in-app notification", async () => {
    // Description: User disables case emails but keeps in-app on.
    // Input values: emailCase=false, inAppCase=true, type="case_update".
    // Expected result: Notification created, sendEmail not called.

    const user = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "alex.stone@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      notificationPrefs: {
        email: true,
        emailCase: false,
        inApp: true,
        inAppCase: true,
      },
    });

    await notifyUser(user._id, "case_update", { caseTitle: "Immigration support" });

    const notif = await Notification.findOne({ userId: user._id, type: "case_update" }).lean();
    expect(notif).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("Email and in-app off produces no notification", async () => {
    // Description: User turns off all notifications.
    // Input values: email=false, inApp=false, type="message".
    // Expected result: No Notification and no email.

    const user = await User.create({
      firstName: "Jordan",
      lastName: "Lee",
      email: "jordan.lee@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      notificationPrefs: {
        email: false,
        inApp: false,
      },
    });

    await notifyUser(user._id, "message", { message: "New message" });

    const notif = await Notification.findOne({ userId: user._id, type: "message" }).lean();
    expect(notif).toBeFalsy();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
