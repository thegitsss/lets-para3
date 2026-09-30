function isDefiniteSmtpFailure(error, attempted = true) {
  // Nodemailer can report ECONNECTION / command CONN after DATA was accepted
  // but its acknowledgement was lost. That pair is not safe retry evidence.
  const response = Number(error?.responseCode);
  return !attempted || response >= 400 && response <= 599 || ["EAUTH", "EDNS", "EENVELOPE"].includes(error?.code);
}
module.exports = { isDefiniteSmtpFailure };
