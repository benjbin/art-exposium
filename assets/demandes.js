/* Neokrome — enregistre chaque demande dans la base du tableau de bord (admin/).
   Discret : si l'hébergement n'a pas l'API (ex. GitHub Pages), rien ne change pour le visiteur,
   l'e-mail part comme d'habitude. Pour une API sur un autre domaine : window.NK_API = 'https://…/api/demande.php'. */
(() => {
  const me = document.currentScript;
  const base = me && me.src ? new URL('../', me.src).href : new URL('./', location.href).href;
  window.nkLog = (source, data) => {
    try {
      const body = {source, langue: (document.documentElement.lang || 'fr').slice(0, 2)};
      for (const [k, v] of Object.entries(data || {})) if (!k.startsWith('_') || k === '_honey') body[k] = String(v);
      fetch(window.NK_API || base + 'api/demande.php', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), keepalive: true}).catch(() => {});
    } catch (e) { /* jamais bloquant */ }
  };
})();
