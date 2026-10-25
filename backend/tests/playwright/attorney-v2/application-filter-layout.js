const { expect } = require("playwright/test");

// Native controls do not expose a DOM text range. Measure their actual font and
// available content box to catch clipped values even when the page fits.
async function assertApplicationFiltersReadable(panel) {
  const measurements = await panel.locator(".matter-application-filters select").evaluateAll(controls => controls.map(control => {
    const style = getComputedStyle(control), canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const number = key => parseFloat(style[key]) || 0;
    const box = control.getBoundingClientRect();
    return {
      name: control.name,
      width: box.width - number("borderLeftWidth") - number("borderRightWidth") - number("paddingLeft") - number("paddingRight"),
      height: box.height - number("borderTopWidth") - number("borderBottomWidth") - number("paddingTop") - number("paddingBottom"),
      values: [...control.options].map(option => {
        const measured = context.measureText(option.textContent);
        return { text: option.textContent, width: measured.width, height: Math.max(number("fontSize"), measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent) };
      }),
    };
  }));
  for (const control of measurements) for (const value of control.values) {
    expect(value.height, `${control.name}: ${value.text} vertical fit`).toBeLessThanOrEqual(control.height + 1);
    expect(value.width, `${control.name}: ${value.text} horizontal fit`).toBeLessThanOrEqual(control.width + 1);
  }
  return measurements;
}
module.exports = { assertApplicationFiltersReadable };
