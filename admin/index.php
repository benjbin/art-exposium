<?php
/* Neokrome — tableau de bord des demandes reçues (accès protégé par mot de passe) */
declare(strict_types=1);
require __DIR__ . '/../api/_db.php';

$https = (($_SERVER['HTTPS'] ?? '') && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
session_name('nkadmin');
session_set_cookie_params(['lifetime' => 0, 'path' => dirname($_SERVER['SCRIPT_NAME']) . '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Strict']);
session_start();
header('X-Frame-Options: DENY');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex, nofollow');
header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'");

$db = nk_db();
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(24));
$csrf = $_SESSION['csrf'];
$hash = nk_get('admin_hash');
$connecte = !empty($_SESSION['admin']) && ($_SESSION['vu'] ?? 0) > time() - 8 * 3600;
if ($connecte) $_SESSION['vu'] = time();
$csrf_ok = fn() => hash_equals($csrf, (string) ($_POST['csrf'] ?? $_SERVER['HTTP_X_CSRF'] ?? ''));
$erreur = '';

/* ---------- création du mot de passe, connexion, déconnexion ---------- */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['action'])) {
    if (!$csrf_ok()) { $erreur = 'Session expirée, réessayez.'; }
    elseif ($_POST['action'] === 'creer' && !$hash) {
        $p = (string) ($_POST['mdp'] ?? '');
        if (mb_strlen($p) < 10) $erreur = 'Choisissez au moins 10 caractères.';
        elseif ($p !== (string) ($_POST['mdp2'] ?? '')) $erreur = 'Les deux mots de passe ne correspondent pas.';
        else { nk_set('admin_hash', password_hash($p, PASSWORD_DEFAULT)); session_regenerate_id(true); $_SESSION['admin'] = 1; $_SESSION['vu'] = time(); header('Location: ./'); exit; }
    } elseif ($_POST['action'] === 'connexion' && $hash) {
        $ip = nk_ip_hash();
        $db->prepare('DELETE FROM echecs WHERE le < ?')->execute([time() - 900]);
        $s = $db->prepare('SELECT COUNT(*) FROM echecs WHERE ip_hash = ?'); $s->execute([$ip]);
        if ((int) $s->fetchColumn() >= 5) $erreur = 'Trop d’essais. Réessayez dans 15 minutes.';
        elseif (password_verify((string) ($_POST['mdp'] ?? ''), $hash)) {
            if (password_needs_rehash($hash, PASSWORD_DEFAULT)) nk_set('admin_hash', password_hash((string) $_POST['mdp'], PASSWORD_DEFAULT));
            session_regenerate_id(true); $_SESSION['admin'] = 1; $_SESSION['vu'] = time(); header('Location: ./'); exit;
        } else { $db->prepare('INSERT INTO echecs VALUES (?, ?)')->execute([$ip, time()]); usleep(400000); $erreur = 'Mot de passe incorrect.'; }
    } elseif ($_POST['action'] === 'deconnexion') {
        $_SESSION = []; session_destroy(); header('Location: ./'); exit;
    }
}

/* ---------- API du tableau de bord (JSON) ---------- */
if (isset($_GET['api'])) {
    if (!$connecte) nk_json(['ok' => false, 'erreur' => 'session'], 401);
    $api = $_GET['api'];
    if ($api === 'liste') {
        $rows = $db->query('SELECT id, recue_le, source, langue, nom, prenom, entreprise, email, telephone, projet, message, details, statut, note, maj_le FROM demandes ORDER BY recue_le DESC, id DESC')->fetchAll();
        foreach ($rows as &$r) { $r['id'] = (int) $r['id']; $r['details'] = json_decode($r['details'] ?: '{}', true) ?: (object) []; }
        nk_json(['ok' => true, 'demandes' => $rows, 'sources' => NK_SOURCES, 'statuts' => NK_STATUTS]);
    }
    if ($api === 'export') {
        $rows = $db->query('SELECT id, recue_le, source, langue, statut, nom, prenom, entreprise, email, telephone, projet, message, details, note FROM demandes ORDER BY recue_le DESC')->fetchAll();
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="demandes-neokrome-' . date('Y-m-d') . '.csv"');
        $out = fopen('php://output', 'w');
        fwrite($out, "\xEF\xBB\xBF");
        fputcsv($out, ['N°', 'Reçue le (UTC)', 'Source', 'Langue', 'Statut', 'Nom', 'Prénom', 'Entreprise', 'E-mail', 'Téléphone', 'Projet', 'Message', 'Détails', 'Note interne'], ';', '"', '');
        foreach ($rows as $r) {
            $r['source'] = NK_SOURCES[$r['source']] ?? $r['source']; $r['statut'] = NK_STATUTS[$r['statut']] ?? $r['statut'];
            /* une cellule qui commence par = + - @ serait prise pour une formule par le tableur */
            fputcsv($out, array_map(fn($v) => preg_match('/^[=+\-@\t\r]/', (string) $v) ? "'" . $v : $v, array_values($r)), ';', '"', '');
        }
        exit;
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !$csrf_ok()) nk_json(['ok' => false, 'erreur' => 'csrf'], 403);
    $id = (int) ($_POST['id'] ?? 0);
    if ($api === 'maj') {
        $statut = (string) ($_POST['statut'] ?? '');
        if (isset($_POST['statut']) && !isset(NK_STATUTS[$statut])) nk_json(['ok' => false], 422);
        if (isset($_POST['statut'])) $db->prepare("UPDATE demandes SET statut = ?, maj_le = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")->execute([$statut, $id]);
        if (isset($_POST['note'])) $db->prepare("UPDATE demandes SET note = ?, maj_le = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")->execute([mb_substr((string) $_POST['note'], 0, 4000), $id]);
        nk_json(['ok' => true]);
    }
    if ($api === 'supprimer') { $db->prepare('DELETE FROM demandes WHERE id = ?')->execute([$id]); nk_json(['ok' => true]); }
    nk_json(['ok' => false], 404);
}

$e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
?><!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Demandes — Neokrome admin</title>
<link rel="icon" type="image/svg+xml" href="../assets/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#08090C;--bg:#0C0D11;--panel:#13151B;--panel-2:#191C23;--line:rgba(255,255,255,.09);--line-2:rgba(255,255,255,.16);--mute:rgba(255,255,255,.55);--soft:rgba(255,255,255,.75);--paper:#F4F1EA;--blue:#145CFF;--blue-2:#4D82FF;--green:#3DD68C;--amber:#FFB547;--red:#FF6B6B;--display:'Outfit',system-ui,sans-serif;--body:'Manrope',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%}
body{background:var(--bg);color:#fff;font:15px/1.5 var(--body);-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
a{color:inherit}
:focus-visible{outline:2px solid var(--blue-2);outline-offset:2px}
.mark{display:flex;align-items:center;gap:12px;font-family:var(--display);font-weight:800;letter-spacing:-.01em;text-decoration:none}
.mark svg{height:30px;width:auto}.mark .p{fill:var(--paper)}.mark .l{fill:var(--blue)}
.mark small{font-weight:500;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--mute);margin-left:4px}

/* écran de connexion */
.gate{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(60% 50% at 70% 0%,rgba(20,92,255,.18),transparent 70%),var(--ink)}
.gate form{width:min(400px,100%);background:var(--panel);border:1px solid var(--line);border-radius:26px;padding:34px;box-shadow:0 40px 120px -40px #000}
.gate h1{font-family:var(--display);font-size:30px;line-height:1.05;letter-spacing:-.03em;margin:28px 0 8px}
.gate p{color:var(--mute);font-size:14px}
.gate label{display:block;margin-top:18px;font-size:13px;font-weight:600;color:var(--soft)}
.gate input[hidden]{display:none}
.gate input:not([hidden]){display:block;width:100%;margin-top:7px;padding:13px 16px;border-radius:14px;border:1px solid var(--line-2);background:rgba(255,255,255,.04);font-size:16px}
.gate input:focus{outline:none;border-color:var(--blue-2);box-shadow:0 0 0 4px rgba(20,92,255,.2)}
.gate .err{margin-top:16px;padding:10px 14px;border-radius:12px;background:rgba(255,107,107,.12);color:#FFC9C9;font-size:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line-2);background:rgba(255,255,255,.04);border-radius:999px;padding:9px 16px;font-size:14px;font-weight:600;text-decoration:none;transition:background .2s,border-color .2s,color .2s;white-space:nowrap}
.btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.3)}
.btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.btn.pri{background:var(--paper);color:#0B0C0F;border-color:var(--paper)}
.btn.pri:hover{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.dng:hover{background:rgba(255,107,107,.14);border-color:var(--red);color:#FFC9C9}
.gate .btn{width:100%;margin-top:24px;padding:14px;font-size:16px}

/* tableau de bord */
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px clamp(16px,3vw,36px);background:rgba(12,13,17,.82);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.top nav{display:flex;gap:8px;align-items:center}
.wrap{padding:clamp(18px,3vw,36px);max-width:1500px;margin:0 auto}
.hd{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap}
.hd h1{font-family:var(--display);font-size:clamp(30px,3.4vw,44px);line-height:1;letter-spacing:-.035em}
.hd p{color:var(--mute);margin-top:8px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,1.6fr);gap:12px;margin-top:26px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:18px 20px}
.kpi small{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);font-family:var(--display);font-weight:500}
.kpi b{display:block;margin-top:6px;font-family:var(--display);font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1}
.kpi b i{font-style:normal;font-size:15px;color:var(--mute);font-weight:500;margin-left:6px;letter-spacing:0}
.kpi.new b{color:var(--blue-2)}
.spark{display:flex;align-items:flex-end;gap:3px;height:46px;margin-top:10px}
.spark span{flex:1;min-width:2px;border-radius:3px 3px 1px 1px;background:rgba(77,130,255,.35);min-height:2px;position:relative}
.spark span.on{background:var(--blue-2)}
.spark span:hover{background:#fff}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:26px}
.seg{display:flex;flex-wrap:wrap;gap:4px;padding:4px;background:var(--panel);border:1px solid var(--line);border-radius:999px}
.seg button{border:0;background:none;padding:8px 14px;border-radius:999px;font-size:14px;font-weight:600;color:var(--soft);display:flex;gap:8px;align-items:center}
.seg button i{font-style:normal;font-size:12px;padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--mute)}
.seg button[aria-pressed=true]{background:var(--paper);color:#0B0C0F}
.seg button[aria-pressed=true] i{background:rgba(0,0,0,.1);color:#0B0C0F}
.field{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:0 14px;height:44px}
.field:focus-within{border-color:var(--blue-2)}
.field svg{width:16px;height:16px;flex:none;stroke:var(--mute);fill:none;stroke-width:2}
.field input,.field select{background:none;border:0;outline:none;height:100%;min-width:0}
.field select option{background:var(--panel)}
.search{flex:1;min-width:200px}.search input{width:100%}

.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:16px;margin-top:16px;align-items:start}
.list{background:var(--panel);border:1px solid var(--line);border-radius:22px;overflow:hidden}
.row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:14px;align-items:center;width:100%;text-align:left;border:0;background:none;padding:15px 18px;border-bottom:1px solid var(--line);transition:background .15s}
.row:last-child{border-bottom:0}
.row:hover{background:rgba(255,255,255,.03)}
.row[aria-current=true]{background:rgba(20,92,255,.12);box-shadow:inset 3px 0 0 var(--blue)}
.dot{width:8px;height:8px;border-radius:50%}
.dot.nouveau{background:var(--blue-2);box-shadow:0 0 0 4px rgba(77,130,255,.15)}
.row .who{min-width:0}
.row .who b{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .who b em{font-style:normal;font-weight:500;color:var(--mute)}
.row .who p{color:var(--mute);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .meta{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.row time{font-size:12.5px;color:var(--mute);white-space:nowrap}
.tags{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.tag{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--line-2);color:var(--soft);white-space:nowrap}
.tag.en{border-color:rgba(77,130,255,.5);color:#A9C2FF}
.st{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
.st.nouveau{background:rgba(77,130,255,.16);color:#A9C2FF}
.st.en_cours{background:rgba(255,181,71,.14);color:#FFD08A}
.st.traite{background:rgba(61,214,140,.14);color:#8FEBBE}
.st.archive{background:rgba(255,255,255,.07);color:var(--mute)}
.empty{padding:60px 24px;text-align:center;color:var(--mute)}
.empty b{display:block;font-family:var(--display);font-size:20px;color:#fff;margin-bottom:6px}

.det{position:sticky;top:84px;background:var(--panel);border:1px solid var(--line);border-radius:22px;max-height:calc(100vh - 104px);overflow:auto}
.det-in{padding:26px clamp(20px,2.4vw,32px)}
.det-hd{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.det h2{font-family:var(--display);font-size:28px;line-height:1.05;letter-spacing:-.03em}
.det h2+p{color:var(--mute);margin-top:6px}
.det .x{display:none}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;margin-top:22px;background:var(--line);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.kv div{background:var(--panel-2);padding:12px 14px;min-width:0}
.kv small{display:block;font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);font-family:var(--display)}
.kv span{display:block;margin-top:3px;font-weight:600;overflow-wrap:anywhere}
.kv a{text-decoration:none}.kv a:hover{color:var(--blue-2)}
.msg{margin-top:20px;padding:18px 20px;border-radius:16px;background:var(--panel-2);border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;color:rgba(255,255,255,.9)}
.msg:empty::before{content:"(pas de message)";color:var(--mute)}
.lbl{margin-top:24px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);font-family:var(--display);font-weight:500}
.status-pick{margin-top:10px}
.note{margin-top:10px;width:100%;min-height:90px;resize:vertical;padding:12px 14px;border-radius:14px;border:1px solid var(--line-2);background:rgba(255,255,255,.03);line-height:1.5}
.note:focus{outline:none;border-color:var(--blue-2)}
.saved{font-size:13px;color:var(--green);margin-left:10px;opacity:0;transition:opacity .3s}.saved.on{opacity:1}
.foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:26px;padding-top:18px;border-top:1px solid var(--line);font-size:12.5px;color:var(--mute)}
.placeholder{padding:80px 30px;text-align:center;color:var(--mute)}
.placeholder svg{width:46px;height:46px;stroke:rgba(255,255,255,.25);fill:none;stroke-width:1.5;margin-bottom:12px}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);opacity:0;padding:12px 18px;border-radius:999px;background:var(--paper);color:#0B0C0F;font-weight:600;font-size:14px;transition:.3s;pointer-events:none;z-index:20}
.toast.on{opacity:1;transform:translate(-50%,0)}

@media (max-width:1100px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpis .kpi:last-child{grid-column:1/-1}}
@media (max-width:900px){
  .grid{grid-template-columns:1fr}
  .det{position:fixed;inset:0;top:0;z-index:10;max-height:none;border-radius:0;border:0;transform:translateX(100%);transition:transform .3s cubic-bezier(.2,.8,.1,1)}
  .det.open{transform:none}
  .det .x{display:inline-flex}
  .top .lbl-txt{display:none}
}
</style>
</head>
<body>
<?php if (!$connecte): ?>
<main class="gate">
  <form method="post" autocomplete="on">
    <span class="mark"><svg viewBox="0 0 220 230" aria-hidden="true"><polygon class="p" points="0,42 99,112 99,229 0,172"/><polygon class="p" points="140,122 219,72 219,172 140,229"/><polygon class="l" points="78,45 204,1 205,69 139,100"/></svg>NEOKROME<small>admin</small></span>
    <input type="hidden" name="csrf" value="<?= $e($csrf) ?>">
    <input type="text" name="username" value="admin" autocomplete="username" hidden>
<?php if (!$hash): ?>
    <input type="hidden" name="action" value="creer">
    <h1>Créez votre accès.</h1>
    <p>Première ouverture : choisissez le mot de passe qui protégera les demandes reçues.</p>
    <label>Mot de passe <input type="password" name="mdp" minlength="10" required autocomplete="new-password" autofocus></label>
    <label>Confirmez-le <input type="password" name="mdp2" minlength="10" required autocomplete="new-password"></label>
    <?php if ($erreur): ?><p class="err" role="alert"><?= $e($erreur) ?></p><?php endif ?>
    <button class="btn pri">Créer l’accès</button>
<?php else: ?>
    <input type="hidden" name="action" value="connexion">
    <h1>Demandes reçues.</h1>
    <p>Espace réservé à l’équipe Neokrome.</p>
    <label>Mot de passe <input type="password" name="mdp" required autocomplete="current-password" autofocus></label>
    <?php if ($erreur): ?><p class="err" role="alert"><?= $e($erreur) ?></p><?php endif ?>
    <button class="btn pri">Se connecter</button>
<?php endif ?>
  </form>
</main>
<?php else: ?>
<header class="top">
  <a class="mark" href="./"><svg viewBox="0 0 220 230" aria-hidden="true"><polygon class="p" points="0,42 99,112 99,229 0,172"/><polygon class="p" points="140,122 219,72 219,172 140,229"/><polygon class="l" points="78,45 204,1 205,69 139,100"/></svg>NEOKROME<small>admin</small></a>
  <nav>
    <button class="btn" id="reload" title="Actualiser"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg><span class="lbl-txt">Actualiser</span></button>
    <a class="btn" href="?api=export"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/></svg><span class="lbl-txt">Export CSV</span></a>
    <form method="post"><input type="hidden" name="csrf" value="<?= $e($csrf) ?>"><input type="hidden" name="action" value="deconnexion"><button class="btn" title="Se déconnecter"><svg viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg><span class="lbl-txt">Déconnexion</span></button></form>
  </nav>
</header>
<main class="wrap">
  <div class="hd">
    <div><h1>Demandes reçues</h1><p id="sub">Chargement…</p></div>
  </div>
  <section class="kpis" aria-label="Chiffres clés">
    <div class="kpi"><small>Total</small><b id="kTotal">–</b></div>
    <div class="kpi new"><small>À traiter</small><b id="kNew">–</b></div>
    <div class="kpi"><small>7 derniers jours</small><b id="kWeek">–</b></div>
    <div class="kpi"><small>Traitées</small><b id="kDone">–</b></div>
    <div class="kpi"><small>30 derniers jours</small><div class="spark" id="spark" aria-hidden="true"></div></div>
  </section>
  <div class="bar">
    <div class="seg" id="seg" role="group" aria-label="Filtrer par statut"></div>
    <label class="field"><svg viewBox="0 0 24 24"><path d="M4 5h16l-6 8v5l-4 2v-7z"/></svg><select id="src" aria-label="Source"><option value="">Toutes les sources</option></select></label>
    <label class="field search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="q" type="search" placeholder="Rechercher un nom, une entreprise, un e-mail, un mot…" aria-label="Rechercher"></label>
  </div>
  <div class="grid">
    <div class="list" id="list" role="list"></div>
    <aside class="det" id="det" aria-live="polite"><div class="placeholder"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg><p>Sélectionnez une demande pour la lire.</p></div></aside>
  </div>
</main>
<div class="toast" id="toast" role="status"></div>
<script>
(() => {
  const CSRF = <?= json_encode($csrf) ?>;
  const $ = s => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(k => k != null && k !== false)); return el; };
  const ico = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = d; return s; };
  let all = [], SRC = {}, ST = {}, filtre = 'actives', courant = null;

  const date = iso => new Date(iso);
  const quand = iso => { const d = date(iso), j = (Date.now() - d) / 864e5; if (j < 1 && d.getDate() === new Date().getDate()) return 'Aujourd’hui ' + d.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'}); if (j < 2) return 'Hier ' + d.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'}); return d.toLocaleDateString('fr-FR', {day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'}); };
  const nomDe = r => [r.prenom, r.nom].filter(Boolean).join(' ') || r.email;
  const toast = t => { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2200); };
  const post = (api, data) => fetch('?api=' + api, {method: 'POST', headers: {'X-CSRF': CSRF}, body: new URLSearchParams(data)}).then(r => { if (r.status === 401) location.reload(); return r.json(); });

  const FILTRES = [['actives', 'À suivre', r => r.statut === 'nouveau' || r.statut === 'en_cours'], ['nouveau', 'Nouvelles'], ['en_cours', 'En cours'], ['traite', 'Traitées'], ['archive', 'Archivées'], ['toutes', 'Toutes', () => true]];
  const passe = (r, f) => { const F = FILTRES.find(x => x[0] === f); return F[2] ? F[2](r) : r.statut === f; };

  function kpis() {
    const now = Date.now();
    $('#kTotal').textContent = all.length;
    $('#kNew').textContent = all.filter(r => r.statut === 'nouveau').length;
    $('#kWeek').textContent = all.filter(r => now - date(r.recue_le) < 7 * 864e5).length;
    const done = all.filter(r => r.statut === 'traite' || r.statut === 'archive').length;
    $('#kDone').replaceChildren(String(done), all.length ? h('i', {}, Math.round(done / all.length * 100) + ' %') : '');
    const jours = [...Array(30)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 29 + i); return d; });
    const n = jours.map(d => all.filter(r => { const x = date(r.recue_le); return x >= d && x < new Date(+d + 864e5); }).length);
    const max = Math.max(1, ...n);
    $('#spark').replaceChildren(...n.map((v, i) => h('span', {class: v ? 'on' : '', style: 'height:' + Math.max(4, v / max * 100) + '%', title: jours[i].toLocaleDateString('fr-FR', {day: 'numeric', month: 'short'}) + ' : ' + v})));
    const dern = all[0];
    $('#sub').textContent = all.length ? 'Dernière demande : ' + quand(dern.recue_le).toLowerCase() + ' — ' + nomDe(dern) : 'Aucune demande pour l’instant.';
  }

  function seg() {
    $('#seg').replaceChildren(...FILTRES.map(([k, lbl]) => h('button', {type: 'button', 'aria-pressed': String(filtre === k), onclick: () => { filtre = k; seg(); liste(); }}, lbl, h('i', {}, String(all.filter(r => passe(r, k)).length)))));
  }

  function liste() {
    const q = $('#q').value.trim().toLowerCase(), s = $('#src').value;
    const rows = all.filter(r => passe(r, filtre) && (!s || r.source === s) && (!q || [r.nom, r.prenom, r.entreprise, r.email, r.telephone, r.projet, r.message, r.note, ...Object.values(r.details || {})].join(' ').toLowerCase().includes(q)));
    const L = $('#list');
    if (!rows.length) { L.replaceChildren(h('div', {class: 'empty'}, h('b', {}, all.length ? 'Rien ici.' : 'Aucune demande pour l’instant.'), all.length ? 'Aucune demande ne correspond à ce filtre.' : 'Les messages envoyés depuis le site apparaîtront ici.')); return; }
    L.replaceChildren(...rows.map(r => h('button', {type: 'button', class: 'row', role: 'listitem', 'aria-current': String(courant === r.id), onclick: () => detail(r.id)},
      h('span', {class: 'dot ' + r.statut}),
      h('span', {class: 'who'}, h('b', {}, nomDe(r), r.entreprise ? h('em', {}, ' · ' + r.entreprise) : ''), h('p', {}, r.message ? r.message.replace(/\s+/g, ' ') : r.email)),
      h('span', {class: 'meta'}, h('time', {datetime: r.recue_le}, quand(r.recue_le)), h('span', {class: 'tags'}, r.langue === 'en' ? h('span', {class: 'tag en'}, 'EN') : '', h('span', {class: 'tag'}, SRC[r.source] || r.source), h('span', {class: 'st ' + r.statut}, ST[r.statut]))))));
  }

  function detail(id) {
    courant = id; liste();
    const r = all.find(x => x.id === id), D = $('#det');
    if (!r) { D.classList.remove('open'); return; }
    const kv = [['E-mail', h('a', {href: 'mailto:' + r.email}, r.email)], r.telephone && ['Téléphone', h('a', {href: 'tel:' + r.telephone.replace(/[^\d+]/g, '')}, r.telephone)], r.entreprise && ['Entreprise', r.entreprise], r.projet && ['Projet', r.projet], ['Source', SRC[r.source] || r.source], ['Langue', r.langue === 'en' ? 'Anglais' : 'Français'],
      ['Reçue le', date(r.recue_le).toLocaleString('fr-FR', {dateStyle: 'long', timeStyle: 'short'})]].filter(Boolean);
    const objet = (r.langue === 'en' ? 'Re: your request — Neokrome' : 'Re : votre demande — Neokrome');
    const note = h('textarea', {class: 'note', placeholder: 'Note interne (visible uniquement ici)…', 'aria-label': 'Note interne'});
    note.value = r.note || '';
    const ok = h('span', {class: 'saved'}, 'Enregistré');
    const saveNote = () => { if (note.value === (r.note || '')) return; r.note = note.value; post('maj', {id: r.id, note: note.value}).then(() => { ok.classList.add('on'); setTimeout(() => ok.classList.remove('on'), 1600); }); };
    note.addEventListener('blur', saveNote);
    const setStatut = st => post('maj', {id: r.id, statut: st}).then(j => { if (j.ok) { r.statut = st; kpis(); seg(); detail(r.id); toast('Statut : ' + ST[st]); } });
    D.replaceChildren(h('div', {class: 'det-in'},
      h('div', {class: 'det-hd'}, h('div', {}, h('h2', {}, nomDe(r)), h('p', {}, [r.entreprise, quand(r.recue_le)].filter(Boolean).join(' · '))),
        h('button', {type: 'button', class: 'btn x', 'aria-label': 'Fermer', onclick: () => { D.classList.remove('open'); courant = null; liste(); }}, ico('<path d="M6 6l12 12M18 6 6 18"/>'))),
      h('div', {class: 'acts'},
        h('a', {class: 'btn pri', href: 'mailto:' + r.email + '?subject=' + encodeURIComponent(objet)}, ico('<path d="M10 9 5 12l5 3M5 12h9a5 5 0 0 1 5 5v1"/>'), 'Répondre'),
        r.telephone ? h('a', {class: 'btn', href: 'tel:' + r.telephone.replace(/[^\d+]/g, '')}, ico('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'), 'Appeler') : '',
        h('button', {type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(r.email).then(() => toast('E-mail copié'))}, ico('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'), 'Copier l’e-mail')),
      h('div', {class: 'kv'}, kv.map(([k, v]) => h('div', {}, h('small', {}, k), h('span', {}, v)))),
      h('p', {class: 'lbl'}, 'Message'), h('div', {class: 'msg'}, r.message),
      h('p', {class: 'lbl'}, 'Statut'),
      h('div', {class: 'seg status-pick', role: 'group', 'aria-label': 'Changer le statut'}, Object.entries(ST).map(([k, lbl]) => h('button', {type: 'button', 'aria-pressed': String(r.statut === k), onclick: () => r.statut !== k && setStatut(k)}, lbl))),
      h('p', {class: 'lbl'}, 'Note interne', ok), note,
      h('div', {class: 'foot'}, h('span', {}, 'Demande n° ' + r.id + (r.maj_le ? ' · modifiée le ' + date(r.maj_le).toLocaleDateString('fr-FR') : '')),
        h('button', {type: 'button', class: 'btn dng', onclick: () => { if (confirm('Supprimer définitivement la demande de ' + nomDe(r) + ' ?\nCette action est irréversible.')) post('supprimer', {id: r.id}).then(j => { if (j.ok) { all = all.filter(x => x.id !== r.id); courant = null; D.classList.remove('open'); D.replaceChildren(h('div', {class: 'placeholder'}, h('p', {}, 'Demande supprimée.'))); kpis(); seg(); liste(); toast('Demande supprimée'); } }); }}, ico('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'), 'Supprimer'))));
    D.classList.add('open'); D.scrollTop = 0;
  }

  function charger() {
    return fetch('?api=liste', {headers: {Accept: 'application/json'}, cache: 'no-store'}).then(r => { if (r.status === 401) { location.reload(); throw 0; } return r.json(); }).then(j => {
      all = j.demandes; SRC = j.sources; ST = j.statuts;
      const sel = $('#src'), v = sel.value;
      sel.replaceChildren(h('option', {value: ''}, 'Toutes les sources'), ...Object.entries(SRC).map(([k, l]) => h('option', {value: k}, l)));
      sel.value = v;
      kpis(); seg(); liste();
      if (courant && all.some(r => r.id === courant)) detail(courant);
      else if (courant) { courant = null; $('#det').classList.remove('open'); $('#det').replaceChildren(h('div', {class: 'placeholder'}, h('p', {}, 'Sélectionnez une demande pour la lire.'))); }
    });
  }
  $('#q').addEventListener('input', liste);
  $('#src').addEventListener('change', liste);
  $('#reload').addEventListener('click', () => charger().then(() => toast('À jour')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#det').classList.contains('open')) { $('#det').classList.remove('open'); courant = null; liste(); } });
  setInterval(() => { if (!document.hidden && document.activeElement?.tagName !== 'TEXTAREA') charger(); }, 60000);
  charger();
})();
</script>
<?php endif ?>
</body>
</html>
