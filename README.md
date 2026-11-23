# Neokrome — site Internet

Site statique (HTML/CSS/JS, sans build) de Neokrome (.tech) — « L’intelligence visuelle. L’expérience numérique. » : 28 pages, salon virtuel 3D temps réel (three.js) et page Services.

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

## Tableau de bord des demandes (`admin/`)

Chaque formulaire du site (page d’attente, contact, démo, rendez-vous) enregistre la demande dans une base SQLite (`data/neokrome.sqlite`), en plus de l’e-mail envoyé via FormSubmit.

- **Hébergement (Coolify sur OVH) :** build pack **Dockerfile** (image PHP 8.3 + Apache, port 80) et un stockage persistant monté sur `/var/www/html/data`. Sans ce volume, les demandes seraient perdues à chaque déploiement.
- **Premier accès :** ouvrir `/admin/` dès la mise en ligne. À la première ouverture, on choisit le mot de passe.
- **Protection :** Apache refuse tout accès à `data/` et aux fichiers internes `api/_*.php` (voir `docker/apache-neokrome.conf`).
- **Test en local :** `php -S 127.0.0.1:8743 -t .` puis http://127.0.0.1:8743/admin/
- **API sur un autre domaine :** définir `window.NK_API = 'https://…/api/demande.php'` avant `assets/demandes.js`.
