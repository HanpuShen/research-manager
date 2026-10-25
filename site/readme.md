# Product page

`index.html` is the GitHub Pages site. The workflow in `.github/workflows/pages.yml` copies it with `media/screenshots/` into the published page. Preview locally: `mkdir -p /tmp/rm-site && cp -r site/. /tmp/rm-site/ && cp -r media/screenshots /tmp/rm-site/screenshots && npx serve /tmp/rm-site`. Regenerate screenshots with `node scripts/demo/screenshots.mjs`.
