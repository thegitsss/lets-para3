module.exports = async function selectState(page, id, code) {
  const select = page.locator(`#${id}`);
  const search = page.locator(`#${id}Search`);
  if (await search.isVisible()) {
    await search.fill(code);
    await search.press('Tab');
  } else {
    await select.selectOption(code);
  }
  const actual = await select.inputValue();
  if (actual !== code) throw new Error(`${id}: expected ${code}, received ${actual}`);
};
