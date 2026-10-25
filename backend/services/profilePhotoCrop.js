// Advisory framing metadata. Never used to authorize or approve an image.
function parseProfilePhotoCrop(value) {
  if (typeof value === 'string') {
    if (value.length > 512) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'height,v,width,x,y' || value.v !== 1) return null;
  const {x,y,width,height} = value;
  if (![x,y,width,height].every(Number.isFinite) || x < 0 || y < 0 || width < 0.000001 || height < 0.000001 || x + width > 1.00000001 || y + height > 1.00000001) return null;
  return {v:1,x,y,width,height};
}
module.exports = { parseProfilePhotoCrop };
