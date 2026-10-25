const MOBILE_MOUNTAIN_PATH = "/assets/images/homepage-capacity/mountain-mobile-1920-fb4e1e2d7eff.jpg";

function mountMobileHomepageImages(app, frontendDir) {
  app.get(MOBILE_MOUNTAIN_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.removeHeader("Pragma");
    res.removeHeader("Expires");
    res.sendFile(MOBILE_MOUNTAIN_PATH.slice(1), { root: frontendDir });
  });
  // Hidden desktop SVG references still request this URL on phones. Send them
  // to the same cached mobile copy, without changing desktop responses.
  app.get("/hero-mountain-restored.jpg", (req, res, next) => {
    if (!/\bMobile\b|iPhone|iPod|Windows Phone/i.test(req.get("User-Agent") || "")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.vary("User-Agent");
    res.redirect(302, MOBILE_MOUNTAIN_PATH);
  });
}

module.exports = { mountMobileHomepageImages, MOBILE_MOUNTAIN_PATH };
