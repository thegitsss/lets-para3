const AppSettings = require("../models/AppSettings");

const DEFAULT_APP_SETTINGS = {
  allowSignups: true,
  maintenanceMode: false,
  supportEmail: "",
};

async function getAppSettings() {
  let settings = await AppSettings.findOne();
  if (!settings) {
    settings = await AppSettings.create(DEFAULT_APP_SETTINGS);
  }
  return settings;
}

async function readMaintenanceMode() {
  const settings = await AppSettings.findOne()
    .select("maintenanceMode")
    .lean();
  return settings?.maintenanceMode === true;
}

function serializeAppSettings(settings = {}) {
  return {
    allowSignups: settings.allowSignups !== false,
    maintenanceMode: !!settings.maintenanceMode,
    supportEmail: settings.supportEmail || "",
    updatedAt: settings.updatedAt || null,
  };
}

module.exports = {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  readMaintenanceMode,
  serializeAppSettings,
};
