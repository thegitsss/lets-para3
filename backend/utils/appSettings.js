const AppSettings = require("../models/AppSettings");

const DEFAULT_APP_SETTINGS = {
  allowSignups: true,
  maintenanceMode: false,
  supportEmail: "",
  taxRate: 0.22,
};

function normalizeTaxRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const normalized = num > 1 ? num / 100 : num;
  if (normalized < 0 || normalized > 1) return null;
  return normalized;
}

async function getAppSettings() {
  let settings = await AppSettings.findOne();
  if (!settings) {
    settings = await AppSettings.create(DEFAULT_APP_SETTINGS);
  }
  return settings;
}

function serializeAppSettings(settings = {}) {
  const taxRate = normalizeTaxRate(settings.taxRate);
  return {
    allowSignups: settings.allowSignups !== false,
    maintenanceMode: !!settings.maintenanceMode,
    supportEmail: settings.supportEmail || "",
    taxRate: taxRate !== null ? taxRate : DEFAULT_APP_SETTINGS.taxRate,
    updatedAt: settings.updatedAt || null,
  };
}

module.exports = {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  normalizeTaxRate,
  serializeAppSettings,
};
