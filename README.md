# Art Exposium — site Internet

Site statique (HTML/CSS/JS, sans build) d'Art Exposium par Vif-Argent : 21 pages, salon virtuel 3D temps réel (three.js) et page Services.

## Voir le site en local

```bash
python3 -m http.server 8765
```

Puis ouvrir http://localhost:8765.

## Organisation

- `index.html` : accueil (démo 3D live) — pages secteurs, services, blog, contact, FAQ, pages légales à la racine
- `assets/site.css` : design system commun · `assets/blog.css`, `assets/pages.css` : styles partagés blog / pages
- `assets/hall3d.js` : salon 3D navigable · `assets/mercury.js` : goutte de mercure (page Services)
- `assets/img/` : images
