/* Neokrome — envoi des formulaires du site.
   nkLog     : enregistre la demande dans le tableau de bord (admin/).
   nkEnvoyer : enregistre la demande ET l'envoie par e-mail (FormSubmit).
               Réussit dès que l'un des deux a abouti, pour que le visiteur
               voie tout de suite que son message est parti ; échoue si aucun
               n'a abouti en 15 secondes. */
(() => {
  const me = document.currentScript;
  const base = me && me.src ? new URL('../', me.src).href : new URL('./', location.href).href;

  window.nkLog = (source, data) => {
    try {
      const body = {source, langue: (document.documentElement.lang || 'fr').slice(0, 2)};
      for (const [k, v] of Object.entries(data || {})) if (!k.startsWith('_') || k === '_honey') body[k] = String(v);
      /* text/plain : pas de requête préalable (CORS), donc plus rapide et compatible keepalive */
      return fetch(window.NK_API || base + 'api/demande.php', {method: 'POST', headers: {'Content-Type': 'text/plain;charset=UTF-8'}, body: JSON.stringify(body), keepalive: true})
        .then(r => r.json()).then(j => { if (!j.ok) throw j; return j; });
    } catch (e) { return Promise.reject(e); }
  };

  window.nkEnvoyer = (source, data, to, extra) => {
    const local = window.nkLog(source, data);
    const mail = fetch('https://formsubmit.co/ajax/' + to, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify({...data, ...extra})})
      .then(r => r.json().then(j => { if (!r.ok || String(j.success) !== 'true') throw j; return j; }));
    local.catch(() => {}); mail.catch(() => {});
    const delai = new Promise((_, ko) => setTimeout(() => ko(new Error('délai dépassé')), 15000));
    return Promise.race([Promise.any([local, mail]), delai]);
  };
})();
