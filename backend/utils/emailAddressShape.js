function isEmailAddressShape(value) {
  const email = String(value || "").toLowerCase();
  if (!email || email.length > 320 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;
  const dot = email.indexOf(".", at + 1);
  return dot > at + 1 && dot < email.length - 1;
}

module.exports = { isEmailAddressShape };
