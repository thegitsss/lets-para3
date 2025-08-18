const badWords = ['damn','hell','fraud','abuse'];
module.exports = function containsBad(text) {
  return badWords.some(w => text.toLowerCase().includes(w));
};
