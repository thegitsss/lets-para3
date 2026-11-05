// The release baseline renders native state selectors.
module.exports = async function selectState(page, id, code) {
  const input = page.locator(`#${id}`);
  await input.selectOption(code);
  const actual = await input.inputValue();
  if (actual !== code) throw new Error(`${id}: expected ${code}, received ${actual}`);
};
